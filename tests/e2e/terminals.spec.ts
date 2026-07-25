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
let shellScript: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-term-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-term-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-term-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  // APT_TEST_SHELL seam: a deterministic stand-in for the real default shell.
  // Windows' console host echoes typed input itself (ENABLE_ECHO_INPUT), so
  // this only needs to react per line, not re-echo keystrokes.
  shellScript = join(userData, 'fake-terminal-shell.cjs')
  writeFileSync(
    shellScript,
    [
      "const readline = require('node:readline')",
      'const rl = readline.createInterface({ input: process.stdin, terminal: false })',
      "process.stdout.write('ready\\r\\n')",
      "rl.on('line', (line) => {",
      "  if (line.trim() === 'exit') {",
      "    process.stdout.write('bye\\r\\n')",
      '    process.exit(3)',
      '  }',
      '  process.stdout.write(`you said: ${line}\\r\\n`)',
      '})'
    ].join('\n')
  )

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_TEST_SHELL: shellScript
    }
  })
  page = await app.firstWindow()

  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Terminal Demo')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Terminal Demo' })).toBeVisible()
  await page.locator('.sidebar').getByRole('button', { name: 'Terminal Demo' }).click()
  await page.getByRole('button', { name: 'Terminals' }).click()
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

test('starts empty with no terminals for a fresh project', async () => {
  await expect(page.getByText('No terminals open for this project.')).toBeVisible()
})

test('creating a terminal spawns the seamed shell and shows its output', async () => {
  await page.getByRole('button', { name: '+ New terminal' }).click()
  await expect(page.locator('.terminal-subtab', { hasText: 'Terminal 1' })).toHaveClass(/active/)
  await expect(page.locator('.terminal-pane.active .xterm-rows')).toContainText('ready')
})

test('typing is sent to the shell and its response streams back', async () => {
  await page.locator('.terminal-pane.active .terminal-surface').click()
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await expect(page.locator('.terminal-pane.active .xterm-rows')).toContainText('you said: hello')
})

test('a second terminal is independent and switching back preserves the first', async () => {
  await page.getByRole('button', { name: '+ New terminal' }).click()
  await expect(page.locator('.terminal-subtab', { hasText: 'Terminal 2' })).toHaveClass(/active/)
  await expect(page.locator('.terminal-pane.active .xterm-rows')).not.toContainText('you said: hello')

  await page.locator('.terminal-subtab', { hasText: 'Terminal 1' }).click()
  await expect(page.locator('.terminal-subtab', { hasText: 'Terminal 1' })).toHaveClass(/active/)
  await expect(page.locator('.terminal-pane.active .xterm-rows')).toContainText('you said: hello')
})

test('terminals survive navigating away from and back to the Terminals tab', async () => {
  await page.getByRole('button', { name: 'Diffs', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Terminal Demo' })).toBeVisible()
  await page.getByRole('button', { name: 'Terminals' }).click()

  await expect(page.locator('.terminal-subtab', { hasText: 'Terminal 1' })).toBeVisible()
  await expect(page.locator('.terminal-subtab', { hasText: 'Terminal 2' })).toBeVisible()
  await expect(page.locator('.terminal-pane.active .xterm-rows')).toContainText('you said: hello')
})

test('an exited shell shows an exited banner instead of disappearing', async () => {
  await page.locator('.terminal-subtab', { hasText: 'Terminal 2' }).click()
  await page.locator('.terminal-pane.active .terminal-surface').click()
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')

  await expect(page.locator('.terminal-pane.active .terminal-exited-banner')).toHaveText('Exited (code 3)')
  await expect(page.locator('.terminal-subtab', { hasText: 'Terminal 2' })).toContainText('●')
})

test('closing a live terminal asks for confirmation; closing an exited one does not', async () => {
  // Terminal 1 is still alive: closing it must be confirmed first.
  const terminal1 = page.locator('.terminal-subtab', { hasText: 'Terminal 1' })
  await terminal1.locator('.terminal-subtab-close').click()
  const modal = page.locator('.modal', { hasText: 'Close Terminal 1?' })
  await expect(modal).toBeVisible()
  await modal.getByRole('button', { name: 'Cancel' }).click()
  await expect(terminal1).toBeVisible()

  await terminal1.locator('.terminal-subtab-close').click()
  await modal.getByRole('button', { name: 'Close anyway' }).click()
  await expect(terminal1).toHaveCount(0)

  // Terminal 2 already exited: closing it is immediate, no confirmation.
  const terminal2 = page.locator('.terminal-subtab', { hasText: 'Terminal 2' })
  await terminal2.locator('.terminal-subtab-close').click()
  await expect(page.locator('.modal')).toHaveCount(0)
  await expect(terminal2).toHaveCount(0)
  await expect(page.getByText('No terminals open for this project.')).toBeVisible()
})
