import { existsSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { simpleGit } from 'simple-git'
import type { SimpleGit } from 'simple-git'
import type { DiffFile, RepoRefs, WorkingTreeArea } from '@shared/domain'
import { parseUnifiedDiff, syntheticAddedFile } from '../git/parseDiff'

const DIFF_ARGS = ['--no-color', '--no-ext-diff', '-M']

export interface RepoStatus {
  branch: string | null
  dirty: boolean
  changedFileCount: number
}

/** Local git operations via simple-git (D6). All methods take the repo path. */
export class GitService {
  private git(repoPath: string): SimpleGit {
    return simpleGit({ baseDir: repoPath })
  }

  async isGitRepo(path: string): Promise<boolean> {
    if (!existsSync(path)) return false
    try {
      return await this.git(path).checkIsRepo()
    } catch {
      return false
    }
  }

  /**
   * Absolute path of the working-tree root containing `path` (the directory
   * holding `.git`), in platform separators. Rejects when `path` is not
   * inside a git repository.
   */
  async repoRoot(path: string): Promise<string> {
    const raw = await this.git(path).revparse(['--show-toplevel'])
    return normalize(raw.trim())
  }

  /** owner/repo of the first GitHub remote, if any. */
  async detectGithubRemote(repoPath: string): Promise<{ owner: string; repo: string } | null> {
    const remotes = await this.git(repoPath).getRemotes(true)
    for (const remote of remotes) {
      const url = remote.refs.fetch || remote.refs.push
      const parsed = parseGithubUrl(url)
      if (parsed) return parsed
    }
    return null
  }

  async status(repoPath: string): Promise<RepoStatus> {
    const status = await this.git(repoPath).status()
    return {
      branch: status.current ?? null,
      dirty: !status.isClean(),
      changedFileCount: status.files.length
    }
  }

  /** Unstaged + staged + untracked changes, each labeled with its area. */
  async workingTreeDiff(repoPath: string): Promise<DiffFile[]> {
    const git = this.git(repoPath)
    const [unstagedRaw, stagedRaw, status] = await Promise.all([
      git.diff(DIFF_ARGS),
      git.diff([...DIFF_ARGS, '--cached']),
      git.status()
    ])
    const files: DiffFile[] = [
      ...parseUnifiedDiff(stagedRaw, 'staged'),
      ...parseUnifiedDiff(unstagedRaw, 'unstaged')
    ]
    for (const untracked of status.not_added) {
      files.push(this.readUntrackedFile(repoPath, untracked))
    }
    return files
  }

  async refDiff(repoPath: string, base: string, head: string): Promise<DiffFile[]> {
    const raw = await this.git(repoPath).diff([...DIFF_ARGS, base, head])
    return parseUnifiedDiff(raw, null)
  }

  async listRefs(repoPath: string): Promise<RepoRefs> {
    const git = this.git(repoPath)
    const [branchSummary, tags, status] = await Promise.all([git.branchLocal(), git.tags(), git.status()])
    return {
      currentBranch: status.current ?? null,
      defaultBranch: await this.defaultBranch(git, branchSummary.all),
      branches: branchSummary.all,
      tags: tags.all
    }
  }

  private async defaultBranch(git: SimpleGit, localBranches: string[]): Promise<string | null> {
    try {
      const head = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'])
      const name = head.trim().replace(/^origin\//, '')
      if (name) return name
    } catch {
      // origin/HEAD not set; fall through to conventional names
    }
    for (const candidate of ['main', 'master']) {
      if (localBranches.includes(candidate)) return candidate
    }
    return null
  }

  private readUntrackedFile(repoPath: string, relPath: string): DiffFile {
    // Never open asar archives: in a packaged app Electron's patched fs
    // caches the archive handle forever, locking the file on Windows.
    if (/\.asar$/i.test(relPath)) return syntheticAddedFile(relPath, null)
    const abs = join(repoPath, relPath)
    try {
      const buf = readFileSync(abs)
      if (isBinary(buf)) return syntheticAddedFile(relPath, null)
      return syntheticAddedFile(relPath, buf.toString('utf8'))
    } catch {
      return syntheticAddedFile(relPath, '')
    }
  }
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function parseGithubUrl(url: string | undefined): { owner: string; repo: string } | null {
  if (!url) return null
  const m = /^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
    url.trim()
  )
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

export type { WorkingTreeArea }
