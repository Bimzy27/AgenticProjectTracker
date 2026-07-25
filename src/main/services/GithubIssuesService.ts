import type { GithubIssue, GithubRepoRef, Project, TaskDefinition } from '@shared/domain'
import type { GithubClient } from './GithubClient'
import type { TaskService } from './TaskService'

/** The subset of GitHub's issue payload this service reads. */
interface RawGithubIssue {
  number: number
  title: string
  body: string | null
  html_url: string
  user: { login: string } | null
  labels: Array<string | { name?: string | null }>
  updated_at: string
  /** Present (any shape) only when the "issue" is actually a pull request. */
  pull_request?: unknown
}

/** The project's linked repo; every method here requires one. */
function requireRepo(project: Project): GithubRepoRef {
  if (!project.github) throw new Error('Project has no linked GitHub repo')
  return project.github
}

function mapIssue(raw: RawGithubIssue): GithubIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    url: raw.html_url,
    author: raw.user?.login ?? null,
    labels: raw.labels
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter((label) => label !== ''),
    updatedAt: raw.updated_at
  }
}

/** Briefing purpose for a task imported from an issue: its body plus provenance. */
function buildPurpose(issue: GithubIssue): string {
  const body = issue.body?.trim() || '(No description provided on the issue.)'
  return `${body}\n\n---\nImported from GitHub issue #${issue.number}: ${issue.url}`
}

/**
 * Reads open issues from a project's linked GitHub repo and imports them
 * into the task backlog as draft tasks, so triaged GitHub work shows up
 * alongside agent-authored tasks in the Tasks tab. GitHub's "list issues"
 * endpoint also returns pull requests (distinguished only by the presence of
 * a `pull_request` field on the response); those are filtered out since they
 * are not backlog work.
 */
export class GithubIssuesService {
  constructor(
    private readonly github: GithubClient,
    private readonly tasks: TaskService
  ) {}

  /** Open issues (pull requests excluded), most recently updated first. */
  async list(project: Project): Promise<GithubIssue[]> {
    const { owner, repo } = requireRepo(project)
    const issues = await this.github.get<RawGithubIssue[]>('/repos/{owner}/{repo}/issues', {
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 50
    })
    return issues
      .filter((issue) => !('pull_request' in issue))
      .map(mapIssue)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Import one issue as a draft task titled and briefed from the issue.
   * Idempotent: an issue already imported into this project's backlog
   * (matched by GithubIssue.url) returns the existing task instead of
   * creating a duplicate, so re-clicking import or a stale issue list never
   * doubles up the backlog.
   */
  async import(project: Project, issueNumber: number): Promise<TaskDefinition> {
    const { owner, repo } = requireRepo(project)
    const raw = await this.github.get<RawGithubIssue>('/repos/{owner}/{repo}/issues/{issue_number}', {
      owner,
      repo,
      issue_number: issueNumber
    })
    const issue = mapIssue(raw)
    const existing = this.tasks.listTasks(project.id).find((t) => t.sourceIssueUrl === issue.url)
    if (existing) return existing
    return this.tasks.create(project.id, {
      title: issue.title,
      purpose: buildPurpose(issue),
      acceptanceCriteria: [],
      sourceIssueUrl: issue.url
    })
  }
}
