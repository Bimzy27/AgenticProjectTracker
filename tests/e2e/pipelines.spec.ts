import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

const REPO_SLUG = 'e2e/pipeline-demo'
const FAKE_TOKEN = 'apt-e2e-fake-github-token'
const POLL_MS = 500

/** Shape of the GitHub Actions list-runs payload the app consumes. */
interface FakeRun {
  id: number
  name: string
  head_branch: string
  head_sha: string
  display_title: string
  status: string
  conclusion: string | null
  run_started_at: string
  updated_at: string
  html_url: string
}

function makeRun(
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  title: string
): FakeRun {
  return {
    id,
    name,
    head_branch: 'main',
    head_sha: `${id}abc0000000000000000000000000000000000000`.slice(0, 40),
    display_title: title,
    status,
    conclusion,
    run_started_at: '2026-07-15T08:00:00Z',
    updated_at: '2026-07-15T08:05:00Z',
    html_url: `https://github.com/${REPO_SLUG}/actions/runs/${id}`
  }
}

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string
let githubServer: Server
let githubApi: string
let notificationLog: string
/** Mutable fake GitHub state; each poll returns the current contents. */
let workflowRuns: FakeRun[] = []
/** Authenticated requests served, to prove the app actually polls the seam. */
let pollCount = 0

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function notifications(): Array<{ runId: number; workflowName: string; status: string }> {
  if (!existsSync(notificationLog)) return []
  return readFileSync(notificationLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function launchApp(): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_GITHUB_API: githubApi,
      APT_PIPELINE_POLL_MS: String(POLL_MS),
      APT_NOTIFICATION_LOG: notificationLog
    }
  })
  page = await app.firstWindow()
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-pipe-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-pipe-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-pipe-repo-'))
  notificationLog = join(userData, 'notifications.jsonl')

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  // Fake GitHub API behind the APT_GITHUB_API seam: serves the Actions
  // list-runs endpoint for the fixture repo from the mutable workflowRuns.
  githubServer = createServer((req, res) => {
    if (!req.headers.authorization?.includes(FAKE_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Bad credentials' }))
      return
    }
    if (req.url?.startsWith(`/repos/${REPO_SLUG}/actions/runs`)) {
      pollCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ total_count: workflowRuns.length, workflow_runs: workflowRuns }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  await new Promise<void>((resolve) => githubServer.listen(0, '127.0.0.1', resolve))
  githubApi = `http://127.0.0.1:${(githubServer.address() as AddressInfo).port}`

  workflowRuns = [
    makeRun(101, 'CI', 'completed', 'success', 'feat: initial pipeline'),
    makeRun(102, 'Deploy', 'in_progress', null, 'chore: ship it')
  ]
  await launchApp()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => githubServer?.close(() => resolve()))
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

test('set up a GitHub-linked project with a token', async () => {
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Pipeline Demo')
  // The fixture repo has no remote; link the fake-served repo manually.
  await page.getByPlaceholder('owner/repo (optional)').fill(REPO_SLUG)
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pipeline Demo' })).toBeVisible()

  await page.getByRole('button', { name: '⚙ Settings' }).click()
  await page.getByPlaceholder(/ghp_/).fill(FAKE_TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByText('Token saved to the OS credential vault.')).toBeVisible()
})

test('pipelines tab lists workflow runs from the GitHub API', async () => {
  await page.locator('.sidebar').getByRole('button', { name: 'Pipeline Demo' }).click()
  await page.getByRole('button', { name: 'Pipelines' }).click()

  const rows = page.locator('.runs-table tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: 'CI' }).locator('.badge')).toHaveText('passing')
  await expect(rows.filter({ hasText: 'Deploy' }).locator('.badge')).toHaveText('running')
  await expect(rows.filter({ hasText: 'Deploy' }).getByText('chore: ship it')).toBeVisible()
  await expect(
    rows.filter({ hasText: 'CI' }).getByRole('link', { name: 'View on GitHub ↗' })
  ).toHaveAttribute('href', `https://github.com/${REPO_SLUG}/actions/runs/101`)
})

test('a run failing after the baseline updates the tab and raises a notification', async () => {
  // Nothing needed attention at baseline, so nothing has been notified yet.
  expect(notifications()).toEqual([])

  workflowRuns = [
    makeRun(101, 'CI', 'completed', 'success', 'feat: initial pipeline'),
    makeRun(102, 'Deploy', 'completed', 'failure', 'chore: ship it')
  ]

  // The next poll picks up the transition: the tab re-renders the run as
  // failing and the in_progress -> failure transition notifies exactly once.
  const deploy = page.locator('.runs-table tbody tr').filter({ hasText: 'Deploy' })
  await expect(deploy.locator('.badge')).toHaveText('failing')
  await expect
    .poll(() => notifications(), { timeout: 10_000 })
    .toEqual([{ projectId: expect.any(String), runId: 102, workflowName: 'Deploy', status: 'failure' }])

  // Give the poller a few more cycles: the same failure must not notify again.
  const polled = pollCount
  await expect.poll(() => pollCount, { timeout: 10_000 }).toBeGreaterThan(polled + 2)
  expect(notifications()).toHaveLength(1)
})

test('failures already present at app launch stay silent, new ones still notify', async () => {
  // Relaunch with the failure from the previous test still failing: this is
  // the startup state that used to spam a notification per stale failure.
  await app.close()
  rmSync(notificationLog, { force: true })
  pollCount = 0
  await launchApp()

  // The Pipelines tab shows the stale failure once the baseline poll lands.
  await page.locator('.sidebar').getByRole('button', { name: 'Pipeline Demo' }).click()
  await page.getByRole('button', { name: 'Pipelines' }).click()
  const rows = page.locator('.runs-table tbody tr')
  await expect(rows.filter({ hasText: 'Deploy' }).locator('.badge')).toHaveText('failing')

  // Several polls after baseline: the pre-existing failure never notified.
  await expect.poll(() => pollCount, { timeout: 10_000 }).toBeGreaterThan(3)
  expect(notifications()).toEqual([])

  // A brand-new failure after baseline must still notify (proves the silence
  // above is the baseline rule, not a dead notification pipeline).
  workflowRuns = [makeRun(103, 'Nightly', 'completed', 'failure', 'fix: flaky night job'), ...workflowRuns]
  await expect(rows.filter({ hasText: 'Nightly' }).locator('.badge')).toHaveText('failing')
  await expect
    .poll(() => notifications(), { timeout: 10_000 })
    .toEqual([{ projectId: expect.any(String), runId: 103, workflowName: 'Nightly', status: 'failure' }])
})
