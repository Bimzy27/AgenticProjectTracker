import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function statusBlock(state: string, note: string): string {
  return `\`\`\`apt-status\n{ "state": "${state}", "note": "${note}" }\n\`\`\``
}

/**
 * ADR 0004: run history moved from one synchronous monolithic file to
 * debounced, per-run files, with the app's quit sequence delaying shutdown
 * until any pending write lands. This is the acceptance test for that whole
 * chain: it closes and relaunches a real app instance against the same
 * userData dir, proving a run genuinely active at quit time survives.
 */
test('a run active at quit time survives closing and relaunching the app', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'apt-e2e-restart-data-'))
  const claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-restart-claude-'))
  const repo = mkdtempSync(join(tmpdir(), 'apt-e2e-restart-repo-'))
  const scriptPath = join(userData, 'fake-agent-script.json')
  writeFileSync(scriptPath, JSON.stringify({ turns: [] }))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  // Workspace quality-gate skills installed, so the run is workflow-verified.
  mkdirSync(join(claudeHome, 'skills', 'patrol'), { recursive: true })

  const launchOptions = {
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_FAKE_AGENT_SCRIPT: scriptPath,
      // Info-tip hover assertions must not race the physical cursor; see createWindow.
      APT_TEST_IGNORE_OS_MOUSE: '1'
    }
  }

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch(launchOptions)
    let page = await app.firstWindow()

    await page.getByRole('button', { name: '+ Add project' }).click()
    await page.getByRole('button', { name: 'Choose directory…' }).click()
    await page.getByPlaceholder('Project name').fill('Restart Demo')
    await page.getByRole('button', { name: 'Add project', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Restart Demo' })).toBeVisible()

    // One turn reports progress and then the fake agent just waits - the run
    // is still genuinely active when the app quits below.
    writeFileSync(scriptPath, JSON.stringify({ turns: [statusBlock('working', 'reticulating splines')] }))
    await page.locator('.sidebar').getByRole('button', { name: 'Restart Demo' }).click()
    await page.getByRole('button', { name: '+ New task' }).click()
    await page.getByPlaceholder('Task title').fill('Long-running work')
    await page.getByPlaceholder(/What should the agent build/).fill('Do something that outlives a restart')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: 'Delegate to agent' }).click()
    await expect(page.getByText('reticulating splines').first()).toBeVisible()

    // Quit while the run is still active: before-quit must flush the
    // debounced per-run write before the process actually exits.
    await app.close()
    app = undefined

    // Relaunch a fresh instance over the same userData dir, simulating a real restart.
    app = await electron.launch(launchOptions)
    page = await app.firstWindow()

    await page.locator('.sidebar').getByRole('button', { name: 'Restart Demo' }).click()
    await page.locator('.task-row').getByText('Long-running work').click()
    await expect(page.locator('.task-row').getByText('needs input')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Run interrupted' })).toBeVisible()
    await expect(page.getByText('The app was closed while this run was active')).toBeVisible()
    // The progress note from before the restart is still part of the run's history.
    await expect(page.getByText('reticulating splines').first()).toBeVisible()
  } finally {
    await app?.close()
    for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
  }
})
