import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string

/** Enough changed lines that windowing is unambiguous rather than incidental. */
const BIG_FILE_LINES = 2000

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-diff-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-diff-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-diff-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')

  // A big TypeScript file, committed then rewritten, so every line differs.
  const original = Array.from({ length: BIG_FILE_LINES }, (_, i) => `export const before${i} = ${i}`)
  writeFileSync(join(repo, 'big.ts'), original.join('\n') + '\n')
  // A file whose change adds a block comment spanning several lines, which is
  // only classifiable as a comment by looking at more than one line at a time.
  writeFileSync(join(repo, 'commented.ts'), 'export const kept = 1\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  const rewritten = Array.from({ length: BIG_FILE_LINES }, (_, i) => `export const after${i} = ${i * 2}`)
  writeFileSync(join(repo, 'big.ts'), rewritten.join('\n') + '\n')
  writeFileSync(
    join(repo, 'commented.ts'),
    ['/* explaining', '   across several', '   lines */', 'export const kept = 1'].join('\n') + '\n'
  )

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
  await page.getByPlaceholder('Project name').fill('Diff Demo')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Diff Demo' })).toBeVisible()
  await page.locator('.sidebar').getByRole('button', { name: 'Diff Demo' }).click()
  await page.getByRole('button', { name: 'Diffs', exact: true }).click()
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

async function openFile(name: string): Promise<void> {
  await page.locator('.diff-file-row', { hasText: name }).click()
  await expect(page.locator('.diff-detail-header code')).toContainText(name)
}

test('a large diff renders only a window of rows, not every line', async () => {
  await openFile('big.ts')

  // The file really is large: the sidebar counts every line as changed.
  await expect(page.locator('.diff-file-row', { hasText: 'big.ts' }).locator('.add')).toHaveText(
    `+${BIG_FILE_LINES}`
  )

  const rendered = await page.locator('.diff-row').count()
  expect(rendered).toBeGreaterThan(0)
  // Windowed: the DOM holds a viewport's worth plus overscan, nowhere near the
  // 4000 rows an unwindowed render of this diff would produce.
  expect(rendered).toBeLessThan(200)
})

test('scrolling a large diff reveals later lines without growing the DOM', async () => {
  await openFile('big.ts')
  // git emits this file's hunk as every deletion followed by every addition, so
  // the top of the diff is the first removed line and the bottom is the last
  // added one.
  const firstLine = 'export const before0 = 0'
  const lateLine = `export const after${BIG_FILE_LINES - 1} = ${(BIG_FILE_LINES - 1) * 2}`

  await expect(page.locator('.diff-code')).toContainText(firstLine)
  await expect(page.locator('.diff-code')).not.toContainText(lateLine)

  // Jump to the bottom of the scroll container.
  await page.locator('.diff-code').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))

  await expect(page.locator('.diff-code')).toContainText(lateLine)
  await expect(page.locator('.diff-code')).not.toContainText(firstLine)
  expect(await page.locator('.diff-row').count()).toBeLessThan(200)
})

test('a multi-line comment is highlighted as a comment on every one of its lines', async () => {
  await openFile('commented.ts')

  // The middle line is a comment only by virtue of the line above it, so this
  // fails if each line is highlighted in isolation.
  const middle = page.locator('.diff-row', { hasText: 'across several' }).locator('.hljs-comment')
  await expect(middle).toHaveCount(1)
  await expect(page.locator('.diff-row', { hasText: 'lines */' }).locator('.hljs-comment')).toHaveCount(1)
})

test('side-by-side mode pairs the removed and added lines', async () => {
  await openFile('commented.ts')
  await page.getByText('side by side').click()

  const splitRows = page.locator('.diff-row-split')
  await expect(splitRows.first()).toBeVisible()
  // The unchanged line appears on both sides of its row.
  const keptRow = splitRows.filter({ hasText: 'export const kept = 1' }).first()
  await expect(keptRow.locator('.code')).toHaveCount(2)

  await page.getByText('side by side').click()
  await expect(page.locator('.diff-row-split')).toHaveCount(0)
})

test('the diff panes keep their columns aligned and rows inside the pane', async () => {
  await openFile('big.ts')
  const rows = page.locator('.diff-row')

  // Independently positioned rows must still line their columns up, which is
  // what a shared grid buys back after dropping table layout.
  const firstCode = await rows.nth(0).locator('.code').boundingBox()
  const secondCode = await rows.nth(1).locator('.code').boundingBox()
  expect(Math.round(secondCode!.x)).toBe(Math.round(firstCode!.x))

  // Rows fit the scroll pane: long lines wrap rather than overflowing sideways.
  const pane = await page.locator('.diff-code').boundingBox()
  expect(Math.round(firstCode!.x + firstCode!.width)).toBeLessThanOrEqual(
    Math.round(pane!.x + pane!.width) + 1
  )

  // The header stays put above the scrolling rows rather than scrolling away.
  await page.locator('.diff-code').evaluate((el) => el.scrollTo({ top: 400 }))
  await expect(page.locator('.diff-detail-header')).toBeInViewport()
})
