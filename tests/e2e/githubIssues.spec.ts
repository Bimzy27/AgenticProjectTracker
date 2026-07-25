import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

const REPO_SLUG = 'e2e/issues-demo'
const FAKE_TOKEN = 'apt-e2e-fake-github-issues-token'

/** Shape of the GitHub "list/get issue" payload the app consumes. */
interface FakeIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  user: { login: string } | null
  labels: Array<{ name: string }>
  updated_at: string
  pull_request?: { url: string }
}

const OPEN_ISSUES: FakeIssue[] = [
  {
    number: 7,
    title: 'Add dark mode toggle',
    body: 'Users have asked for a dark mode option in Settings.',
    html_url: `https://github.com/${REPO_SLUG}/issues/7`,
    user: { login: 'alice' },
    labels: [{ name: 'enhancement' }],
    updated_at: '2026-07-20T00:00:00Z'
  },
  {
    // GitHub's issues endpoint also lists pull requests; the app must filter them out.
    number: 8,
    title: 'Bump dependency versions',
    body: null,
    html_url: `https://github.com/${REPO_SLUG}/issues/8`,
    user: { login: 'bob' },
    labels: [],
    updated_at: '2026-07-19T00:00:00Z',
    pull_request: { url: 'https://api.github.com/repos/e2e/issues-demo/pulls/8' }
  }
]

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string
let githubServer: Server
let githubApi: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-issues-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-issues-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-issues-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  // Fake GitHub API behind the APT_GITHUB_API seam: serves the issues list
  // and single-issue endpoints for the fixture repo from OPEN_ISSUES.
  githubServer = createServer((req, res) => {
    if (!req.headers.authorization?.includes(FAKE_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Bad credentials' }))
      return
    }
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname === `/repos/${REPO_SLUG}/issues`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(OPEN_ISSUES))
      return
    }
    const singleMatch = new RegExp(`^/repos/${REPO_SLUG}/issues/(\\d+)$`).exec(pathname)
    if (singleMatch) {
      const issue = OPEN_ISSUES.find((i) => i.number === Number(singleMatch[1]))
      if (issue) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(issue))
        return
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  await new Promise<void>((resolve) => githubServer.listen(0, '127.0.0.1', resolve))
  githubApi = `http://127.0.0.1:${(githubServer.address() as AddressInfo).port}`

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_GITHUB_API: githubApi
    }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => githubServer?.close(() => resolve()))
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

test('set up a GitHub-linked project with a token', async () => {
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Issues Demo')
  // The fixture repo has no remote; link the fake-served repo manually.
  await page.getByPlaceholder('owner/repo (optional)').fill(REPO_SLUG)
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Issues Demo' })).toBeVisible()

  await page.getByRole('button', { name: '⚙ Settings' }).click()
  const githubSection = page.locator('.settings-section').filter({ hasText: 'GitHub access' })
  await githubSection.getByPlaceholder(/ghp_/).fill(FAKE_TOKEN)
  await githubSection.getByRole('button', { name: 'Save token' }).click()
  await expect(githubSection.getByText('Token saved to the OS credential vault.')).toBeVisible()
})

test('the Tasks tab lists open GitHub issues, excluding pull requests', async () => {
  await page.locator('.sidebar').getByRole('button', { name: 'Issues Demo' }).click()
  await page.locator('.github-issues-panel summary').click()

  const rows = page.locator('.github-issue-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.getByText('#7 Add dark mode toggle')).toBeVisible()
  await expect(page.locator('.github-issues-panel summary')).toHaveText('GitHub Issues (1)')
})

test('importing an issue creates a draft task linked back to it, and re-importing is a no-op', async () => {
  const issueRow = page.locator('.github-issue-row').filter({ hasText: 'Add dark mode toggle' })
  await issueRow.getByRole('button', { name: '+ Add to backlog' }).click()
  await expect(issueRow.getByRole('button', { name: 'In backlog' })).toBeVisible()
  await expect(issueRow.getByRole('button', { name: 'In backlog' })).toBeDisabled()

  const taskRow = page.locator('.task-row').filter({ hasText: 'Add dark mode toggle' })
  await expect(taskRow).toBeVisible()
  await expect(taskRow.locator('.badge.task-draft')).toBeVisible()
  await taskRow.locator('.task-row-main').click()

  await expect(page.locator('.task-detail-inner h2')).toHaveText('Add dark mode toggle')
  await expect(page.locator('.task-purpose')).toContainText('Users have asked for a dark mode option')
  await expect(page.locator('.task-purpose')).toContainText(`Imported from GitHub issue #7`)
  const issueLink = page.locator('.task-detail-header').getByRole('link', { name: /GitHub issue/ })
  await expect(issueLink).toHaveAttribute('href', `https://github.com/${REPO_SLUG}/issues/7`)

  // Refreshing the issues list must not offer a second import of the same issue.
  await page.locator('.github-issues-body .refresh').click()
  await expect(issueRow.getByRole('button', { name: 'In backlog' })).toBeVisible()
})
