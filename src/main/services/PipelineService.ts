import type { PipelineStatusSummary, Project, RunStatus, WorkflowRun } from '@shared/domain'
import type { GithubClient } from './GithubClient'
import { GithubNotConfiguredError } from './GithubClient'
import type { ProjectStore } from './ProjectStore'

const DEFAULT_POLL_INTERVAL_MS = 60_000
const MAX_BACKOFF_MS = 30 * 60_000
/** Statuses that should raise a desktop notification on transition. */
const ATTENTION_STATUSES: ReadonlySet<RunStatus> = new Set(['failure', 'action_required'])

interface GithubWorkflowRun {
  id: number
  name: string | null
  head_branch: string | null
  head_sha: string
  display_title: string
  status: string | null
  conclusion: string | null
  run_started_at: string | null
  updated_at: string
  html_url: string
}

interface RepoPollState {
  etag: string | null
  runs: WorkflowRun[]
  summary: PipelineStatusSummary
  /** run id -> status we last notified for, to de-duplicate notifications. */
  notified: Map<number, RunStatus>
  backoffMs: number
  nextPollAt: number
}

export interface PipelineEventSink {
  pipelineUpdated(projectId: string, summary: PipelineStatusSummary, runs: WorkflowRun[]): void
  /** Raise a desktop notification for a run needing attention. */
  notifyRun(project: Project, run: WorkflowRun): void
}

/**
 * Polls GitHub Actions per tracked repo with ETag conditional requests and
 * per-repo backoff (D5), diffs run states, and notifies on transitions to
 * failure/action_required exactly once per run+status.
 */
export class PipelineService {
  private readonly state = new Map<string, RepoPollState>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly github: GithubClient,
    private readonly projects: ProjectStore,
    private readonly sink: PipelineEventSink,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), Math.min(this.pollIntervalMs, 15_000))
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  getRuns(projectId: string): WorkflowRun[] {
    return this.state.get(projectId)?.runs ?? []
  }

  getSummary(projectId: string): PipelineStatusSummary | null {
    return this.state.get(projectId)?.summary ?? null
  }

  /** One scheduler pass: poll every repo whose next-poll time has arrived. */
  async tick(now: number = Date.now()): Promise<void> {
    if (!this.github.isConfigured()) return
    for (const project of this.projects.list()) {
      if (!project.github) continue
      const repoState = this.stateFor(project.id)
      if (now < repoState.nextPollAt) continue
      await this.pollProject(project, repoState, now)
    }
  }

  private async pollProject(project: Project, repoState: RepoPollState, now: number): Promise<void> {
    const { owner, repo } = project.github!
    try {
      const response = await this.github.conditionalGet<{ workflow_runs: GithubWorkflowRun[] }>(
        '/repos/{owner}/{repo}/actions/runs',
        { owner, repo, per_page: 20 },
        repoState.etag
      )
      repoState.backoffMs = 0
      repoState.nextPollAt = now + this.pollIntervalMs
      const hadError = Boolean(repoState.summary.error)
      if (response.notModified || !response.data) {
        if (hadError) {
          // Recovered from a failing poll without new data; clear the stale error.
          repoState.summary = { ...repoState.summary, error: null }
          this.sink.pipelineUpdated(project.id, repoState.summary, repoState.runs)
        }
        return
      }

      repoState.etag = response.etag
      const runs = response.data.workflow_runs.map(mapRun)
      const summary = { ...summarize(runs), error: null }
      repoState.runs = runs
      repoState.summary = summary
      this.raiseNotifications(project, runs, repoState)
      this.sink.pipelineUpdated(project.id, summary, runs)
    } catch (err) {
      if (err instanceof GithubNotConfiguredError) return
      // Back off exponentially per repo on any API failure (rate limit, network),
      // and surface the failure so the UI never waits silently (task 7.2).
      repoState.backoffMs = Math.min(Math.max(repoState.backoffMs * 2, this.pollIntervalMs), MAX_BACKOFF_MS)
      repoState.nextPollAt = now + repoState.backoffMs
      repoState.summary = {
        ...repoState.summary,
        error: err instanceof Error ? err.message : String(err)
      }
      this.sink.pipelineUpdated(project.id, repoState.summary, repoState.runs)
    }
  }

  private raiseNotifications(project: Project, runs: WorkflowRun[], repoState: RepoPollState): void {
    for (const run of runs) {
      if (!ATTENTION_STATUSES.has(run.status)) {
        // A rerun that recovered may fail again later; forget the old notification.
        if (run.status === 'success') repoState.notified.delete(run.id)
        continue
      }
      if (repoState.notified.get(run.id) === run.status) continue
      repoState.notified.set(run.id, run.status)
      this.sink.notifyRun(project, run)
    }
  }

  private stateFor(projectId: string): RepoPollState {
    let repoState = this.state.get(projectId)
    if (!repoState) {
      repoState = {
        etag: null,
        runs: [],
        summary: { overall: 'unknown', failingRuns: 0, updatedAt: null },
        notified: new Map(),
        backoffMs: 0,
        nextPollAt: 0
      }
      this.state.set(projectId, repoState)
    }
    return repoState
  }
}

export function mapRun(run: GithubWorkflowRun): WorkflowRun {
  return {
    id: run.id,
    workflowName: run.name ?? 'workflow',
    branch: run.head_branch ?? '',
    commitSha: run.head_sha,
    commitMessage: run.display_title,
    status: mapStatus(run.status, run.conclusion),
    startedAt: run.run_started_at,
    durationSeconds:
      run.run_started_at && run.status === 'completed'
        ? Math.max(0, Math.round((Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 1000))
        : null,
    url: run.html_url
  }
}

function mapStatus(status: string | null, conclusion: string | null): RunStatus {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return 'success'
      case 'failure':
      case 'timed_out':
      case 'startup_failure':
        return 'failure'
      case 'cancelled':
        return 'cancelled'
      case 'action_required':
        return 'action_required'
      case 'neutral':
      case 'skipped':
        return 'neutral'
      default:
        return 'unknown'
    }
  }
  if (status === 'queued' || status === 'pending') return 'queued'
  if (status === 'in_progress') return 'in_progress'
  if (status === 'waiting' || status === 'action_required') return 'action_required'
  return 'unknown'
}

export function summarize(runs: WorkflowRun[]): PipelineStatusSummary {
  // Latest run per workflow decides the overall state.
  const latestPerWorkflow = new Map<string, WorkflowRun>()
  for (const run of runs) {
    if (!latestPerWorkflow.has(run.workflowName)) latestPerWorkflow.set(run.workflowName, run)
  }
  const latest = [...latestPerWorkflow.values()]
  const failing = latest.filter((r) => r.status === 'failure' || r.status === 'action_required')
  let overall: RunStatus = 'unknown'
  if (failing.length > 0)
    overall = failing.some((r) => r.status === 'failure') ? 'failure' : 'action_required'
  else if (latest.some((r) => r.status === 'in_progress' || r.status === 'queued')) overall = 'in_progress'
  else if (
    latest.length > 0 &&
    latest.every((r) => r.status === 'success' || r.status === 'neutral' || r.status === 'cancelled')
  )
    overall = 'success'
  return {
    overall,
    failingRuns: failing.length,
    updatedAt: new Date().toISOString()
  }
}
