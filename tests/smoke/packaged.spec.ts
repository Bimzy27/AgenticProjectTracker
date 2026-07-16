import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * Packaged-build smoke test: launches the real asar-packed executable and
 * drives the fake-agent delegation flow end to end.
 *
 * The dev-build E2E suite (tests/e2e) cannot catch packaging bugs - v0.1.0
 * shipped two asar bugs that only reproduced in the installed app - so the
 * release workflow silently installs the NSIS installer and runs this spec
 * against the installed exe (APT_PACKAGED_EXE). Locally, run
 * `npm run package` first; the spec defaults to the dist/win-unpacked exe.
 */
const packagedExe =
  process.env.APT_PACKAGED_EXE ??
  join(__dirname, '..', '..', 'dist', 'win-unpacked', 'Agentic Project Tracker.exe')

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
function scriptAgent(...turns: string[]): void {
  writeFileSync(scriptPath, JSON.stringify({ turns }))
}

test.beforeAll(async () => {
  if (!existsSync(packagedExe)) {
    throw new Error(
      `Packaged exe not found at "${packagedExe}". Run \`npm run package\` first, ` +
        'or point APT_PACKAGED_EXE at an installed Agentic Project Tracker.exe.'
    )
  }

  userData = mkdtempSync(join(tmpdir(), 'apt-smoke-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-smoke-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-smoke-repo-'))
  scriptPath = join(userData, 'fake-agent-script.json')
  scriptAgent()

  // Fixture repo: one commit (including an asar file for the watcher
  // regression check below) plus a dirty working tree.
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'smoke@example.com')
  git(repo, 'config', 'user.name', 'Smoke')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  writeFileSync(join(repo, 'build.asar'), 'not a real archive\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello world"\n')

  app = await electron.launch({
    executablePath: packagedExe,
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

test('the exe is the packaged build of this version', async () => {
  const info = await app.evaluate(({ app: electronApp }) => ({
    packaged: electronApp.isPackaged,
    version: electronApp.getVersion()
  }))
  // isPackaged proves the asar-packed production composition is under test,
  // not a dev build that happens to sit at the same path.
  expect(info.packaged).toBe(true)
  expect(info.version).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version as string)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})

test('registers a project without locking asar files in the watched repo', async () => {
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Packaged Smoke')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Packaged Smoke' })).toBeVisible()
  await expect(page.getByText('⎇ main')).toBeVisible()
  await expect(page.getByText('1 changed')).toBeVisible()

  // Regression guard for the v0.1.2 asar bug: in a packaged app Electron's
  // patched fs caches an open handle on any *.asar it merely stats, so if the
  // repo watcher stats entries this delete throws EBUSY/EPERM on Windows.
  rmSync(join(repo, 'build.asar'))
  // The watcher noticed the delete: the tracked file now counts as changed too.
  await expect(page.getByText('2 changed')).toBeVisible({ timeout: 15_000 })
})

test('drives the fake-agent delegation flow end to end', async () => {
  scriptAgent(
    `I looked at the repo and have a question.\n${statusBlock('question', 'Formal or casual greeting?')}`,
    `Done.\n${statusBlock(
      'complete',
      'Added the casual greeting and verified it',
      ', "gatePassed": true, "gateSummary": "patrol green: typecheck, lint, tests"'
    )}`
  )

  await page.locator('.sidebar').getByRole('button', { name: 'Packaged Smoke' }).click()
  await page.getByRole('button', { name: '+ New task' }).click()
  await page.getByPlaceholder('Task title').fill('Greeting feature')
  await page.getByPlaceholder(/What should the agent build/).fill('Add a friendly greeting module')
  await page.getByRole('button', { name: 'Create' }).click()

  // Delegate: the scripted agent escalates a question into the inbox.
  await page.getByRole('button', { name: 'Delegate to agent' }).click()
  await expect(page.locator('.task-row').getByText('needs input')).toBeVisible()
  await expect(page.locator('.attention-count')).toHaveText('1')
  await page.getByRole('button', { name: /Inbox/ }).click()
  await expect(page.locator('.inbox-card').getByText('Formal or casual greeting?')).toBeVisible()

  // Answer in place: the run resumes and completes into review.
  await page.getByPlaceholder('Answer the agent…').fill('Casual, please')
  await page.locator('.inbox-card').getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.inbox-card .badge.inbox-review')).toBeVisible()

  // Review and accept from the task detail.
  await page.locator('.inbox-card').getByRole('button', { name: 'Open task' }).click()
  await expect(page.getByRole('heading', { name: 'Ready for review' })).toBeVisible()
  await expect(page.getByText('patrol green: typecheck, lint, tests')).toBeVisible()
  await page.getByRole('button', { name: '✓ Accept' }).click()
  await expect(page.locator('.task-detail-header .badge.task-done')).toBeVisible()
  await expect(page.locator('.attention-count')).toHaveCount(0)

  // The run transcript was persisted under the (packaged) session storage
  // and is reachable from the task detail.
  await page.getByRole('button', { name: 'Open transcript →' }).click()
  await expect(page.locator('.transcript').getByText('Casual, please')).toBeVisible()
})
