import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ActivePublishTask,
  Project,
  ReleaseBump,
  ReleasePreview,
  ReleaseTaskSummary,
  TaskDefinition,
  TaskInput,
  TaskState
} from '@shared/domain'
import type { GitService } from './GitService'
import type { TaskService } from './TaskService'

/** Publish tasks are recognised by this title prefix (see buildPublishTaskInput). */
export const PUBLISH_TITLE_PREFIX = 'Publish release '

/** Task states in which an earlier publish task blocks starting another. */
const OPEN_PUBLISH_STATES: ReadonlySet<TaskState> = new Set(['queued', 'running', 'needs-input', 'review'])

/** Commits listed verbatim in the publish briefing before the list is truncated. */
const MAX_BRIEFING_COMMITS = 50

/**
 * Computes what the next release would ship (commits and completed tasks since
 * the last semver release tag) and creates the agent task that publishes it.
 * Suggested versions come from conventional-commit subjects and are advisory:
 * the publishing agent makes the final semver call.
 */
export class ReleaseService {
  constructor(
    private readonly git: GitService,
    private readonly tasks: TaskService
  ) {}

  /** Compute the next-release preview for a project from local git history and the backlog. */
  async getPreview(project: Project): Promise<ReleasePreview> {
    const lastRelease = await this.latestReleaseTag(project.path)
    const commits = await this.git.commitsSince(project.path, lastRelease?.tag ?? null)
    const bump = suggestBump(commits.map((c) => c.subject))
    const nextVersion = lastRelease
      ? bumpVersion(lastRelease.tag, bump)
      : `v${await this.firstVersion(project.path)}`
    return {
      projectId: project.id,
      lastTag: lastRelease?.tag ?? null,
      lastTagAt: lastRelease?.at ?? null,
      nextVersion,
      bump,
      commits,
      completedTasks: this.completedTasksSince(project.id, lastRelease?.at ?? null),
      activePublishTask: this.findActivePublishTask(project.id)
    }
  }

  /**
   * Create the publish task for the current preview. Rejects when nothing is
   * waiting to ship or when a publish task is already in flight; stale draft
   * publish tasks do not block (they are inert until delegated).
   */
  async createPublishTask(project: Project): Promise<TaskDefinition> {
    const preview = await this.getPreview(project)
    if (preview.commits.length === 0) {
      throw new Error('There is nothing to release: no commits since the last release tag')
    }
    const active = preview.activePublishTask
    if (active) {
      throw new Error(`A publish task is already in flight: "${active.title}" (${active.state})`)
    }
    return this.tasks.create(project.id, buildPublishTaskInput(preview))
  }

  /** Newest semver release tag with its commit date; null before the first release. */
  private async latestReleaseTag(repoPath: string): Promise<{ tag: string; at: string } | null> {
    const refs = await this.git.listRefs(repoPath)
    const releaseTags = refs.tags.filter((t) => parseSemverTag(t) !== null)
    if (releaseTags.length === 0) return null
    const tag = releaseTags.reduce((a, b) => (compareSemverTags(a, b) >= 0 ? a : b))
    return { tag, at: await this.git.commitTimestamp(repoPath, tag) }
  }

  /** Tasks completed after `sinceIso` (all done tasks when null), newest first. */
  private completedTasksSince(projectId: string, sinceIso: string | null): ReleaseTaskSummary[] {
    const since = sinceIso === null ? null : Date.parse(sinceIso)
    return this.tasks
      .listTasks(projectId)
      .filter((t) => t.state === 'done')
      .map((t) => ({ taskId: t.id, title: t.title, completedAt: doneAt(t) }))
      .filter((t) => since === null || Date.parse(t.completedAt) > since)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
  }

  private findActivePublishTask(projectId: string): ActivePublishTask | null {
    const task = this.tasks
      .listTasks(projectId)
      .find((t) => t.title.startsWith(PUBLISH_TITLE_PREFIX) && OPEN_PUBLISH_STATES.has(t.state))
    return task ? { taskId: task.id, title: task.title, state: task.state } : null
  }

  /**
   * Version for a project's first release: the repo root package.json version
   * when it is valid semver, otherwise 0.1.0 (mirrors the /github-release
   * skill, which bases the first release on package.json).
   */
  private async firstVersion(repoPath: string): Promise<string> {
    try {
      const root = await this.git.repoRoot(repoPath)
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        version?: unknown
      }
      if (typeof pkg.version === 'string' && parseSemverTag(pkg.version)) return pkg.version
    } catch {
      // No package.json or unparseable: fall back to the conventional first version.
    }
    return '0.1.0'
  }
}

/** Parsed semver release tag; `prefixed` records whether it carried the "v". */
export interface SemverTag {
  major: number
  minor: number
  patch: number
  prefixed: boolean
}

/** Parse a release tag of the form v1.2.3 or 1.2.3; null for anything else. */
export function parseSemverTag(tag: string): SemverTag | null {
  const m = /^(v?)(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  if (!m) return null
  return { prefixed: m[1] === 'v', major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]) }
}

/** Numeric semver order; both tags must parse (guard with parseSemverTag first). */
export function compareSemverTags(a: string, b: string): number {
  const pa = parseSemverTag(a)
  const pb = parseSemverTag(b)
  if (!pa || !pb) throw new Error(`Not a semver tag: ${!pa ? a : b}`)
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch
}

/**
 * Semver bump implied by conventional-commit subjects: a breaking marker
 * ("type!:" or "BREAKING CHANGE") bumps major, any feat bumps minor,
 * everything else bumps patch.
 */
export function suggestBump(subjects: string[]): ReleaseBump {
  let bump: ReleaseBump = 'patch'
  for (const subject of subjects) {
    const m = /^(\w+)(\([^)]*\))?(!)?:/.exec(subject)
    if (m?.[3] || subject.includes('BREAKING CHANGE')) return 'major'
    if (m?.[1] === 'feat') bump = 'minor'
  }
  return bump
}

/** Apply a bump to a release tag, preserving its "v" prefix style. */
export function bumpVersion(lastTag: string, bump: ReleaseBump): string {
  const parsed = parseSemverTag(lastTag)
  if (!parsed) throw new Error(`Not a semver tag: ${lastTag}`)
  const prefix = parsed.prefixed ? 'v' : ''
  switch (bump) {
    case 'major':
      return `${prefix}${parsed.major + 1}.0.0`
    case 'minor':
      return `${prefix}${parsed.major}.${parsed.minor + 1}.0`
    case 'patch':
      return `${prefix}${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
  }
}

/**
 * Briefing for the agent that publishes the release. Runs in "auto" mode:
 * publishing is an explicit user action and shells out constantly (git tag,
 * git push, gh), so per-command permission prompts would stall the run.
 */
export function buildPublishTaskInput(preview: ReleasePreview): TaskInput {
  const lines: string[] = []
  lines.push('Publish the next release of this project.')
  lines.push('')
  lines.push(
    `Suggested version: ${preview.nextVersion} (${preview.bump} bump ` +
      (preview.lastTag ? `from ${preview.lastTag}` : 'for the first release') +
      ', derived from the conventional-commit subjects below). ' +
      'Verify the suggestion against what actually shipped and pick the correct semver version if it is off.'
  )
  lines.push('')
  lines.push(
    'Use the repository release skill (/github-release) when it is installed; otherwise follow the ' +
      'release process documented in this repository. Follow its preflight checks and failure handling ' +
      'exactly, and verify the published release end to end.'
  )
  lines.push('')
  lines.push(preview.lastTag ? `Commits since ${preview.lastTag}:` : 'Commits (first release):')
  for (const commit of preview.commits.slice(0, MAX_BRIEFING_COMMITS)) {
    lines.push(`- ${commit.sha.slice(0, 7)} ${commit.subject}`)
  }
  if (preview.commits.length > MAX_BRIEFING_COMMITS) {
    lines.push(`- … and ${preview.commits.length - MAX_BRIEFING_COMMITS} more`)
  }
  if (preview.completedTasks.length > 0) {
    lines.push('')
    lines.push('Tasks completed since the last release:')
    for (const task of preview.completedTasks) lines.push(`- ${task.title}`)
  }
  return {
    title: `${PUBLISH_TITLE_PREFIX}${preview.nextVersion}`,
    purpose: lines.join('\n'),
    acceptanceCriteria: [
      'The release is published and publicly visible with the expected artifacts attached',
      'The release tag and version follow semver for the changes that shipped',
      'The release pipeline (CI checks and release workflow) completed successfully'
    ],
    mode: 'auto'
  }
}

/** Timestamp of the task's most recent transition to done; falls back to updatedAt. */
function doneAt(task: TaskDefinition): string {
  for (let i = task.transitions.length - 1; i >= 0; i--) {
    if (task.transitions[i].state === 'done') return task.transitions[i].at
  }
  return task.updatedAt
}
