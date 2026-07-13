import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string
let editorDir: string
let editorCmd: string
let editorLaunchFile: string
let usageServer: Server
let usageEndpoint: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-repo-'))
  editorDir = mkdtempSync(join(tmpdir(), 'apt-e2e-editor-'))

  // Stub editor injected via APT_TEST_EDITOR_CMD: records its first argument
  // instead of opening anything, so the test can assert the launched path.
  editorLaunchFile = join(editorDir, 'launch.txt')
  if (process.platform === 'win32') {
    editorCmd = join(editorDir, 'editor.cmd')
    writeFileSync(editorCmd, '@(echo %~1)>"%~dp0launch.txt"\r\n')
  } else {
    editorCmd = join(editorDir, 'editor.sh')
    writeFileSync(editorCmd, '#!/bin/sh\nprintf \'%s\' "$1" > "$(dirname "$0")/launch.txt"\n', {
      mode: 0o755
    })
  }

  // Fixture repo with a commit and a dirty working tree.
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello world"\n')

  // Fixture Claude session for this repo.
  const encoded = repo.replace(/[^a-zA-Z0-9-]/g, '-')
  const sessionDir = join(claudeHome, 'projects', encoded)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, 'fixture-session.jsonl'),
    [
      JSON.stringify({ type: 'summary', summary: 'Fixture session about greetings' }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T10:00:00Z',
        message: { role: 'user', content: 'Change the greeting text' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T10:00:05Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done, updated hello.ts.' }] }
      })
    ].join('\n')
  )

  // Fake Claude CLI credentials plus a stub usage API for the About view.
  writeFileSync(
    join(claudeHome, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'e2e-fake-access-token', subscriptionType: 'pro' }
    })
  )
  usageServer = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer e2e-fake-access-token') {
      res.writeHead(401).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        limits: [
          {
            kind: 'session',
            percent: 14,
            severity: 'normal',
            resets_at: '2026-07-12T10:00:00Z',
            scope: null
          },
          {
            kind: 'weekly_all',
            percent: 37,
            severity: 'normal',
            resets_at: '2026-07-14T09:00:00Z',
            scope: null
          },
          {
            kind: 'weekly_scoped',
            percent: 61,
            severity: 'normal',
            resets_at: '2026-07-12T12:00:00Z',
            scope: { model: { id: null, display_name: 'Fable' } }
          }
        ]
      })
    )
  })
  await new Promise<void>((resolve) => usageServer.listen(0, '127.0.0.1', resolve))
  usageEndpoint = `http://127.0.0.1:${(usageServer.address() as AddressInfo).port}/api/oauth/usage`

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_TEST_EDITOR_CMD: editorCmd,
      APT_USAGE_ENDPOINT: usageEndpoint
    }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => usageServer?.close(() => resolve()))
  for (const dir of [userData, claudeHome, repo, editorDir]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shows the empty dashboard on first launch', async () => {
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('No projects yet')).toBeVisible()
})

test('registers a project from a local git repository', async () => {
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await expect(page.getByPlaceholder('Project name')).not.toHaveValue('')
  await page.getByPlaceholder('Project name').fill('E2E Demo')
  await page.getByPlaceholder('comma, separated, tags').fill('e2e')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'E2E Demo' })).toBeVisible()
  await expect(page.getByText('⎇ main')).toBeVisible()
  await expect(page.getByText('1 changed')).toBeVisible()
})

test('shows the working tree diff with the modified line', async () => {
  await page.getByRole('heading', { name: 'E2E Demo' }).click()
  await expect(page.getByRole('button', { name: 'Working tree' })).toBeVisible()
  await expect(page.getByText('hello.ts').first()).toBeVisible()
  await expect(page.getByText('export const greeting = "hello world"').first()).toBeVisible()
})

test('the VSCode button opens the repository root in the editor', async () => {
  await page.getByRole('button', { name: 'VSCode' }).click()
  await expect.poll(() => existsSync(editorLaunchFile), { timeout: 10_000 }).toBe(true)
  const launchedPath = normalize(readFileSync(editorLaunchFile, 'utf8').trim())
  const expectedRoot = normalize(
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()
  )
  // Case-insensitive: Windows may report an 8.3/case alias of the temp path.
  expect(launchedPath.toLowerCase()).toBe(expectedRoot.toLowerCase())
})

test('opens a discovered session transcript', async () => {
  await page.getByRole('button', { name: 'Sessions' }).click()
  await page.getByText('Fixture session about greetings').click()
  await expect(page.getByText('Change the greeting text')).toBeVisible()
  await expect(page.getByText('Done, updated hello.ts.')).toBeVisible()
})

test('pipelines tab explains the missing GitHub setup instead of erroring', async () => {
  await page.getByRole('button', { name: 'Pipelines' }).click()
  // The fixture repo has no GitHub remote linked, so the repo-link prompt shows.
  await expect(page.getByText(/Link a GitHub repo|needs a GitHub token/)).toBeVisible()
})

test('release tab previews the next release from local git history', async () => {
  await page.getByRole('button', { name: 'Release', exact: true }).click()
  // No tags and no package.json in the fixture repo: first release falls back to v0.1.0.
  await expect(page.locator('.badge.release-version')).toHaveText('v0.1.0')
  await expect(page.getByText('No release has been published yet.')).toBeVisible()
  await expect(page.locator('.release-commits').getByText('initial')).toBeVisible()
  await expect(page.getByRole('button', { name: '🚀 Publish release' })).toBeEnabled()
  await expect(page.getByText(/uncommitted changes/)).toBeVisible()
  await expect(page.getByText('No tasks were completed since the last release.')).toBeVisible()
})

test('release tab warns when work after the last tag sits uncommitted', async () => {
  // Ship everything and tag it, then leave new work uncommitted: the state a
  // repo is in when a completed task's changes were never committed.
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'feat: greet the world')
  git(repo, 'tag', 'v0.4.0')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello again"\n')

  // Re-enter the tab for a deterministic fresh preview load.
  await page.getByRole('button', { name: 'Diffs' }).click()
  await page.getByRole('button', { name: 'Release', exact: true }).click()

  await expect(page.locator('.badge.release-version')).toHaveText('v0.4.1')
  await expect(page.getByText('Everything has shipped; there are no unreleased commits.')).toBeVisible()
  await expect(page.getByRole('button', { name: '🚀 Publish release' })).toBeDisabled()
  // The dirty tree is the missing release content; the tab must say so.
  await expect(page.getByText(/uncommitted changes/)).toBeVisible()
})

test('settings shows the not-configured GitHub auth state', async () => {
  await page.getByRole('button', { name: '⚙ Settings' }).click()
  await expect(page.getByText(/Status: not configured/)).toBeVisible()
})

test('about shows the app version and the Claude usage budget', async () => {
  await page.getByRole('button', { name: 'ⓘ About' }).click()
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
  await expect(page.getByText(`Version: ${version}`)).toBeVisible()
  await expect(page.getByText('Plan: pro')).toBeVisible()
  await expect(page.getByText('Session (5-hour window)')).toBeVisible()
  await expect(page.getByText(/14% used/)).toBeVisible()
  await expect(page.getByText('Weekly - all models')).toBeVisible()
  await expect(page.getByText(/37% used/)).toBeVisible()
  await expect(page.getByText('Weekly - Fable')).toBeVisible()
  await expect(page.getByText(/61% used/)).toBeVisible()
})

test('sidebar usage bars summarize the Claude budget in a hover overlay', async () => {
  // Leave the About view first so the assertions below only match the overlay.
  await page.getByRole('button', { name: '⌂ Dashboard' }).click()
  const bars = page.getByRole('button', { name: 'Claude usage' })
  await expect(bars.locator('.usage-bar-track')).toHaveCount(3)
  await bars.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip.getByText('Claude usage · pro')).toBeVisible()
  await expect(tip.getByText('Session (5-hour window)')).toBeVisible()
  await expect(tip.getByText(/14% used/)).toBeVisible()
  await expect(tip.getByText('Weekly - all models')).toBeVisible()
  await expect(tip.getByText(/37% used/)).toBeVisible()
  await expect(tip.getByText('Weekly - Fable')).toBeVisible()
  await expect(tip.getByText(/61% used/)).toBeVisible()
})

test('clicking the sidebar usage bars opens the About view', async () => {
  await page.getByRole('button', { name: 'Claude usage' }).click()
  await expect(page.getByRole('heading', { name: 'About' })).toBeVisible()
})
