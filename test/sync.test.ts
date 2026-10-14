import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { sync } from '../src/sync.js'

const tmp = mkdtempSync(join(tmpdir(), 'aggregator-test-'))
const server = join(tmp, 'server')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })

function repo(name: string, files: Record<string, string>) {
  const dir = join(tmp, 'src', name)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  mkdirSync(join(server, dirname(name)), { recursive: true })
  git(tmp, 'clone', '-q', '--bare', dir, join(server, `${name}.git`))
  return dir
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('sync', () => {
  repo('acme/api', {
    'docs/docs.json': JSON.stringify({ name: 'API', navigation: { groups: [{ group: 'Reference', pages: ['intro'] }] } }),
    'docs/intro.mdx': "import Hi from '/snippets/hi.mdx'\n\n[Start](/intro) [SDK](/sdks/js)\n",
    'docs/snippets/hi.mdx': 'Hi',
    'docs/images/a.png': 'png',
    'docs/README.md': 'readme',
    'docs/drafts/wip.mdx': 'wip',
    'docs/.github/workflows/ci.yml': 'ci',
    'src/index.ts': 'export {}',
  })
  repo('acme/sdk', {
    'docs.json': JSON.stringify({ name: 'SDKs', navigation: { groups: [{ group: 'JS', pages: ['js'] }] } }),
    'js.mdx': '# JS',
  })

  const root = join(tmp, 'parent')
  mkdirSync(root)
  writeFileSync(join(root, 'docs.base.json'), JSON.stringify({ name: 'Acme', navigation: { tabs: [{ tab: 'API', pages: [{ sourceRef: 'acme/api' }] }] } }))
  const config = parseConfig({
    sources: [
      { repo: 'acme/api', path: 'docs', destination: 'api', exclude: ['README.md', 'drafts/**'] },
      { repo: 'acme/sdk', ref: 'main', destination: 'sdks' },
    ],
  })
  const auth = { serverUrl: `file://${server}` }

  it('copies content, rewrites links, and writes docs.json', async () => {
    const manifest = await sync({ config, root, auth, concurrency: 2 })
    expect(Object.keys(manifest.sources)).toEqual(['api', 'sdks'])
    expect(readFileSync(join(root, 'api/intro.mdx'), 'utf8')).toBe("import Hi from '/snippets/api/hi.mdx'\n\n[Start](/api/intro) [SDK](/sdks/js)\n")
    expect(readFileSync(join(root, 'snippets/api/hi.mdx'), 'utf8')).toBe('Hi')
    expect(existsSync(join(root, 'api/images/a.png'))).toBe(true)
    expect(existsSync(join(root, 'api/docs.json'))).toBe(false)
    expect(existsSync(join(root, 'api/snippets'))).toBe(false)
    expect(existsSync(join(root, 'api/src'))).toBe(false)
    expect(existsSync(join(root, 'api/.github'))).toBe(false)
    expect(existsSync(join(root, 'api/README.md'))).toBe(false)
    expect(existsSync(join(root, 'api/drafts/wip.mdx'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'docs.json'), 'utf8')).navigation).toEqual({
      tabs: [
        { tab: 'API', pages: [{ group: 'Reference', pages: ['api/intro'] }] },
        { tab: 'SDKs', groups: [{ group: 'JS', pages: ['sdks/js'] }] },
      ],
    })
  })

  it('removes destinations that are no longer configured', async () => {
    const trimmed = { ...config, sources: config.sources.slice(0, 1) }
    writeFileSync(join(root, 'docs.base.json'), JSON.stringify({ navigation: { pages: [{ sourceRef: 'acme/api' }] } }))
    await sync({ config: trimmed, root, auth, concurrency: 2 })
    expect(existsSync(join(root, 'sdks'))).toBe(false)
    expect(existsSync(join(root, 'api/intro.mdx'))).toBe(true)
  })

  it('skips symlinks', async () => {
    const dir = repo('acme/evil', { 'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }), 'a.mdx': 'a' })
    symlinkSync('/etc/passwd', join(dir, 'leak.mdx'))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'link')
    git(dir, 'push', '-q', join(server, 'acme/evil.git'), 'main')
    const warnings: string[] = []
    const evil = parseConfig({ sources: [{ repo: 'acme/evil', destination: 'evil' }] })
    writeFileSync(join(root, 'docs.base.json'), JSON.stringify({ navigation: { pages: [{ sourceRef: 'acme/evil' }] } }))
    await sync({ config: evil, root, auth, concurrency: 1, warn: (w) => warnings.push(w) })
    expect(existsSync(join(root, 'evil/leak.mdx'))).toBe(false)
    expect(warnings).toHaveLength(1)
  })

  it('fails without touching the tree when a source is missing', async () => {
    const before = readFileSync(join(root, 'docs.json'), 'utf8')
    const missing = parseConfig({ sources: [{ repo: 'acme/nope', destination: 'nope' }] })
    await expect(sync({ config: missing, root, auth, concurrency: 1 })).rejects.toThrow(/git fetch failed/)
    expect(readFileSync(join(root, 'docs.json'), 'utf8')).toBe(before)
  })

  it('pins a source to a commit SHA', async () => {
    const dir = join(tmp, 'src', 'acme/sdk')
    const pinned = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
    writeFileSync(join(dir, 'js.mdx'), '# JS v2')
    git(dir, 'commit', '-qam', 'v2')
    git(dir, 'push', '-q', join(server, 'acme/sdk.git'), 'main')
    const shaConfig = parseConfig({ sources: [{ repo: 'acme/sdk', ref: pinned, destination: 'sdks' }] })
    writeFileSync(join(root, 'docs.base.json'), JSON.stringify({ navigation: { tabs: [] } }))
    const manifest = await sync({ config: shaConfig, root, auth, concurrency: 1 })
    expect(manifest.sources.sdks!.sha).toBe(pinned)
    expect(readFileSync(join(root, 'sdks/js.mdx'), 'utf8')).toBe('# JS')
  })
})
