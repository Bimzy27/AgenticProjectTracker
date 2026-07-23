import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

const VERCEL_TOKEN = 'apt-e2e-fake-vercel-token'
const VERCEL_PROJECT = 'prj_e2e_demo'
const POLL_MS = 500

/** Shape of one Vercel deployment (GET /v6/deployments) the provider consumes. */
interface FakeDeployment {
  uid: string
  name: string
  url: string
  inspectorUrl: string
  created: number
  buildingAt: number
  ready: number
  readyState: string
  target: 'production' | 'staging' | null
  meta: Record<string, string>
}

function makeDeployment(
  uid: string,
  readyState: string,
  target: 'production' | 'staging' | null,
  commitMessage: string,
  createdAt: string
): FakeDeployment {
  const created = Date.parse(createdAt)
  return {
    uid,
    name: 'e2e-demo',
    url: `${uid}.vercel.app`,
    inspectorUrl: `https://vercel.com/e2e/e2e-demo/${uid}`,
    created,
    buildingAt: created,
    ready: created + 45_000,
    readyState,
    target,
    meta: {
      githubCommitSha: `${uid}abc0000000000000000000000000000000000000`.slice(0, 40),
      githubCommitMessage: commitMessage,
      githubCommitRef: 'main'
    }
  }
}

let app: ElectronApplication
let page: Page
let userData: string
let claudeHome: string
let repo: string
let vercelServer: Server
let vercelApi: string
/** Mutable fake Vercel state; each poll returns the current contents. */
let deployments: FakeDeployment[] = []

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'apt-e2e-vercel-data-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'apt-e2e-vercel-claude-'))
  repo = mkdtempSync(join(tmpdir(), 'apt-e2e-vercel-repo-'))

  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'E2E')
  writeFileSync(join(repo, 'hello.ts'), 'export const greeting = "hello"\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  // Fake Vercel API behind the APT_VERCEL_API seam: deployments list and
  // per-deployment build events (logs), both requiring the bearer token.
  vercelServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${VERCEL_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid token' } }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v6/deployments' && url.searchParams.get('projectId') === VERCEL_PROJECT) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deployments }))
      return
    }
    const eventsMatch = /^\/v3\/deployments\/([^/]+)\/events$/.exec(url.pathname)
    if (eventsMatch) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          { type: 'command', created: 1, date: 1, text: '$ npm run build' },
          { type: 'stdout', created: 2, date: 2, text: 'Building e2e-demo…' },
          { type: 'stderr', created: 3, date: 3, text: `Error: build failed for ${eventsMatch[1]}` }
        ])
      )
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  await new Promise<void>((resolve) => vercelServer.listen(0, '127.0.0.1', resolve))
  vercelApi = `http://127.0.0.1:${(vercelServer.address() as AddressInfo).port}`

  deployments = [
    makeDeployment('dpl1', 'READY', 'production', 'feat: ship it', '2026-07-01T10:00:00Z'),
    // A null target is a preview deployment (Vercel has no explicit "preview" enum value).
    makeDeployment('dpl2', 'ERROR', null, 'fix: broken build', '2026-07-02T10:00:00Z')
  ]

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      APT_USER_DATA_DIR: userData,
      APT_CLAUDE_HOME: claudeHome,
      APT_TEST_PICK_DIR: repo,
      APT_VERCEL_API: vercelApi,
      APT_PIPELINE_POLL_MS: String(POLL_MS)
    }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => vercelServer?.close(() => resolve()))
  for (const dir of [userData, claudeHome, repo]) rmSync(dir, { recursive: true, force: true })
})

test('set up a project with a Vercel access token and a linked Vercel project', async () => {
  await page.getByRole('button', { name: '+ Add project' }).click()
  await page.getByRole('button', { name: 'Choose directory…' }).click()
  await page.getByPlaceholder('Project name').fill('Vercel Demo')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Vercel Demo' })).toBeVisible()

  await page.getByRole('button', { name: '⚙ Settings' }).click()
  const vercelSection = page.locator('.settings-section').filter({ hasText: 'Vercel access' })
  await vercelSection.getByPlaceholder('Vercel access token').fill(VERCEL_TOKEN)
  await vercelSection.getByRole('button', { name: 'Save token' }).click()
  await expect(vercelSection.getByText('Token saved to the OS credential vault.')).toBeVisible()

  await page.locator('.sidebar').getByRole('button', { name: 'Vercel Demo' }).click()
  await page.getByRole('button', { name: '+ Link Vercel project' }).click()
  await page.getByLabel('Vercel project ID').fill(VERCEL_PROJECT)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: `✎ Vercel: ${VERCEL_PROJECT}` })).toBeVisible()
})

test('pipelines tab lists Vercel deployments with logs available', async () => {
  await page.getByRole('button', { name: 'Pipelines' }).click()

  const rows = page.locator('.runs-table tbody tr')
  await expect(rows).toHaveCount(2)
  const production = rows.filter({ hasText: 'Production' })
  const preview = rows.filter({ hasText: 'Preview' })
  await expect(production.locator('.badge')).toHaveText('passing')
  await expect(preview.locator('.badge')).toHaveText('failing')
  await expect(production.locator('td').nth(1)).toHaveText('Vercel')
  await expect(production.getByRole('link', { name: 'View on Vercel ↗' })).toHaveAttribute(
    'href',
    'https://vercel.com/e2e/e2e-demo/dpl1'
  )
  await expect(preview.getByRole('button', { name: 'View logs' })).toBeVisible()
})

test('inspecting logs of a failing deployment shows its build output', async () => {
  const preview = page.locator('.runs-table tbody tr').filter({ hasText: 'Preview' })
  await preview.getByRole('button', { name: 'View logs' }).click()

  const modal = page.locator('.modal.modal-wide')
  await expect(modal.getByText('Building e2e-demo…')).toBeVisible()
  await expect(modal.getByText(/Error: build failed for dpl2/)).toBeVisible()
  await expect(modal.getByRole('link', { name: 'View full logs externally ↗' })).toHaveAttribute(
    'href',
    'https://vercel.com/deployments/dpl2'
  )
  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(modal).toHaveCount(0)
})

test('the dashboard shows the rolling build failure rate across pipelines', async () => {
  await page.getByRole('button', { name: '⌂ Dashboard' }).click()
  const card = page.locator('.project-card').filter({ hasText: 'Vercel Demo' })
  // One of the two completed deployments failed: a 50% rolling failure rate over 2 runs.
  await expect(card.getByText(/50% failed \(last 2\)/)).toBeVisible()
})
