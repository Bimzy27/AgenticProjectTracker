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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function writeSkill(skillsDir: string, folderName: string, body: string): void {
  const dir = join(skillsDir, folderName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body)
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-skills-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-skills-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-skills-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  const globalSkills = join(claudeHome, 'skills')
  writeSkill(
    globalSkills,
    'commit',
    '---\nname: commit\ndescription: Commit and push the current changes.\n---\n\n# Commit\n'
  )
  writeSkill(globalSkills, 'shared-name', '---\nname: shared-name\ndescription: The global version.\n---\n')

  const projectSkills = join(repo, '.claude', 'skills')
  writeSkill(
    projectSkills,
    'repo-only',
    '---\nname: repo-only\ndescription: Lives only in this repository.\n---\n\nFull body text.\n'
  )
  writeSkill(projectSkills, 'shared-name', '---\nname: shared-name\ndescription: The project version.\n---\n')
  writeSkill(projectSkills, 'broken', '---\nname: broken\n---\n\nNo description in frontmatter.\n')

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

  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Skills Demo')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Skills Demo' })).toBeVisible()
  await page.locator('.sidebar').getByRole('button', { name: 'Skills Demo' }).click()
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

test('lists global and project skills in their own lanes', async () => {
  const globalLane = page.locator('.skills-lane', { hasText: 'Global' })
  await expect(globalLane.locator('.skill-node', { hasText: 'commit' })).toBeVisible()
  await expect(
    globalLane.locator('.skill-node', { hasText: 'Commit and push the current changes.' })
  ).toBeVisible()

  const projectLane = page.locator('.skills-lane', { hasText: 'Project' })
  await expect(projectLane.locator('.skill-node', { hasText: 'repo-only' })).toBeVisible()
  await expect(
    projectLane.locator('.skill-node', { hasText: 'Lives only in this repository.' })
  ).toBeVisible()
})

test('flags the project skill shadowed by a same-named global skill', async () => {
  const projectLane = page.locator('.skills-lane', { hasText: 'Project' })
  const shadowedNode = projectLane.locator('.skill-node.shadowed', { hasText: 'shared-name' })
  await expect(shadowedNode).toBeVisible()
  await expect(shadowedNode.locator('.badge', { hasText: 'shadowed' })).toBeVisible()

  const globalLane = page.locator('.skills-lane', { hasText: 'Global' })
  await expect(globalLane.locator('.skill-node.shadowed')).toHaveCount(0)
})

test('shows a warning badge on a skill with incomplete frontmatter instead of dropping it', async () => {
  const brokenNode = page.locator('.skill-node', { hasText: 'broken' })
  await expect(brokenNode).toBeVisible()
  await expect(brokenNode.locator('.badge.attention')).toHaveAttribute(
    'title',
    'Frontmatter is missing description'
  )
})

test('clicking a skill opens its raw SKILL.md source in a modal', async () => {
  await page.locator('.skill-node', { hasText: 'repo-only' }).click()
  const modal = page.locator('.modal', { hasText: 'repo-only' })
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('Full body text.')
  await expect(modal).toContainText('repo-only/SKILL.md')
  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(modal).toHaveCount(0)
})

test('refresh re-scans the skill directories for changes made since the tab loaded', async () => {
  writeSkill(
    join(claudeHome, 'skills'),
    'added-later',
    '---\nname: added-later\ndescription: Installed after the tab first loaded.\n---\n'
  )
  await expect(page.locator('.skill-node', { hasText: 'added-later' })).toHaveCount(0)

  await page.locator('.refresh').click()
  await expect(page.locator('.skill-node', { hasText: 'added-later' })).toBeVisible()
})
