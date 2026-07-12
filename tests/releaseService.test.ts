import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, ReleasePreview } from '../src/shared/domain'
import { GitService } from '../src/main/services/GitService'
import {
  PUBLISH_TITLE_PREFIX,
  ReleaseService,
  buildPublishTaskInput,
  bumpVersion,
  compareSemverTags,
  parseSemverTag,
  suggestBump
} from '../src/main/services/ReleaseService'
import { TaskService } from '../src/main/services/TaskService'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function commit(cwd: string, subject: string): void {
  writeFileSync(join(cwd, 'file.txt'), `${subject}\n${Math.random()}\n`)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', subject)
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'apt-release-'))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  return repo
}

function projectFor(repo: string): Project {
  return { id: 'p1', name: 'Demo', path: repo, tags: [], github: null, links: [], createdAt: '2026-01-01' }
}

describe('ReleaseService.getPreview', () => {
  const dirs: string[] = []
  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  const makeService = (): { service: ReleaseService; tasks: TaskService } => {
    const tasks = new TaskService(tempDir('apt-release-tasks-'), { tasksChanged: () => {} })
    return { service: new ReleaseService(new GitService(), tasks), tasks }
  }

  it('previews the commits and suggested version since the last release tag', async () => {
    const repo = initRepo()
    dirs.push(repo)
    commit(repo, 'feat: first thing')
    git(repo, 'tag', 'v0.1.0')
    commit(repo, 'fix: a bug')
    commit(repo, 'feat: another thing')

    const { service } = makeService()
    const preview = await service.getPreview(projectFor(repo))
    expect(preview.lastTag).toBe('v0.1.0')
    expect(preview.lastTagAt).not.toBeNull()
    expect(preview.commits.map((c) => c.subject)).toEqual(['feat: another thing', 'fix: a bug'])
    expect(preview.bump).toBe('minor')
    expect(preview.nextVersion).toBe('v0.2.0')
    expect(preview.activePublishTask).toBeNull()
  })

  it('credits tasks completed after the last release and excludes older or unfinished ones', async () => {
    const repo = initRepo()
    dirs.push(repo)
    commit(repo, 'feat: first thing')
    git(repo, 'tag', 'v0.1.0')
    commit(repo, 'fix: a bug')

    const { service, tasks } = makeService()
    const done = tasks.create('p1', { title: 'Shipped feature', purpose: 'x', acceptanceCriteria: [] })
    tasks.setState(done.id, 'done')
    tasks.create('p1', { title: 'Still drafting', purpose: 'x', acceptanceCriteria: [] })

    const preview = await service.getPreview(projectFor(repo))
    expect(preview.completedTasks.map((t) => t.title)).toEqual(['Shipped feature'])
  })

  it('excludes tasks completed before the last release was tagged', async () => {
    const repo = initRepo()
    dirs.push(repo)
    commit(repo, 'feat: first thing')

    const { service, tasks } = makeService()
    const old = tasks.create('p1', { title: 'Old work', purpose: 'x', acceptanceCriteria: [] })
    tasks.setState(old.id, 'done')

    // Tag a commit dated after the task completed: the task belongs to that release.
    writeFileSync(join(repo, 'file.txt'), 'future\n')
    git(repo, 'add', '.')
    execFileSync('git', ['commit', '-m', 'chore: future'], {
      cwd: repo,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z',
        GIT_AUTHOR_DATE: '2099-01-01T00:00:00Z'
      }
    })
    git(repo, 'tag', 'v0.1.0')

    const preview = await service.getPreview(projectFor(repo))
    expect(preview.commits).toEqual([])
    expect(preview.completedTasks).toEqual([])
  })

  it('bases the first release on the repo package.json version', async () => {
    const repo = initRepo()
    dirs.push(repo)
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'chore: scaffold')

    const { service } = makeService()
    const preview = await service.getPreview(projectFor(repo))
    expect(preview.lastTag).toBeNull()
    expect(preview.nextVersion).toBe('v1.2.3')
  })

  it('falls back to v0.1.0 for a first release without a package.json', async () => {
    const repo = initRepo()
    dirs.push(repo)
    commit(repo, 'initial')

    const { service } = makeService()
    expect((await service.getPreview(projectFor(repo))).nextVersion).toBe('v0.1.0')
  })

  it('creates one publish task and blocks a second while it is in flight', async () => {
    const repo = initRepo()
    dirs.push(repo)
    commit(repo, 'feat: something')

    const { service, tasks } = makeService()
    const project = projectFor(repo)
    const task = await service.createPublishTask(project)
    expect(task.title).toBe('Publish release v0.1.0')
    expect(task.mode).toBe('auto')
    expect(task.purpose).toContain('feat: something')
    expect(task.purpose).toContain('/github-release')

    // Draft publish tasks are inert and do not block; a queued one does.
    await expect(service.createPublishTask(project)).resolves.toBeDefined()
    tasks.setState(task.id, 'queued')
    await expect(service.createPublishTask(project)).rejects.toThrow(/already in flight/)
    const preview = await service.getPreview(project)
    expect(preview.activePublishTask).toMatchObject({ taskId: task.id, state: 'queued' })
  })

  it('refuses to publish when there is nothing to release', async () => {
    const repo = initRepo()
    dirs.push(repo)
    commit(repo, 'feat: shipped')
    git(repo, 'tag', 'v1.0.0')

    const { service } = makeService()
    await expect(service.createPublishTask(projectFor(repo))).rejects.toThrow(/nothing to release/)
  })
})

describe('semver helpers', () => {
  it('parses release tags with and without the v prefix', () => {
    expect(parseSemverTag('v1.2.3')).toEqual({ prefixed: true, major: 1, minor: 2, patch: 3 })
    expect(parseSemverTag('0.10.0')).toEqual({ prefixed: false, major: 0, minor: 10, patch: 0 })
    expect(parseSemverTag('v1.2')).toBeNull()
    expect(parseSemverTag('release-1')).toBeNull()
    expect(parseSemverTag('v1.2.3-rc.1')).toBeNull()
  })

  it('orders tags numerically, not lexically', () => {
    expect(compareSemverTags('v0.10.0', 'v0.9.1')).toBeGreaterThan(0)
    expect(compareSemverTags('v1.0.0', 'v1.0.0')).toBe(0)
  })

  it('suggests the bump from conventional-commit subjects', () => {
    expect(suggestBump(['fix: x', 'chore: y'])).toBe('patch')
    expect(suggestBump(['fix: x', 'feat: y'])).toBe('minor')
    expect(suggestBump(['feat!: breaking change'])).toBe('major')
    expect(suggestBump(['feat(scope)!: breaking change'])).toBe('major')
    expect(suggestBump(['not conventional at all'])).toBe('patch')
    expect(suggestBump([])).toBe('patch')
  })

  it('bumps versions preserving the prefix style', () => {
    expect(bumpVersion('v1.2.3', 'major')).toBe('v2.0.0')
    expect(bumpVersion('v1.2.3', 'minor')).toBe('v1.3.0')
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4')
  })
})

describe('buildPublishTaskInput', () => {
  const preview: ReleasePreview = {
    projectId: 'p1',
    lastTag: 'v0.1.0',
    lastTagAt: '2026-07-01T00:00:00Z',
    nextVersion: 'v0.2.0',
    bump: 'minor',
    commits: Array.from({ length: 55 }, (_, i) => ({
      sha: `${i}`.padStart(40, '0'),
      subject: `feat: change ${i}`,
      author: 'Test',
      at: '2026-07-02T00:00:00Z'
    })),
    completedTasks: [{ taskId: 't1', title: 'Shipped feature', completedAt: '2026-07-02T00:00:00Z' }],
    activePublishTask: null
  }

  it('builds an auto-mode publish task naming the version, commits, and completed tasks', () => {
    const input = buildPublishTaskInput(preview)
    expect(input.title).toBe(`${PUBLISH_TITLE_PREFIX}v0.2.0`)
    expect(input.mode).toBe('auto')
    expect(input.purpose).toContain('Suggested version: v0.2.0 (minor bump from v0.1.0')
    expect(input.purpose).toContain('feat: change 0')
    expect(input.purpose).toContain('Shipped feature')
    expect(input.acceptanceCriteria.length).toBeGreaterThan(0)
  })

  it('truncates very long commit lists in the briefing', () => {
    const input = buildPublishTaskInput(preview)
    expect(input.purpose).toContain('… and 5 more')
    expect(input.purpose).not.toContain('feat: change 54')
  })
})
