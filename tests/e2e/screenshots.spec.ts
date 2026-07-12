import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * Captures light/dark screenshots of the main views for visual review.
 * Runs only when APT_SCREENSHOT_DIR is set, so the normal E2E run skips it.
 */
const outDir = process.env.APT_SCREENSHOT_DIR

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string

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

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_FAKE_AGENT_SCRIPT: join(userData, 'fake-agent-script.json')
    }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

async function shoot(name: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(outDir!, `${name}-${colorScheme}.png`) })
  }
}

test('captures all main views in both themes', async () => {
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Greeting Service')
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

  await page.getByRole('button', { name: '⌂ Dashboard' }).click()
  await expect(page.getByText(/⚑ 1 in review/)).toBeVisible()
  await shoot('dashboard-delegation')
})
