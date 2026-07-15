import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'

const REPO_SLUG = 'e2e/analytics-demo'
const FAKE_TOKEN = 'apt-e2e-fake-github-token'
const DAYS = 14
const OUTAGE_MESSAGE = 'analytics fixture outage'

/** GitHub list-releases payload: one full release and one bare draft-like one. */
const RELEASES = [
  {
    tag_name: 'v1.2.0',
    name: 'Summer Update',
    published_at: '2026-07-10T00:00:00Z',
    body: 'Highlights:\n- fake releases served end to end',
    html_url: `https://github.com/${REPO_SLUG}/releases/tag/v1.2.0`,
    assets: [
      { name: 'analytics-demo-setup-1.2.0.exe', download_count: 320, size: 52_428_800 },
      { name: 'analytics-demo-1.2.0.zip', download_count: 13, size: 1536 }
    ]
  },
  {
    tag_name: 'v1.1.0',
    name: null,
    published_at: null,
    body: null,
    html_url: `https://github.com/${REPO_SLUG}/releases/tag/v1.1.0`,
    assets: []
  }
]

/** Deterministic 14-day traffic series; day index 2 is the assertion target. */
function trafficPoints(
  kind: 'views' | 'clones'
): Array<{ timestamp: string; count: number; uniques: number }> {
  return Array.from({ length: DAYS }, (_, i) => ({
    timestamp: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    count: kind === 'views' ? (i === 2 ? 42 : 5 + i) : i === 2 ? 17 : 2 + i,
    uniques: kind === 'views' ? (i === 2 ? 7 : 2) : i === 2 ? 3 : 1
  }))
}

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string
let githubServer: Server
let githubApi: string
/** When true the fake server answers analytics endpoints with a 500. */
let analyticsOutage = false

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-analytics-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-analytics-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-analytics-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  // Fake GitHub API behind the APT_GITHUB_API seam: traffic, releases, and an
  // empty Actions feed so the pipeline poller stays quiet.
  githubServer = createServer((req, res) => {
    if (!req.headers.authorization?.includes(FAKE_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Bad credentials' }))
      return
    }
    const respond = (body: unknown): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const isAnalyticsEndpoint =
      req.url?.startsWith(`/repos/${REPO_SLUG}/traffic/`) ||
      req.url?.startsWith(`/repos/${REPO_SLUG}/releases`)
    if (analyticsOutage && isAnalyticsEndpoint) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: OUTAGE_MESSAGE }))
      return
    }
    if (req.url?.startsWith(`/repos/${REPO_SLUG}/traffic/views`)) {
      respond({ count: 0, uniques: 0, views: trafficPoints('views') })
      return
    }
    if (req.url?.startsWith(`/repos/${REPO_SLUG}/traffic/clones`)) {
      respond({ count: 0, uniques: 0, clones: trafficPoints('clones') })
      return
    }
    if (req.url?.startsWith(`/repos/${REPO_SLUG}/releases`)) {
      respond(RELEASES)
      return
    }
    if (req.url?.startsWith(`/repos/${REPO_SLUG}/actions/runs`)) {
      respond({ total_count: 0, workflow_runs: [] })
      return
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

  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Analytics Demo')
  await page.getByPlaceholder('owner/repo (optional)').fill(REPO_SLUG)
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Analytics Demo' })).toBeVisible()

  await page.getByRole('button', { name: '⚙ Settings' }).click()
  await page.getByPlaceholder(/ghp_/).fill(FAKE_TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByText('Token saved to the OS credential vault.')).toBeVisible()

  await page.locator('.sidebar').getByRole('button', { name: 'Analytics Demo' }).click()
  await page.getByRole('button', { name: 'Analytics', exact: true }).click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => githubServer?.close(() => resolve()))
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

function chart(title: string): Locator {
  return page.locator('.traffic-chart').filter({ has: page.getByRole('heading', { name: title }) })
}

test('traffic charts render a bar per day', async () => {
  await expect(chart('Views').locator('.bar')).toHaveCount(DAYS)
  await expect(chart('Clones').locator('.bar')).toHaveCount(DAYS)
  // Sum of trafficPoints('views'): 5+i for 14 days (=161), with day 2 replaced by 42.
  await expect(chart('Views').getByText(/total/)).toContainText('196 total')
})

test("hovering a bar shows that day's detailed tooltip", async () => {
  const views = chart('Views')

  // Before hovering, no bar tooltip is visible.
  await expect(views.locator('.bar-tip:visible')).toHaveCount(0)

  // Hover the third bar (2026-07-03: 42 views, 7 unique). The slot is the
  // hit target: it spans the full column so even short bars are easy to hit.
  await views.locator('.bar-slot').nth(2).hover()
  const tip = views.locator('.bar-tip').nth(2)
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('42 views')
  await expect(tip).toContainText('7 unique')
  await expect(tip).toContainText('Jul 3')

  // Bars in the right third open their tooltip to the left, still fully visible.
  await views.locator('.bar-slot').nth(13).hover()
  await expect(views.locator('.bar-tip').nth(13)).toBeVisible()
  await expect(views.locator('.bar-tip').nth(13)).toContainText('18 views')

  // Moving the pointer away hides the details again.
  await page.getByRole('heading', { name: 'Traffic (last 14 days)' }).hover()
  await expect(views.locator('.bar-tip:visible')).toHaveCount(0)

  // The clones chart carries its own per-day details.
  await chart('Clones').locator('.bar-slot').nth(2).hover()
  const clonesTip = chart('Clones').locator('.bar-tip').nth(2)
  await expect(clonesTip).toBeVisible()
  await expect(clonesTip).toContainText('17 clones')
  await expect(clonesTip).toContainText('3 unique')
})

test('keyboard focus reveals the same tooltip as hover', async () => {
  const views = chart('Views')
  // Tab from the chart's InfoTip lands on the first bar; keyboard focus must
  // surface the same details a mouse hover does.
  await views.locator('.info-tip').focus()
  await page.keyboard.press('Tab')
  const tip = views.locator('.bar-tip').nth(0)
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('5 views')
  await expect(tip).toContainText('2 unique')
})

test('releases section renders the releases served by the API', async () => {
  const cards = page.locator('.release-card')
  await expect(cards).toHaveCount(RELEASES.length)

  // Newest release: named link to GitHub, tag badge, summed downloads,
  // per-asset rows with formatted sizes, and the release notes.
  const summer = cards.nth(0)
  await expect(summer.getByRole('link', { name: 'Summer Update' })).toHaveAttribute(
    'href',
    RELEASES[0].html_url
  )
  await expect(summer.locator('.badge')).toHaveText('v1.2.0')
  await expect(summer).toContainText('333 downloads')
  const assetRows = summer.locator('.assets-table tr')
  await expect(assetRows).toHaveCount(2)
  await expect(assetRows.nth(0)).toContainText('analytics-demo-setup-1.2.0.exe')
  await expect(assetRows.nth(0)).toContainText('50.0 MB')
  await expect(assetRows.nth(0)).toContainText('320 downloads')
  await expect(assetRows.nth(1)).toContainText('analytics-demo-1.2.0.zip')
  await expect(assetRows.nth(1)).toContainText('1.5 KB')
  await expect(summer.locator('.release-notes')).toContainText('fake releases served end to end')

  // Unnamed, unpublished release: falls back to the tag, no asset table.
  const untitled = cards.nth(1)
  await expect(untitled.getByRole('link', { name: 'v1.1.0' })).toHaveAttribute('href', RELEASES[1].html_url)
  await expect(untitled).toContainText('unpublished · 0 downloads')
  await expect(untitled.locator('.assets-table')).toHaveCount(0)
})

/** Remounts the Analytics tab so it refetches against the fake server. */
async function reopenAnalyticsTab(): Promise<void> {
  const tabBar = page.locator('.tab-bar')
  await tabBar.getByRole('button', { name: 'Tasks' }).click()
  await tabBar.getByRole('button', { name: 'Analytics', exact: true }).click()
}

test('an API failure shows the error state; recovery renders data again', async () => {
  analyticsOutage = true
  await reopenAnalyticsTab()
  const errorText = page.locator('.error-text')
  // Octokit retries 5xx responses 3 times with quadratic backoff (~14s
  // total) before the error surfaces, so allow well beyond that.
  await expect(errorText).toBeVisible({ timeout: 30_000 })
  await expect(errorText).toContainText(OUTAGE_MESSAGE)
  // The broken tab shows only the error, not stale charts or release cards.
  await expect(page.locator('.traffic-chart')).toHaveCount(0)
  await expect(page.locator('.release-card')).toHaveCount(0)

  // Once the API recovers, reopening the tab renders data with no residue.
  analyticsOutage = false
  await reopenAnalyticsTab()
  await expect(page.locator('.release-card')).toHaveCount(RELEASES.length)
  await expect(chart('Views').locator('.bar')).toHaveCount(DAYS)
  await expect(errorText).toHaveCount(0)
})
