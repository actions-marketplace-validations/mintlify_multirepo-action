import * as core from '@actions/core'
import * as github from '@actions/github'
import { resolve } from 'node:path'
import { loadConfig } from './config.js'
import { git } from './git.js'
import { sync, type Manifest } from './sync.js'

type Mode = 'pull-request' | 'push' | 'none'

const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com']

function summary(manifest: Manifest): string {
  return Object.entries(manifest.sources)
    .map(([dest, s]) => `- \`${s.repo}\`${s.ref ? `@${s.ref}` : ''} (${s.sha.slice(0, 7)}) → \`${dest}/\``)
    .join('\n')
}

async function openPullRequest(token: string, branch: string, baseBranch: string, title: string, body: string) {
  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const { data: open } = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, base: baseBranch, state: 'open' })
  if (open[0]) {
    const { data } = await octokit.rest.pulls.update({ owner, repo, pull_number: open[0].number, body })
    return data
  }
  const { data } = await octokit.rest.pulls.create({ owner, repo, head: branch, base: baseBranch, title, body })
  return data
}

// If the base branch moved while syncing, replay the sync commit on top of it and retry
export async function pushWithRebase(root: string, branch: string, attempts = 3): Promise<string> {
  for (let i = 1; ; i++) {
    try {
      await git(['push', 'origin', `HEAD:refs/heads/${branch}`], root)
      return git(['rev-parse', 'HEAD'], root)
    } catch (e) {
      if (i >= attempts) throw e
      core.info(`Push to ${branch} was rejected, rebasing and retrying (${i}/${attempts - 1})`)
      await git(['fetch', '-q', 'origin', branch], root)
      try {
        await git([...BOT, 'rebase', '-q', 'FETCH_HEAD'], root)
      } catch {
        await git(['rebase', '--abort'], root).catch(() => {})
        throw new Error(`${branch} changed during the sync and the changes conflict with it. Re-run the workflow.`)
      }
    }
  }
}

export async function run(): Promise<void> {
  try {
    const root = resolve(core.getInput('working-directory') || '.')
    const mode = (core.getInput('mode') || 'pull-request') as Mode
    if (!['pull-request', 'push', 'none'].includes(mode)) throw new Error(`Invalid mode: ${mode}`)
    const token = core.getInput('token')
    const githubToken = core.getInput('github-token') || token
    const concurrency = Math.max(1, Number.parseInt(core.getInput('concurrency') || '8', 10) || 8)
    const branch = core.getInput('branch') || 'mintlify-multirepo/sync'
    const message = core.getInput('commit-message') || 'docs: sync from child repositories'
    const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
    if (token) core.setSecret(token)

    const config = await loadConfig(resolve(root, core.getInput('config') || '.github/mintlify-multirepo.yml'))
    core.info(`Syncing ${config.sources.length} sources with concurrency ${concurrency}`)

    const manifest = await sync({ config, root, auth: { serverUrl, token }, concurrency, log: core.info, warn: core.warning })
    const body = `Synced docs from ${config.sources.length} repositories:\n\n${summary(manifest)}`
    await core.summary.addHeading('Mintlify multirepo').addRaw(body).write()

    await git(['add', '-A', '--', '.'], root)
    const changed = (await git(['status', '--porcelain', '--', '.'], root)).length > 0
    core.setOutput('changed', String(changed))
    if (!changed) return core.info('No changes')
    if (mode === 'none') return core.info('Changes written, mode is none so nothing was committed')

    const baseBranch =
      core.getInput('base-branch') || process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root))
    await git([...BOT, 'commit', '-q', '-m', message, '-m', summary(manifest)], root)
    const sha = await git(['rev-parse', 'HEAD'], root)
    core.setOutput('commit-sha', sha)

    if (mode === 'push') {
      const pushed = await pushWithRebase(root, baseBranch)
      core.setOutput('commit-sha', pushed)
      return core.info(`Pushed ${pushed.slice(0, 7)} to ${baseBranch}`)
    }

    await git(['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], root)
    const pr = await openPullRequest(githubToken, branch, baseBranch, message, body)
    core.setOutput('pull-request-number', String(pr.number))
    core.setOutput('pull-request-url', pr.html_url)
    core.info(`Pull request: ${pr.html_url}`)
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : String(e))
  }
}
