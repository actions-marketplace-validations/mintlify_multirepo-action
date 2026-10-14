import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { pushWithRebase } from '../src/main.js'

const tmp = mkdtempSync(join(tmpdir(), 'aggregator-push-'))
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim()

function setup(name: string) {
  const remote = join(tmp, `${name}.git`)
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote)
  const ours = join(tmp, `${name}-ours`)
  const theirs = join(tmp, `${name}-theirs`)
  git(tmp, 'clone', '-q', remote, theirs)
  writeFileSync(join(theirs, 'docs.json'), '{}\n')
  git(theirs, 'add', '-A')
  git(theirs, 'commit', '-qm', 'init')
  git(theirs, 'push', '-q', 'origin', 'HEAD:main')
  git(tmp, 'clone', '-q', remote, ours)
  return { remote, ours, theirs }
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('pushWithRebase', () => {
  it('rebases onto a base branch that moved and pushes', async () => {
    const { remote, ours, theirs } = setup('moved')
    writeFileSync(join(theirs, 'other.mdx'), 'other')
    git(theirs, 'add', '-A')
    git(theirs, 'commit', '-qm', 'someone else')
    git(theirs, 'push', '-q', 'origin', 'HEAD:main')
    writeFileSync(join(ours, 'docs.json'), '{"synced":true}\n')
    git(ours, 'commit', '-qam', 'sync')

    const sha = await pushWithRebase(ours, 'main')
    expect(git(remote, 'rev-parse', 'main')).toBe(sha)
    expect(git(remote, 'log', '--format=%s', 'main')).toBe('sync\nsomeone else\ninit')
  })

  it('fails clearly when the base branch changed the same files', async () => {
    const { ours, theirs } = setup('conflict')
    writeFileSync(join(theirs, 'docs.json'), '{"theirs":true}\n')
    git(theirs, 'commit', '-qam', 'conflicting')
    git(theirs, 'push', '-q', 'origin', 'HEAD:main')
    writeFileSync(join(ours, 'docs.json'), '{"ours":true}\n')
    git(ours, 'commit', '-qam', 'sync')

    await expect(pushWithRebase(ours, 'main')).rejects.toThrow(/changed during the sync/)
    expect(git(ours, 'status', '--porcelain')).toBe('')
  })
})
