import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { parse } from 'yaml'

export type Source = {
  repo: string
  ref?: string
  path: string
  destination: string
  name?: string
  rewriteLinks: boolean
  exclude: string[]
}

export type Config = {
  base: string
  output: string
  sources: Source[]
}

const RESERVED = new Set(['snippets', '.git', '.github', 'node_modules'])

export const normalizeDir = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/|\/)+|\/+$/g, '') || '.'

export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') throw new Error('Config must be an object')
  const { base = 'docs.base.json', output = 'docs.json', sources } = raw as Record<string, unknown>
  if (typeof base !== 'string' || typeof output !== 'string') throw new Error('`base` and `output` must be strings')
  if (base === output) throw new Error('`base` and `output` must be different files')
  if (!Array.isArray(sources) || !sources.length) throw new Error('`sources` must be a non-empty list')

  const parsed = sources.map((s, i): Source => {
    const where = `sources[${i}]`
    if (!s || typeof s !== 'object') throw new Error(`${where} must be an object`)
    const { repo, ref, path = '.', destination, name, rewriteLinks = true, exclude = [] } = s as Record<string, unknown>
    if (typeof repo !== 'string' || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) throw new Error(`${where}.repo must look like owner/repo`)
    if (ref !== undefined && typeof ref !== 'string') throw new Error(`${where}.ref must be a string`)
    if (typeof path !== 'string') throw new Error(`${where}.path must be a string`)
    if (typeof destination !== 'string') throw new Error(`${where}.destination is required`)
    if (name !== undefined && typeof name !== 'string') throw new Error(`${where}.name must be a string`)
    if (typeof rewriteLinks !== 'boolean') throw new Error(`${where}.rewriteLinks must be a boolean`)
    if (!Array.isArray(exclude) || exclude.some((e) => typeof e !== 'string')) throw new Error(`${where}.exclude must be a list of globs`)
    const dest = normalizeDir(destination)
    const dir = normalizeDir(path)
    if (dest === '.' || dest.startsWith('..')) throw new Error(`${where}.destination must be a subdirectory`)
    if (dir.startsWith('..')) throw new Error(`${where}.path must stay inside the repository`)
    if (RESERVED.has(dest.split('/')[0]!)) throw new Error(`${where}.destination cannot start with ${dest.split('/')[0]}`)
    return { repo, ref, path: dir, destination: dest, name, rewriteLinks, exclude }
  })

  for (const a of parsed) {
    for (const b of parsed) {
      if (a === b) continue
      if (a.destination === b.destination || b.destination.startsWith(`${a.destination}/`)) {
        throw new Error(`Destinations overlap: ${a.destination} and ${b.destination}`)
      }
    }
  }

  return { base, output, sources: parsed }
}

export async function loadConfig(file: string): Promise<Config> {
  return parseConfig(parse(await readFile(file, 'utf8')))
}
