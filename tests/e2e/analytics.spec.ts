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
const METRIC_TOKEN = 'apt-e2e-fake-metric-token'
const VERCEL_TOKEN = 'apt-e2e-fake-vercel-token'
const VERCEL_PROJECT = 'prj_e2e_demo'
const DAYS = 14
const METRIC_DAYS = 7
const VERCEL_DAYS = 5
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
let metricServer: Server
let metricApi: string
let vercelServer: Server
let vercelApi: string
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

  // Fake third-party metrics API (Vercel-style) for the JSON metric widget.
  // It demands its own bearer token, proving the encrypted-secret flow end to
  // end: the token only renders data if it survived vault storage and decrypt.
  metricServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${METRIC_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'missing metric token' }))
      return
    }
    if (req.url?.startsWith('/domain-views')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          data: {
            visitors: Array.from({ length: METRIC_DAYS }, (_, i) => ({
              date: `2026-07-${String(10 + i).padStart(2, '0')}`,
              value: 100 + i
            }))
          }
        })
      )
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  await new Promise<void>((resolve) => metricServer.listen(0, '127.0.0.1', resolve))
  metricApi = `http://127.0.0.1:${(metricServer.address() as AddressInfo).port}`

  // Fake Vercel API behind the APT_VERCEL_API seam. It enforces the real
  // contract the provider must speak: bearer auth, the documented aggregate
  // route, and the projectId/by parameters; anything else is rejected.
  vercelServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${VERCEL_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid token' } }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const isAggregateQuery =
      url.pathname === '/v1/query/web-analytics/visits/aggregate' &&
      url.searchParams.get('projectId') === VERCEL_PROJECT &&
      url.searchParams.get('by') === 'day'
    if (!isAggregateQuery) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid query' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        version: 1,
        query: { since: url.searchParams.get('since'), until: url.searchParams.get('until') },
        data: Array.from({ length: VERCEL_DAYS }, (_, i) => ({
          timestamp: `2026-07-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
          pageviews: 100 + i,
          visitors: 80 + i
        }))
      })
    )
  })
  await new Promise<void>((resolve) => vercelServer.listen(0, '127.0.0.1', resolve))
  vercelApi = `http://127.0.0.1:${(vercelServer.address() as AddressInfo).port}`

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_GITHUB_API: githubApi,
      APT_VERCEL_API: vercelApi,
      // Hover assertions must not race the physical cursor; see createWindow.
      APT_TEST_IGNORE_OS_MOUSE: '1'
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
  await new Promise<void>((resolve) => metricServer?.close(() => resolve()))
  await new Promise<void>((resolve) => vercelServer?.close(() => resolve()))
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

function widget(title: string): Locator {
  return page.locator('.widget-card').filter({ has: page.getByRole('heading', { name: title }) })
}

/** Remounts the Analytics tab so it refetches against the fake servers. */
async function reopenAnalyticsTab(): Promise<void> {
  const tabBar = page.locator('.tab-bar')
  await tabBar.getByRole('button', { name: 'Tasks' }).click()
  await tabBar.getByRole('button', { name: 'Analytics', exact: true }).click()
}

test('the default dashboard renders the GitHub traffic and releases widgets', async () => {
  await expect(page.locator('.widget-card')).toHaveCount(3)
  await expect(widget('GitHub views').locator('.bar')).toHaveCount(DAYS)
  await expect(widget('GitHub clones').locator('.bar')).toHaveCount(DAYS)
  // Sum of trafficPoints('views'): 5+i for 14 days (=161), with day 2 replaced by 42.
  await expect(widget('GitHub views').getByText(/total/)).toContainText('196 views total')
})

test("hovering a bar shows that day's detailed tooltip", async () => {
  const views = widget('GitHub views')

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
  await page.getByText('Your dashboard for this project').hover()
  await expect(views.locator('.bar-tip:visible')).toHaveCount(0)

  // The clones chart carries its own per-day details.
  await widget('GitHub clones').locator('.bar-slot').nth(2).hover()
  const clonesTip = widget('GitHub clones').locator('.bar-tip').nth(2)
  await expect(clonesTip).toBeVisible()
  await expect(clonesTip).toContainText('17 clones')
  await expect(clonesTip).toContainText('3 unique')
})

test('keyboard focus reveals the same tooltip as hover', async () => {
  const views = widget('GitHub views')
  // Tab from the widget's last header action lands on the first bar; keyboard
  // focus must surface the same details a mouse hover does.
  await views.getByRole('button', { name: 'Remove GitHub views widget' }).focus()
  await page.keyboard.press('Tab')
  const tip = views.locator('.bar-tip').nth(0)
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('5 views')
  await expect(tip).toContainText('2 unique')
})

test('releases widget renders the releases served by the API', async () => {
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

test('release tab commit shas link to the commit on GitHub', async () => {
  // This project is linked to a GitHub repo, so the release preview's commit
  // shas must link to the commit pages for inspecting exactly what changed.
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  await page.locator('.tab-bar').getByRole('button', { name: 'Release', exact: true }).click()
  const link = page.locator('.release-commits').getByRole('link', { name: sha.slice(0, 7) })
  await expect(link).toHaveAttribute('href', `https://github.com/${REPO_SLUG}/commit/${sha}`)
  await page.locator('.tab-bar').getByRole('button', { name: 'Analytics', exact: true }).click()
})

test('a source failure shows its error on the widget card; recovery renders data again', async () => {
  analyticsOutage = true
  await reopenAnalyticsTab()
  // Each GitHub-backed widget fails independently and shows its own error, so
  // one broken source never blanks the whole dashboard.
  // Octokit retries 5xx responses 3 times with quadratic backoff (~14s
  // total) before the error surfaces, so allow well beyond that.
  await expect(page.locator('.widget-card .error-text')).toHaveCount(3, { timeout: 30_000 })
  await expect(widget('GitHub views').locator('.error-text')).toContainText(OUTAGE_MESSAGE)
  // The broken widgets show only their error, not stale charts or releases.
  await expect(page.locator('.bar')).toHaveCount(0)
  await expect(page.locator('.release-card')).toHaveCount(0)

  // Once the API recovers, reopening the tab renders data with no residue.
  analyticsOutage = false
  await reopenAnalyticsTab()
  await expect(page.locator('.release-card')).toHaveCount(RELEASES.length)
  await expect(widget('GitHub views').locator('.bar')).toHaveCount(DAYS)
  await expect(page.locator('.error-text')).toHaveCount(0)
})

test('a JSON metric widget with an encrypted bearer token renders third-party data', async () => {
  await page.getByRole('button', { name: '+ Add widget' }).click()
  await page.getByLabel('Widget source').selectOption('json-metric')
  await page.getByLabel('Widget title').fill('Domain views')
  await page.getByLabel('Endpoint URL').fill(`${metricApi}/domain-views`)
  await page.getByLabel('Value path').fill('data.visitors')
  await page.getByLabel('Unit').fill('views')
  await page.getByLabel('Bearer token').fill(METRIC_TOKEN)
  await page.getByRole('button', { name: 'Add widget', exact: true }).click()

  // The fake metrics API rejects requests without the bearer token, so bars
  // prove the secret survived vault encryption and came back for the fetch.
  const domainViews = widget('Domain views')
  await expect(domainViews.locator('.bar')).toHaveCount(METRIC_DAYS)
  await expect(domainViews.getByText(/total/)).toContainText('721 views total')
  await domainViews.locator('.bar-slot').nth(0).hover()
  await expect(domainViews.locator('.bar-tip').nth(0)).toContainText('100 views')
})

test('editing a widget keeps its stored secret and updates the title', async () => {
  await widget('Domain views').getByRole('button', { name: 'Edit Domain views widget' }).click()
  // The secret shows as saved without exposing its value.
  await expect(page.getByLabel('Bearer token')).toHaveAttribute('placeholder', 'saved - leave blank to keep')
  await expect(page.getByLabel('Bearer token')).toHaveValue('')
  await page.getByLabel('Widget title').fill('Vercel domain views')
  await page.getByRole('button', { name: 'Save widget', exact: true }).click()

  // Untouched secret still authenticates the refetch after the edit.
  await expect(widget('Vercel domain views').locator('.bar')).toHaveCount(METRIC_DAYS)
})

test('widgets can be reordered and removed, and the layout survives a remount', async () => {
  const headings = page.locator('.widget-card h2')
  await expect(headings).toHaveCount(4)
  await expect(headings.nth(3)).toContainText('Vercel domain views')

  await widget('Vercel domain views')
    .getByRole('button', { name: 'Move Vercel domain views widget up' })
    .click()
  await expect(headings.nth(2)).toContainText('Vercel domain views')

  await widget('GitHub clones').getByRole('button', { name: 'Remove GitHub clones widget' }).click()
  await expect(page.locator('.widget-card')).toHaveCount(3)
  await expect(widget('GitHub clones')).toHaveCount(0)

  // The customized layout is persisted, not view state: it survives a remount.
  await reopenAnalyticsTab()
  await expect(page.locator('.widget-card')).toHaveCount(3)
  await expect(widget('GitHub clones')).toHaveCount(0)
  // Remaining order: GitHub views, Vercel domain views, GitHub releases.
  await expect(headings.nth(1)).toContainText('Vercel domain views')
  await expect(widget('Vercel domain views').locator('.bar')).toHaveCount(METRIC_DAYS)
})

test('the Vercel analytics widget needs only a project and a token and charts page views', async () => {
  await page.getByRole('button', { name: '+ Add widget' }).click()
  await page.getByLabel('Widget source').selectOption('vercel-analytics')

  // First-class source: besides the optional title, the form asks only for
  // the project and the access token - no URL, path, or field mapping.
  await expect(page.locator('.modal .form-row input')).toHaveCount(3)
  await expect(page.getByLabel('Vercel access token')).toHaveAttribute('type', 'password')

  await page.getByLabel('Vercel project').fill(VERCEL_PROJECT)
  await page.getByLabel('Vercel access token').fill(VERCEL_TOKEN)
  await page.getByRole('button', { name: 'Add widget', exact: true }).click()

  // The fake Vercel API rejects requests without the bearer token and the
  // documented aggregate query, so rendered bars prove the provider speaks
  // the real contract and the secret survived vault encryption.
  const card = widget('Vercel analytics')
  await expect(card.locator('.bar')).toHaveCount(VERCEL_DAYS)
  await expect(card.getByText(/total/)).toContainText('510 views total')
  await card.locator('.bar-slot').nth(0).hover()
  await expect(card.locator('.bar-tip').nth(0)).toContainText('100 views')
  await expect(card.locator('.bar-tip').nth(0)).toContainText('80 unique')
})
