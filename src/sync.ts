import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, matchesGlob, resolve, sep } from 'node:path'
import type { Config, Source } from './config.js'
import { clone, type GitAuth } from './git.js'
import { assemble, type Child, type JsonObject } from './navigation.js'
import { rewriteLinks } from './rewrite.js'

export const MANIFEST = '.mintlify-multirepo.json'

export type Manifest = { destinations: string[]; sources: Record<string, { repo: string; ref?: string; sha: string }> }

export type SyncOptions = {
  config: Config
  root: string
  auth: GitAuth
  concurrency: number
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

const SKIP = new Set(['node_modules', 'docs.json', 'mint.json'])
const TEXT = /\.mdx?$/i

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function inside(root: string, path: string): string {
  const full = resolve(root, path)
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`Path escapes the repository: ${path}`)
  return full
}

type CopyOptions = { transform?: (text: string) => string; exclude: string[]; warn: (msg: string) => void }

async function copyTree(from: string, to: string, opts: CopyOptions, rel = '') {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (SKIP.has(entry.name) || entry.name.startsWith('.') || path === 'snippets') continue
    if (opts.exclude.some((g) => matchesGlob(path, g))) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isSymbolicLink()) opts.warn(`Skipping symlink ${src}`)
    else if (entry.isDirectory()) await copyTree(src, dst, opts, path)
    else if (opts.transform && TEXT.test(entry.name)) await writeFile(dst, opts.transform(await readFile(src, 'utf8')))
    else await cp(src, dst)
  }
}

async function readManifest(file: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

const AUTH_ERROR = /could not read Username|Authentication failed|Repository not found|returned error: 40[134]/i
const REF_ERROR = /couldn't find remote ref|not our ref/i

export function explainFetchError(source: Source, message: string): string {
  let hint = ''
  if (AUTH_ERROR.test(message)) {
    hint = ` Check that the \`token\` input can read ${source.repo}. The default github.token can only read the repository running the workflow, so private child repositories need a GitHub App token or a PAT.`
  } else if (REF_ERROR.test(message)) {
    hint = ` Check that ref "${source.ref}" exists in ${source.repo}. Commit SHAs must be the full 40 characters.`
  }
  return `${source.repo}: ${message}${hint}`
}

async function fetchSource(source: Source, work: string, opts: SyncOptions): Promise<{ child: Child; dir: string; sha: string }> {
  const dir = join(work, source.destination.replace(/\//g, '__'))
  const sha = await clone(source.repo, source.ref, source.path, dir, opts.auth).catch((e: Error) => {
    throw new Error(explainFetchError(source, e.message))
  })
  const docsDir = inside(dir, source.path)
  const docsFile = join(docsDir, 'docs.json')
  if (!(await exists(docsFile))) throw new Error(`${source.repo}: no docs.json in ${source.path}`)
  const docs = JSON.parse(await readFile(docsFile, 'utf8')) as JsonObject
  opts.log?.(`Fetched ${source.repo}@${sha.slice(0, 7)} -> ${source.destination}`)
  return { child: { source, docs }, dir: docsDir, sha }
}

export async function sync(opts: SyncOptions): Promise<Manifest> {
  const { config, concurrency } = opts
  const root = resolve(opts.root)
  const warn = opts.warn ?? (() => {})
  const base = JSON.parse(await readFile(inside(root, config.base), 'utf8')) as JsonObject
  const work = await mkdtemp(join(tmpdir(), 'mintlify-multirepo-'))

  try {
    const fetched = await pool(config.sources, concurrency, (s) => fetchSource(s, work, opts))
    const docs = assemble(base, fetched.map((f) => f.child))

    const manifestFile = join(root, MANIFEST)
    const previous = await readManifest(manifestFile)
    const destinations = config.sources.map((s) => s.destination)
    const stale = (previous?.destinations ?? []).filter((d) => !destinations.includes(d))
    for (const d of [...stale, ...destinations]) {
      await rm(inside(root, d), { recursive: true, force: true })
      await rm(inside(root, join('snippets', d)), { recursive: true, force: true })
    }

    await pool(fetched, concurrency, async ({ child: { source }, dir }) => {
      const transform = source.rewriteLinks ? (text: string) => rewriteLinks(text, source.destination, destinations) : undefined
      const copy = { transform, exclude: source.exclude, warn }
      await copyTree(dir, inside(root, source.destination), copy)
      const snippets = join(dir, 'snippets')
      if (await exists(snippets)) await copyTree(snippets, inside(root, join('snippets', source.destination)), copy, 'snippets')
    })

    await writeFile(inside(root, config.output), `${JSON.stringify(docs, null, 2)}\n`)

    const manifest: Manifest = {
      destinations,
      sources: Object.fromEntries(fetched.map((f) => [f.child.source.destination, { repo: f.child.source.repo, ref: f.child.source.ref, sha: f.sha }])),
    }
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
