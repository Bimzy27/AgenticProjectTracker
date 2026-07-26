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

/** Long enough that windowing is unambiguous rather than incidental. */
const TURNS = 400

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-transcript-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-transcript-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-transcript-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'readme.md'), '# transcript fixture\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  // A long discovered session: alternating user/assistant turns, plus one tool
  // call near the top whose expandable output changes the row's height.
  const encoded = repo.replace(/[^a-zA-Z0-9-]/g, '-')
  const sessionDir = join(claudeHome, 'projects', encoded)
  mkdirSync(sessionDir, { recursive: true })

  const lines: string[] = [JSON.stringify({ type: 'summary', summary: 'Long fixture session' })]
  lines.push(
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-01T10:00:00Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'readme.md' }
          }
        ]
      }
    })
  )
  lines.push(
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-01T10:00:01Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: Array.from({ length: 40 }, (_, i) => `tool output line ${i}`).join('\n')
          }
        ]
      }
    })
  )
  for (let i = 0; i < TURNS; i++) {
    lines.push(
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T10:00:00Z',
        message: { role: 'user', content: `user turn ${i}` }
      })
    )
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T10:00:05Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `assistant turn ${i}` }] }
      })
    )
  }
  writeFileSync(join(sessionDir, 'long-session.jsonl'), lines.join('\n'))

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_TEST_IGNORE_OS_MOUSE: '1'
    }
  })
  page = await app.firstWindow()

  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Transcript Demo')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transcript Demo' })).toBeVisible()
  await page.locator('.sidebar').getByRole('button', { name: 'Transcript Demo' }).click()
  await page.getByRole('button', { name: 'Sessions' }).click()
  await page.getByText('Long fixture session').click()
  await expect(page.locator('.transcript')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

test('a long transcript renders only a window of entries', async () => {
  const rendered = await page.locator('.transcript-row').count()
  expect(rendered).toBeGreaterThan(0)
  // Windowed: nowhere near the 800+ entries this session holds.
  expect(rendered).toBeLessThan(80)
})

test('the newest entry is shown without scrolling, as the tail of the conversation', async () => {
  // The view follows the tail, so the last turn is on screen while the first
  // is far above and not even rendered.
  await expect(page.locator('.transcript')).toContainText(`assistant turn ${TURNS - 1}`)
  await expect(page.locator('.transcript')).not.toContainText('user turn 0')
})

test('scrolling back reveals earlier entries without growing the DOM', async () => {
  await page.locator('.transcript').evaluate((el) => el.scrollTo({ top: 0 }))

  await expect(page.locator('.transcript')).toContainText('user turn 0')
  await expect(page.locator('.transcript')).not.toContainText(`assistant turn ${TURNS - 1}`)
  expect(await page.locator('.transcript-row').count()).toBeLessThan(80)
})

test('expanding a tool entry re-measures it so following entries do not overlap', async () => {
  await page.locator('.transcript').evaluate((el) => el.scrollTo({ top: 0 }))
  const tool = page.locator('.transcript-item.tool').first()
  await expect(tool).toBeVisible()

  const collapsedRow = page.locator('.transcript-row').filter({ has: tool })
  const before = await collapsedRow.boundingBox()

  await tool.locator('summary').click()
  await expect(tool.locator('pre')).toBeVisible()

  // The row grew to fit the revealed output...
  await expect
    .poll(async () => (await collapsedRow.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before!.height)

  // ...and the entry after it was pushed down rather than being overlapped.
  const rows = page.locator('.transcript-row')
  const boxes = await rows.evaluateAll((elements) =>
    elements.map((el) => {
      const rect = el.getBoundingClientRect()
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) }
    })
  )
  const ordered = [...boxes].sort((a, b) => a.top - b.top)
  for (let i = 1; i < ordered.length; i++) {
    expect(ordered[i].top).toBeGreaterThanOrEqual(ordered[i - 1].bottom - 1)
  }
})
