import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStorage } from '../src/main/services/SessionStorage'
import { Watchers } from '../src/main/services/Watchers'
import { repoWatchIgnored } from '../src/main/services/Watchers'
import type { Project } from '../src/shared/domain'

describe('repoWatchIgnored', () => {
  it('watches regular source files and directories', () => {
    expect(repoWatchIgnored('C:\\repo\\src\\app.ts')).toBe(false)
    expect(repoWatchIgnored('/repo/src')).toBe(false)
    expect(repoWatchIgnored('/repo/README.md')).toBe(false)
  })

  it('ignores node_modules anywhere in the tree', () => {
    expect(repoWatchIgnored('C:\\repo\\node_modules')).toBe(true)
    expect(repoWatchIgnored('C:\\repo\\node_modules\\pkg\\index.js')).toBe(true)
    expect(repoWatchIgnored('/repo/packages/a/node_modules/x.js')).toBe(true)
  })

  it('ignores .git internals except HEAD and index', () => {
    expect(repoWatchIgnored('/repo/.git/objects/ab/cdef')).toBe(true)
    expect(repoWatchIgnored('/repo/.git/refs/heads/main')).toBe(true)
    expect(repoWatchIgnored('/repo/.git/HEAD')).toBe(false)
    expect(repoWatchIgnored('/repo/.git/index')).toBe(false)
  })

  it('ignores asar archives so Electron never opens and locks them', () => {
    expect(repoWatchIgnored('C:\\repo\\dist\\win-unpacked\\resources\\app.asar')).toBe(true)
    expect(repoWatchIgnored('/repo/dist/resources/default_app.ASAR')).toBe(true)
    expect(repoWatchIgnored('/repo/src/asar-tools.ts')).toBe(false)
  })
})

describe('Watchers repo watching', () => {
  let repo: string
  let claudeHome: string
  let watchers: Watchers
  let repoChanged: ReturnType<typeof vi.fn<(projectId: string) => void>>

  const project = (): Project => ({
    id: 'p1',
    name: 'Repo',
    path: repo,
    tags: [],
    github: null,
    links: [],
    looping: false,
    createdAt: new Date().toISOString()
  })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'apt-watch-repo-'))
    claudeHome = mkdtempSync(join(tmpdir(), 'apt-watch-home-'))
    repoChanged = vi.fn<(projectId: string) => void>()
    watchers = new Watchers(new SessionStorage(claudeHome), {
      repoChanged,
      sessionsChanged: () => {}
    })
  })

  afterEach(async () => {
    await watchers.close()
    for (const dir of [repo, claudeHome]) rmSync(dir, { recursive: true, force: true })
  })

  it('reports a debounced repoChanged when a file changes', async () => {
    watchers.sync([project()])
    writeFileSync(join(repo, 'app.ts'), 'export {}\n')
    await vi.waitFor(() => expect(repoChanged).toHaveBeenCalledWith('p1'), { timeout: 5000 })
  })

  // On macOS FSEvents may attribute a change to the containing directory,
  // which legitimately fires a refresh; per-file silence is only guaranteed
  // where events carry the file path (Windows) or chokidar filters (Linux).
  it.skipIf(process.platform === 'darwin')(
    'stays silent for asar files so watching never opens them',
    async () => {
      watchers.sync([project()])
      writeFileSync(join(repo, 'app.asar'), 'not really an archive')
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(repoChanged).not.toHaveBeenCalled()
    }
  )
})
