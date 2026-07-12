import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string
let scriptPath: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function statusBlock(state: string, note: string, extra = ''): string {
  return `\`\`\`apt-status\n{ "state": "${state}", "note": "${note}"${extra} }\n\`\`\``
}

/** The fake agent (APT_FAKE_AGENT_SCRIPT seam) replays these turns, one per user message. */
function scriptAgent(...turns: Array<string | { text: string; files?: string[] }>): void {
  writeFileSync(scriptPath, JSON.stringify({ turns }))
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-deleg-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-deleg-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-deleg-repo-'))
  scriptPath = join(userData, 'fake-agent-script.json')
  scriptAgent()

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  // Workspace quality-gate skills installed, so runs are workflow-verified.
  mkdirSync(join(claudeHome, 'skills', 'patrol'), { recursive: true })

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_FAKE_AGENT_SCRIPT: scriptPath
    }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

test('set up a project for delegation', async () => {
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Delegation Demo')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Delegation Demo' })).toBeVisible()
})

test('delegated task escalates a question to the inbox, resumes on answer, and passes review', async () => {
  scriptAgent(
    `I looked at the repo and have a question.\n${statusBlock('question', 'Should the greeting be formal or casual?')}`,
    {
      text: `Done.\n${statusBlock(
        'complete',
        'Added the casual greeting and verified it',
        ', "gatePassed": true, "gateSummary": "patrol green: typecheck, lint, tests"' +
          ', "debugUrl": "http://localhost:5173/greeting"' +
          ', "changesUrl": "https://github.com/example/demo/pull/12"'
      )}`,
      files: ['src/greeting.ts', 'src/greeting.test.ts']
    }
  )

  // Create the task from the project's Tasks tab.
  await page.locator('.sidebar').getByRole('button', { name: 'Delegation Demo' }).click()
  await page.getByRole('button', { name: '+ New task' }).click()
  await page.getByPlaceholder('Task title').fill('Greeting feature')
  await page.getByPlaceholder(/What should the agent build/).fill('Add a friendly greeting module')
  await page.getByPlaceholder(/Acceptance criteria/).fill('greeting is exported')
  await page.getByRole('button', { name: 'Create' }).click()

  // Delegate: the fake agent immediately asks for direction.
  await page.getByRole('button', { name: 'Delegate to agent' }).click()
  await expect(page.locator('.task-row').getByText('needs input')).toBeVisible()
  await expect(page.getByText('Should the greeting be formal or casual?').first()).toBeVisible()

  // The question surfaces in the global inbox with the attention count.
  await expect(page.locator('.attention-count')).toHaveText('1')
  await page.getByRole('button', { name: /Inbox/ }).click()
  await expect(page.getByRole('heading', { name: 'Attention inbox' })).toBeVisible()
  await expect(
    page.locator('.inbox-card').getByText('Should the greeting be formal or casual?')
  ).toBeVisible()

  // Answer in place: the run resumes and completes into review.
  await page.getByPlaceholder('Answer the agent…').fill('Casual, please')
  await page.locator('.inbox-card').getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.inbox-card .badge.inbox-review')).toBeVisible()
  await expect(page.getByText('Added the casual greeting and verified it')).toBeVisible()
  // The completion's debug and changed-files links are offered right on the inbox card.
  await expect(page.locator('.inbox-card').getByRole('link', { name: /Test the changes/ })).toHaveAttribute(
    'href',
    'http://localhost:5173/greeting'
  )
  await expect(
    page.locator('.inbox-card').getByRole('link', { name: /View the changed files/ })
  ).toHaveAttribute('href', 'https://github.com/example/demo/pull/12')

  // Review from the task detail: completion summary, gate result, links, accept.
  await page.locator('.inbox-card').getByRole('button', { name: 'Open task' }).click()
  await expect(page.getByRole('heading', { name: 'Ready for review' })).toBeVisible()
  await expect(page.getByText('patrol green: typecheck, lint, tests')).toBeVisible()
  await expect(page.locator('.review-panel').getByRole('link', { name: /Test the changes/ })).toHaveAttribute(
    'href',
    'http://localhost:5173/greeting'
  )
  await expect(
    page.locator('.review-panel').getByRole('link', { name: /View the changed files/ })
  ).toHaveAttribute('href', 'https://github.com/example/demo/pull/12')
  // Two fake-agent turns at 125 tokens each.
  await expect(page.getByText('250 tokens')).toBeVisible()
  // The completion turn edited two files through the Edit tool.
  const filesLabel = page.getByText('2 files changed')
  await expect(filesLabel).toBeVisible()
  await expect(filesLabel).toHaveAttribute('title', /src\/greeting\.ts/)
  await page.getByRole('button', { name: '✓ Accept' }).click()
  await expect(page.locator('.task-row').getByText('done')).toBeVisible()
  await expect(page.locator('.attention-count')).toHaveCount(0)

  // The run's session is attributed to the task and its transcript is reachable.
  await page.getByRole('button', { name: 'Open transcript →' }).click()
  await expect(page.locator('.session-row').getByText('⚑ Greeting feature')).toBeVisible()
  await expect(page.locator('.transcript').getByText('Casual, please')).toBeVisible()
  await page.getByRole('button', { name: '⚑ View task' }).click()
  await expect(page.getByRole('heading', { name: 'Greeting feature' })).toBeVisible()
})

test('exhausted recovery escalates to the inbox and can be failed by the user', async () => {
  scriptAgent(
    `Trying to build.\n${statusBlock('blocked', 'the build fails with a missing module')}`,
    `Still stuck.\n${statusBlock('blocked', 'the module cannot be found anywhere')}`
  )

  await page.locator('.sidebar').getByRole('button', { name: 'Delegation Demo' }).click()
  await page.getByRole('button', { name: '+ New task' }).click()
  await page.getByPlaceholder('Task title').fill('Doomed build')
  await page.getByPlaceholder(/What should the agent build/).fill('Build something impossible')
  await page.getByLabel('Recovery budget').fill('1')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'Delegate to agent' }).click()

  // One nudge is spent, then the second failure escalates with the history.
  await expect(page.getByRole('heading', { name: 'The agent needs you' })).toBeVisible()
  await expect(page.getByText('the module cannot be found anywhere').first()).toBeVisible()

  // The dashboard's delegation summary flags the project.
  await page.getByRole('button', { name: '⌂ Dashboard' }).click()
  await expect(page.getByText('⚑ 1 needs input')).toBeVisible()

  // The inbox shows the exhausted-recovery item with the failure history.
  await page.getByRole('button', { name: /Inbox/ }).click()
  await expect(page.locator('.inbox-card .badge.inbox-recovery-exhausted')).toBeVisible()
  await expect(page.locator('.inbox-card').getByText('the build fails with a missing module')).toBeVisible()

  // The user gives up on it: mark failed from the task detail.
  await page.locator('.inbox-card').getByRole('button', { name: 'Open task' }).click()
  await page.getByRole('button', { name: 'Mark failed' }).click()
  await expect(page.locator('.task-row').getByText('failed', { exact: true })).toBeVisible()
})

test('publishing a release delegates a publish task that completes into review', async () => {
  scriptAgent(
    `Published.\n${statusBlock(
      'complete',
      'Published v0.1.0 with the installer attached',
      ', "gatePassed": true, "gateSummary": "release workflow green"'
    )}`
  )

  await page.locator('.sidebar').getByRole('button', { name: 'Delegation Demo' }).click()
  await page.getByRole('button', { name: 'Release', exact: true }).click()
  await expect(page.locator('.badge.release-version')).toHaveText('v0.1.0')
  // The task accepted in the earlier flow is credited to this release.
  await expect(page.locator('.release-task-list').getByText('Greeting feature')).toBeVisible()

  // Publish: a delegated task is created and the view lands on its detail.
  await page.getByRole('button', { name: '🚀 Publish release' }).click()
  await expect(page.getByRole('heading', { name: 'Publish release v0.1.0' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ready for review' })).toBeVisible()
  await expect(page.getByText('Published v0.1.0 with the installer attached').first()).toBeVisible()

  // While the publish task is open, the release tab offers it instead of a second publish.
  await page.getByRole('button', { name: 'Release', exact: true }).click()
  await expect(page.getByText(/Publishing is in flight/)).toBeVisible()
  await expect(page.getByRole('button', { name: '🚀 Publish release' })).toHaveCount(0)

  // Accept the reviewed publish task from its detail.
  await page.getByRole('button', { name: 'Open publish task →' }).click()
  await page.getByRole('button', { name: '✓ Accept' }).click()
  await expect(page.locator('.task-detail-header .badge.task-done')).toBeVisible()
})

test('a running task can be stopped manually and moves to failed', async () => {
  scriptAgent(`On it.\n${statusBlock('working', 'reading the codebase')}`)

  await page.locator('.sidebar').getByRole('button', { name: 'Delegation Demo' }).click()
  await page.getByRole('button', { name: '+ New task' }).click()
  await page.getByPlaceholder('Task title').fill('Long research')
  await page.getByPlaceholder(/What should the agent build/).fill('Research the codebase at length')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'Delegate to agent' }).click()

  await expect(page.getByText('reading the codebase').first()).toBeVisible()
  await page.getByRole('button', { name: '⏹ Stop run' }).click()
  await expect(page.locator('.task-detail-header .badge.task-failed')).toBeVisible()
  // The transcript survives the stop.
  await page.getByRole('button', { name: 'Open transcript →' }).click()
  await expect(page.getByText('reading the codebase').first()).toBeVisible()
})

test('the active tasks view monitors running work per project and opens the task', async () => {
  // Every task from the earlier flows has finished, so the view starts empty.
  await page.getByRole('button', { name: '◉ Active tasks' }).click()
  await expect(page.getByRole('heading', { name: 'Active tasks' })).toBeVisible()
  await expect(page.getByText('No active tasks.')).toBeVisible()

  scriptAgent(`On it.\n${statusBlock('working', 'sketching the monitoring view')}`)
  await page.locator('.sidebar').getByRole('button', { name: 'Delegation Demo' }).click()
  await page.getByRole('button', { name: '+ New task' }).click()
  await page.getByPlaceholder('Task title').fill('Monitored work')
  await page.getByPlaceholder(/What should the agent build/).fill('Keep working so the view can watch')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'Delegate to agent' }).click()
  await expect(page.getByText('sketching the monitoring view').first()).toBeVisible()

  // The running task shows under its project with live progress.
  await page.getByRole('button', { name: '◉ Active tasks' }).click()
  await expect(page.getByText('1 active across 1 project')).toBeVisible()
  await expect(page.locator('.active-project-name')).toHaveText('Delegation Demo →')
  const row = page.locator('.active-task-row')
  await expect(row.getByText('Monitored work')).toBeVisible()
  await expect(row.locator('.badge.task-running')).toBeVisible()
  await expect(row.getByText('sketching the monitoring view')).toBeVisible()

  // Clicking the row lands on the task's detail; stopping empties the view again.
  await row.click()
  await expect(page.getByRole('heading', { name: 'Monitored work' })).toBeVisible()
  await page.getByRole('button', { name: '⏹ Stop run' }).click()
  await expect(page.locator('.task-detail-header .badge.task-failed')).toBeVisible()
  await page.getByRole('button', { name: '◉ Active tasks' }).click()
  await expect(page.getByText('No active tasks.')).toBeVisible()
})
