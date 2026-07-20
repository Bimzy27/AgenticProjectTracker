import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'

/**
 * Captures light/dark screenshots of the main views for visual review.
 * Runs only when APT_SCREENSHOT_DIR is set, so the normal E2E run skips it.
 */
const outDir = process.env.APT_SCREENSHOT_DIR

const REPO_SLUG = 'branden/greeting-service'
const FAKE_TOKEN = 'apt-shot-fake-github-token'

/** Deterministic 14-day traffic series with enough variation to look real. */
function trafficPoints(
  kind: 'views' | 'clones'
): Array<{ timestamp: string; count: number; uniques: number }> {
  const counts =
    kind === 'views'
      ? [12, 18, 42, 25, 31, 22, 38, 27, 45, 33, 29, 51, 40, 36]
      : [3, 5, 17, 8, 6, 9, 12, 7, 10, 14, 8, 11, 16, 9]
  return counts.map((count, i) => ({
    timestamp: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    count,
    uniques: Math.max(1, Math.round(count / 4))
  }))
}

/** GitHub list-releases payload: a full release and a bare early one. */
const RELEASES = [
  {
    tag_name: 'v1.2.0',
    name: 'Friendlier greetings',
    published_at: '2026-07-12T00:00:00Z',
    body: 'Highlights:\n- greet() now capitalizes names\n- punctuation polish across the board',
    html_url: `https://github.com/${REPO_SLUG}/releases/tag/v1.2.0`,
    assets: [
      { name: 'greeting-service-setup-1.2.0.exe', download_count: 412, size: 52_428_800 },
      { name: 'greeting-service-1.2.0.zip', download_count: 25, size: 204_800 }
    ]
  },
  {
    tag_name: 'v1.1.0',
    name: 'First public cut',
    published_at: '2026-06-28T00:00:00Z',
    body: null,
    html_url: `https://github.com/${REPO_SLUG}/releases/tag/v1.1.0`,
    assets: [{ name: 'greeting-service-setup-1.1.0.exe', download_count: 137, size: 51_380_224 }]
  }
]

/** GET /repos/{owner}/{repo} counters that feed the stat-tile widget. */
const REPO_STATS = {
  stargazers_count: 1284,
  forks_count: 87,
  open_issues_count: 9,
  subscribers_count: 42
}

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string
let githubServer: Server

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.skip(!outDir, 'set APT_SCREENSHOT_DIR to capture screenshots')

test.beforeAll(async () => {
  mkdirSync(outDir!, { recursive: true })
  userData = mkdtempSync(join(tmpdir(), 'apt-shot-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-shot-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-shot-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'shot@example.com')
  git(repo, 'config', 'user.name', 'Shot')
  writeFileSync(
    join(repo, 'index.ts'),
    'export function greet(name: string): string {\n  return `hello ${name}`\n}\n'
  )
  writeFileSync(join(repo, 'util.ts'), 'export const twice = (n: number) => n * 2\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  writeFileSync(
    join(repo, 'index.ts'),
    'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n'
  )
  writeFileSync(join(repo, 'newfile.ts'), 'export const fresh = true\n')

  const sessionDir = join(claudeHome, 'projects', repo.replace(/[^a-zA-Z0-9-]/g, '-'))
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, 'fixture.jsonl'),
    [
      JSON.stringify({ type: 'summary', summary: 'Improve the greeting output' }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T10:00:00Z',
        message: { role: 'user', content: 'Make the greeting friendlier' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T10:00:05Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Updated greet() to capitalize and add punctuation.' },
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file: 'index.ts' } }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T10:00:06Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
      })
    ].join('\n')
  )

  writeFileSync(
    join(userData, 'fake-agent-script.json'),
    JSON.stringify({
      turns: [
        'I need direction before I pick a database.\n```apt-status\n{ "state": "question", "note": "Should sessions persist in SQLite or plain JSON files?" }\n```',
        'Done and verified.\n```apt-status\n{ "state": "complete", "note": "Added JSON-file session persistence with tests", "gatePassed": true, "gateSummary": "patrol green: typecheck, lint, tests", "debugUrl": "http://localhost:5173/sessions" }\n```'
      ]
    })
  )

  // Fake GitHub API behind the APT_GITHUB_API seam so the analytics dashboard
  // renders real-looking charts, releases, and repo stats. The token is only
  // saved after the settings screenshot, so nothing polls before that.
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
    // Bare repo lookup last so it never shadows the sub-resources above.
    if (req.url?.startsWith(`/repos/${REPO_SLUG}`)) {
      respond(REPO_STATS)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  await new Promise<void>((resolve) => githubServer.listen(0, '127.0.0.1', resolve))
  const githubApi = `http://127.0.0.1:${(githubServer.address() as AddressInfo).port}`

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_FAKE_AGENT_SCRIPT: join(userData, 'fake-agent-script.json'),
      APT_GITHUB_API: githubApi,
      // Hover-pinned captures must not race the physical cursor; see createWindow.
      APT_TEST_IGNORE_OS_MOUSE: '1'
    }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => githubServer?.close(() => resolve()))
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

async function shoot(name: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(outDir!, `${name}-${colorScheme}.png`) })
  }
}

function widget(title: string): Locator {
  return page.locator('.widget-card').filter({ has: page.getByRole('heading', { name: title }) })
}

test('captures all main views in both themes', async () => {
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Greeting Service')
  await page.getByPlaceholder('owner/repo (optional)').fill(REPO_SLUG)
  await page.getByPlaceholder('comma, separated, tags').fill('demo, backend')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Greeting Service' })).toBeVisible()
  await page.waitForTimeout(500)
  await shoot('dashboard')

  await page.getByRole('heading', { name: 'Greeting Service' }).click()
  await expect(page.getByText('newfile.ts').first()).toBeVisible()
  await shoot('diffs')

  await page.getByRole('button', { name: 'Sessions' }).click()
  await page.getByText('Improve the greeting output').click()
  await expect(page.getByText('Make the greeting friendlier')).toBeVisible()
  await shoot('sessions')

  await page.getByRole('button', { name: '⚙ Settings' }).click()
  await expect(page.getByText(/Status: not configured/)).toBeVisible()
  await shoot('settings')
})

test('captures the delegation views in both themes', async () => {
  await page.locator('.sidebar').getByRole('button', { name: 'Greeting Service' }).click()
  await page.getByRole('button', { name: '+ New task' }).click()
  await page.getByPlaceholder('Task title').fill('Persist sessions')
  await page
    .getByPlaceholder(/What should the agent build/)
    .fill('Persist session state so the service survives restarts')
  await page.getByPlaceholder(/Acceptance criteria/).fill('state survives a restart\ncovered by tests')
  await shoot('task-dialog')
  await page.getByRole('button', { name: 'Create' }).click()
  await shoot('tasks-draft')

  // The scripted agent asks a question, staging the escalation UI.
  await page.getByRole('button', { name: 'Delegate to agent' }).click()
  await expect(page.getByRole('heading', { name: 'The agent needs you' })).toBeVisible()
  await shoot('tasks-escalation')

  await page.getByRole('button', { name: /Inbox/ }).click()
  await expect(page.locator('.inbox-card').first()).toBeVisible()
  await shoot('inbox')

  // Answering resumes the run; the second scripted turn completes into review.
  await page.getByPlaceholder('Answer the agent…').fill('Plain JSON files, like the rest of the app')
  await page.locator('.inbox-card').getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.inbox-card .badge.inbox-review')).toBeVisible()
  await page.locator('.inbox-card').getByRole('button', { name: 'Open task' }).click()
  await expect(page.getByRole('heading', { name: 'Ready for review' })).toBeVisible()
  await shoot('tasks-review')

  // The reviewed task is still active, so the cross-project view has content.
  await page.getByRole('button', { name: '◉ Active tasks' }).click()
  await expect(page.locator('.active-task-row .badge.task-review')).toBeVisible()
  await shoot('active-tasks')

  await page.getByRole('button', { name: '⌂ Dashboard' }).click()
  await expect(page.getByText(/⚑ 1 in review/)).toBeVisible()
  await shoot('dashboard-delegation')
})

test('captures the analytics dashboard in both themes', async () => {
  // The GitHub-backed widgets need a token; saving it here keeps the earlier
  // settings screenshot on the unconfigured state.
  await page.getByRole('button', { name: '⚙ Settings' }).click()
  await page.getByPlaceholder(/ghp_/).fill(FAKE_TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByText('Token saved to the OS credential vault.')).toBeVisible()

  await page.locator('.sidebar').getByRole('button', { name: 'Greeting Service' }).click()
  await page.locator('.tab-bar').getByRole('button', { name: 'Analytics', exact: true }).click()

  // Default layout: views and clones charts plus the releases list, with a
  // hover tooltip pinned open so its theming is captured too.
  await expect(page.locator('.widget-card')).toHaveCount(3)
  await expect(widget('GitHub views').locator('.bar')).toHaveCount(14)
  await expect(page.locator('.release-card').first()).toBeVisible()
  await widget('GitHub views').locator('.bar-slot').nth(2).hover()
  await expect(widget('GitHub views').locator('.bar-tip').nth(2)).toBeVisible()
  await shoot('analytics')

  // The add-widget dialog, staged with the JSON metric source because its
  // schema renders the richest form: text fields, help lines, and a secret.
  await page.getByRole('button', { name: '+ Add widget' }).click()
  await page.getByLabel('Widget source').selectOption('json-metric')
  await page.getByLabel('Widget title').fill('Domain views')
  await page.getByLabel('Endpoint URL').fill('https://api.example.com/metrics/domain-views')
  await page.getByLabel('Value path').fill('data.visitors')
  await page.getByLabel('Unit').fill('views')
  await page.getByLabel('Bearer token').fill('fake-bearer-token')
  // Filling scrolls the modal to its last field; show the header instead.
  await page.locator('.modal').evaluate((el) => el.scrollTo(0, 0))
  await shoot('analytics-widget-dialog')

  // Customized layout: add the repo-stats widget and move it to the top so
  // the stat tiles are captured above the fold. Switching source keeps the
  // (source-agnostic) title, so clear it to fall back to the source name.
  await page.getByLabel('Widget source').selectOption('github-repo-stats')
  await page.getByLabel('Widget title').fill('')
  await page.getByRole('button', { name: 'Add widget', exact: true }).click()
  const stats = widget('GitHub repo stats')
  await expect(stats.locator('.stat-tile')).toHaveCount(4)
  const headings = page.locator('.widget-card h2')
  for (const position of [2, 1, 0]) {
    await stats.getByRole('button', { name: 'Move GitHub repo stats widget up' }).click()
    await expect(headings.nth(position)).toContainText('GitHub repo stats')
  }
  await shoot('analytics-custom')
})
