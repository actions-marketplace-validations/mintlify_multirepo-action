import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type GitAuth = { serverUrl: string; token?: string }

export function authEnv({ serverUrl, token }: GitAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (!token) return env
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${serverUrl.replace(/\/+$/, '')}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

export async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).trim()}`)
  }
}

export async function clone(repo: string, ref: string | undefined, path: string, dir: string, auth: GitAuth): Promise<string> {
  const env = authEnv(auth)
  const url = `${auth.serverUrl.replace(/\/+$/, '')}/${repo}.git`
  // init + fetch instead of clone so ref can be a branch, tag, or full commit SHA
  await mkdir(dir, { recursive: true })
  await git(['init', '-q'], dir, env)
  await git(['remote', 'add', 'origin', url], dir, env)
  if (path !== '.') await git(['sparse-checkout', 'set', '--cone', path], dir, env)
  await git(['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', ref ?? 'HEAD'], dir, env)
  await git(['checkout', '-q', 'FETCH_HEAD'], dir, env)
  return git(['rev-parse', 'HEAD'], dir, env)
}
