import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitService, parseGithubUrl } from '../src/main/services/GitService'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

describe('GitService against a fixture repository', () => {
  let repo: string
  const service = new GitService()

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'apt-git-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'line1\nline2\n')
    writeFileSync(join(repo, 'b.txt'), 'unchanged\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')
    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'a.txt'), 'line1\nchanged\n')
    git(repo, 'commit', '-am', 'change a')
    // working tree state: staged, unstaged, untracked
    writeFileSync(join(repo, 'staged.txt'), 'staged content\n')
    git(repo, 'add', 'staged.txt')
    writeFileSync(join(repo, 'a.txt'), 'line1\nchanged again\n')
    writeFileSync(join(repo, 'untracked.txt'), 'new stuff\n')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('detects a git repository and rejects a plain directory', async () => {
    expect(await service.isGitRepo(repo)).toBe(true)
    const plain = mkdtempSync(join(tmpdir(), 'apt-plain-'))
    expect(await service.isGitRepo(plain)).toBe(false)
    rmSync(plain, { recursive: true, force: true })
  })

  it('reports status with branch, dirty flag, and change count', async () => {
    const status = await service.status(repo)
    expect(status.branch).toBe('feature')
    expect(status.dirty).toBe(true)
    expect(status.changedFileCount).toBe(3)
  })

  it('returns working tree diff covering staged, unstaged, and untracked areas', async () => {
    const files = await service.workingTreeDiff(repo)
    const byPath = Object.fromEntries(files.map((f) => [`${f.area}:${f.path}`, f]))
    expect(byPath['staged:staged.txt']).toMatchObject({ changeType: 'added' })
    expect(byPath['unstaged:a.txt']).toMatchObject({ changeType: 'modified' })
    expect(byPath['untracked:untracked.txt']).toMatchObject({ changeType: 'added', additions: 1 })
  })

  it('diffs two refs', async () => {
    const files = await service.refDiff(repo, 'main', 'feature')
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('a.txt')
    expect(files[0].hunks[0].lines.some((l) => l.kind === 'add' && l.text === 'changed')).toBe(true)
  })

  it('lists refs with current and default branch', async () => {
    const refs = await service.listRefs(repo)
    expect(refs.currentBranch).toBe('feature')
    expect(refs.defaultBranch).toBe('main')
    expect(refs.branches).toContain('main')
    expect(refs.branches).toContain('feature')
  })
})

describe('parseGithubUrl', () => {
  it('parses https, ssh, and git@ remotes', () => {
    expect(parseGithubUrl('https://github.com/me/repo.git')).toEqual({ owner: 'me', repo: 'repo' })
    expect(parseGithubUrl('git@github.com:me/repo.git')).toEqual({ owner: 'me', repo: 'repo' })
    expect(parseGithubUrl('ssh://git@github.com/me/repo')).toEqual({ owner: 'me', repo: 'repo' })
    expect(parseGithubUrl('https://gitlab.com/me/repo.git')).toBeNull()
    expect(parseGithubUrl(undefined)).toBeNull()
  })
})
