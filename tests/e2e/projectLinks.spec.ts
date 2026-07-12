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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo
    }
  })
  page = await app.firstWindow()
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-links-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-links-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-links-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'readme.md'), '# links fixture\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  await launch()
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userData, claudeHome, repo]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('configures an important link that appears in the project view', async () => {
  // Register a project and open it.
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Links Demo')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await page.getByRole('heading', { name: 'Links Demo' }).click()

  // No links configured yet: only the add affordance shows.
  await expect(page.getByRole('button', { name: '+ Add links' })).toBeVisible()

  await page.getByRole('button', { name: '+ Add links' }).click()
  await page.getByLabel('Link label').fill('Vercel dashboard')
  await page.getByLabel('Link URL').fill('https://vercel.com/me/links-demo')
  await page.getByRole('button', { name: 'Save links' }).click()

  const link = page.getByRole('link', { name: 'Vercel dashboard ↗' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', 'https://vercel.com/me/links-demo')
})

test('rejects an invalid link URL with an explanatory error', async () => {
  await page.getByRole('button', { name: '✎ Edit links' }).click()
  await page.getByRole('button', { name: '+ Add link', exact: true }).click()
  await page.getByLabel('Link label').nth(1).fill('Website')
  await page.getByLabel('Link URL').nth(1).fill('not-a-url')
  await page.getByRole('button', { name: 'Save links' }).click()
  await expect(page.getByText(/absolute http\(s\) URL/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
})

test('important links persist across an app restart', async () => {
  await app.close()
  await launch()
  await page.getByRole('button', { name: 'Links Demo', exact: true }).click()
  const link = page.getByRole('link', { name: 'Vercel dashboard ↗' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', 'https://vercel.com/me/links-demo')
})

test('removing the last link restores the add affordance', async () => {
  await page.getByRole('button', { name: '✎ Edit links' }).click()
  await page.getByRole('button', { name: 'Remove link' }).click()
  await page.getByRole('button', { name: 'Save links' }).click()
  await expect(page.getByRole('link', { name: 'Vercel dashboard ↗' })).toBeHidden()
  await expect(page.getByRole('button', { name: '+ Add links' })).toBeVisible()
})
