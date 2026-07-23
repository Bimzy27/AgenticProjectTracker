import type {
  PipelineKind,
  PipelineLogs,
  PipelineRun,
  PipelineStatusSummary,
  Project,
  RunStatus
} from '@shared/domain'
import { GithubNotConfiguredError } from './GithubClient'
import type { PipelineProvider } from './PipelineProvider'
import { PipelineNotConfiguredError, computeFailureRate } from './PipelineProvider'
import type { ProjectStore } from './ProjectStore'

const DEFAULT_POLL_INTERVAL_MS = 60_000
const MAX_BACKOFF_MS = 30 * 60_000
/** Statuses that should raise a desktop notification on transition. */
const ATTENTION_STATUSES: ReadonlySet<RunStatus> = new Set(['failure', 'action_required'])

/** Errors that mean "this provider isn't ready yet" rather than a poll failure. */
function isNotConfigured(err: unknown): boolean {
  return err instanceof GithubNotConfiguredError || err instanceof PipelineNotConfiguredError
}

interface ProviderPollState {
  etag: string | null
  runs: PipelineRun[]
  /** run id (unique within this provider's kind) -> status we last notified for, to de-duplicate. */
  notified: Map<string, RunStatus>
  /**
   * False until this provider's first successful poll for the project. That
   * snapshot is a baseline, not a transition: runs that were already failing
   * before the app started must not spam notifications on launch.
   */
  baselined: boolean
  backoffMs: number
  nextPollAt: number
  /** Message from this provider's most recent failed poll; null while it succeeds. */
  lastError: string | null
}

interface ProjectPollState {
  providers: Map<PipelineKind, ProviderPollState>
}

export interface PipelineEventSink {
  pipelineUpdated(projectId: string, summary: PipelineStatusSummary, runs: PipelineRun[]): void
  /** Raise a desktop notification for a run needing attention. */
  notifyRun(project: Project, run: PipelineRun): void
}

/**
 * Polls every registered PipelineProvider (GitHub Actions, Vercel
 * deployments, or a future source) for each tracked project, merges their
 * runs into one timeline, and derives a combined status summary including a
 * rolling failure rate. Each provider keeps its own ETag/backoff state so
 * one slow or rate-limited source never blocks another; notifications
 * de-duplicate per provider kind + run id. The first poll of a given
 * provider for a project is a silent baseline so pre-existing failures do
 * not spam the user at startup.
 */
export class PipelineService {
  private readonly state = new Map<string, ProjectPollState>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly providers: PipelineProvider[],
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

  /** All runs across every configured provider for the project, newest first. */
  getRuns(projectId: string): PipelineRun[] {
    return this.mergedRuns(projectId)
  }

  getSummary(projectId: string): PipelineStatusSummary | null {
    const projectState = this.state.get(projectId)
    if (!projectState) return null
    return summarizeWithErrors(this.mergedRuns(projectId), projectState)
  }

  /** Fetch logs for one run; rejects when its provider does not support logs or is not configured. */
  async fetchLogs(projectId: string, pipeline: PipelineKind, runId: string): Promise<PipelineLogs> {
    const project = this.projects.getOrThrow(projectId)
    const provider = this.providers.find((p) => p.kind === pipeline)
    if (!provider?.fetchLogs)
      throw new Error(`The "${pipeline}" pipeline does not support viewing logs here.`)
    return provider.fetchLogs(project, runId)
  }

  /** One scheduler pass: poll every configured provider whose next-poll time has arrived. */
  async tick(now: number = Date.now()): Promise<void> {
    for (const project of this.projects.list()) {
      for (const provider of this.providers) {
        if (!provider.isConfigured(project)) continue
        const providerState = this.providerStateFor(project.id, provider.kind)
        if (now < providerState.nextPollAt) continue
        await this.pollOne(project, provider, providerState, now)
      }
    }
  }

  private async pollOne(
    project: Project,
    provider: PipelineProvider,
    providerState: ProviderPollState,
    now: number
  ): Promise<void> {
    try {
      const result = await provider.poll(project, providerState.etag)
      providerState.backoffMs = 0
      providerState.nextPollAt = now + this.pollIntervalMs
      const hadError = providerState.lastError !== null
      if (result.notModified) {
        providerState.etag = result.etag ?? providerState.etag
        if (hadError) {
          // Recovered from a failing poll without new data; clear the stale error.
          providerState.lastError = null
          this.emit(project)
        }
        return
      }
      providerState.etag = result.etag
      providerState.runs = result.runs
      providerState.lastError = null
      this.raiseNotifications(project, result.runs, providerState)
      this.emit(project)
    } catch (err) {
      if (isNotConfigured(err)) return
      // Back off exponentially per provider on any failure (rate limit, network),
      // and surface it so the UI never waits silently.
      providerState.backoffMs = Math.min(
        Math.max(providerState.backoffMs * 2, this.pollIntervalMs),
        MAX_BACKOFF_MS
      )
      providerState.nextPollAt = now + providerState.backoffMs
      providerState.lastError = err instanceof Error ? err.message : String(err)
      this.emit(project)
    }
  }

  private raiseNotifications(project: Project, runs: PipelineRun[], providerState: ProviderPollState): void {
    const isBaseline = !providerState.baselined
    providerState.baselined = true
    for (const run of runs) {
      if (!ATTENTION_STATUSES.has(run.status)) {
        // A rerun that recovered may fail again later; forget the old notification.
        if (run.status === 'success') providerState.notified.delete(run.id)
        continue
      }
      if (providerState.notified.get(run.id) === run.status) continue
      providerState.notified.set(run.id, run.status)
      // Baseline runs are recorded as seen but stay silent (see ProviderPollState.baselined).
      if (!isBaseline) this.sink.notifyRun(project, run)
    }
  }

  private emit(project: Project): void {
    const projectState = this.state.get(project.id)
    if (!projectState) return
    const summary = summarizeWithErrors(this.mergedRuns(project.id), projectState)
    this.sink.pipelineUpdated(project.id, summary, this.mergedRuns(project.id))
  }

  private mergedRuns(projectId: string): PipelineRun[] {
    const projectState = this.state.get(projectId)
    if (!projectState) return []
    return [...projectState.providers.values()]
      .flatMap((s) => s.runs)
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  }

  private providerStateFor(projectId: string, kind: PipelineKind): ProviderPollState {
    let projectState = this.state.get(projectId)
    if (!projectState) {
      projectState = { providers: new Map() }
      this.state.set(projectId, projectState)
    }
    let providerState = projectState.providers.get(kind)
    if (!providerState) {
      providerState = {
        etag: null,
        runs: [],
        notified: new Map(),
        baselined: false,
        backoffMs: 0,
        nextPollAt: 0,
        lastError: null
      }
      projectState.providers.set(kind, providerState)
    }
    return providerState
  }
}

/** Latest run per (pipeline, name) group decides the overall status. */
export function summarize(runs: PipelineRun[]): PipelineStatusSummary {
  const latestPerGroup = new Map<string, PipelineRun>()
  for (const run of runs) {
    const key = `${run.pipeline}:${run.name}`
    if (!latestPerGroup.has(key)) latestPerGroup.set(key, run)
  }
  const latest = [...latestPerGroup.values()]
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
  const failureRate = computeFailureRate(runs)
  return {
    overall,
    failingRuns: failing.length,
    updatedAt: new Date().toISOString(),
    error: null,
    failureRatePercent: failureRate.percent,
    failureRateSampleSize: failureRate.sampleSize
  }
}

function summarizeWithErrors(runs: PipelineRun[], projectState: ProjectPollState): PipelineStatusSummary {
  const errors = [...projectState.providers.values()]
    .map((s) => s.lastError)
    .filter((e): e is string => e !== null)
  return { ...summarize(runs), error: errors.length > 0 ? errors.join('; ') : null }
}
