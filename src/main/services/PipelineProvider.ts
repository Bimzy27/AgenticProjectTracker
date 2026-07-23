import type { PipelineKind, PipelineLogs, PipelineRun, Project } from '@shared/domain'

/** Result of one poll pass for a single project + provider pair. */
export interface PipelinePoll {
  /** Latest runs; ignored (keep the previous list) when `notModified` is true. */
  runs: PipelineRun[]
  /** Opaque cursor for conditional polling (e.g. an HTTP ETag); null when the provider has none to offer. */
  etag: string | null
  /** True when the provider reported no change since the `prevEtag` passed to poll(). */
  notModified: boolean
}

/**
 * A pluggable pipeline source - GitHub Actions workflow runs, Vercel
 * deployments, or a future provider. PipelineService polls one of these per
 * configured project per tick and merges the results, so a new source plugs
 * in by registering an implementation here without changes to
 * PipelineService, the IPC contract, or the Pipelines tab (mirrors the
 * WidgetProvider pattern used by AnalyticsService).
 */
export interface PipelineProvider {
  readonly kind: PipelineKind
  /** Whether this project has the provider's prerequisites configured (e.g. a linked repo or Vercel project + token). */
  isConfigured(project: Project): boolean
  /** Fetch recent runs; `prevEtag` is whatever this provider last returned for this project (null on the first poll). */
  poll(project: Project, prevEtag: string | null): Promise<PipelinePoll>
  /** Fetch logs for one run of this provider's kind; omitted when the provider cannot supply logs. */
  fetchLogs?(project: Project, runId: string): Promise<PipelineLogs>
}

/**
 * Thrown by a provider's poll()/fetchLogs() when the project-level link is
 * set (isConfigured() true) but an app-wide credential the provider also
 * needs (e.g. an API token) is missing. PipelineService treats this as "not
 * ready yet" rather than a poll failure: it retries silently next tick with
 * no backoff and without surfacing an error on the project's summary.
 */
export class PipelineNotConfiguredError extends Error {
  constructor(message = 'Pipeline provider is not configured') {
    super(message)
  }
}

/** How many of the most recent completed runs the rolling failure rate is computed over. */
const DEFAULT_FAILURE_SAMPLE = 20

/**
 * Rolling failure rate over the most recently completed runs (success or
 * failure only - queued/in-progress/cancelled/neutral runs are not settled
 * attempts, so they are excluded), across every pipeline provider merged
 * together. Generic over PipelineRun, so it keeps working unchanged for any
 * future provider kind; backs the dashboard's build-stability indicator.
 */
export function computeFailureRate(
  runs: readonly PipelineRun[],
  sampleSize: number = DEFAULT_FAILURE_SAMPLE
): { percent: number | null; sampleSize: number } {
  const completed = runs
    .filter((r) => r.status === 'success' || r.status === 'failure')
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, sampleSize)
  if (completed.length === 0) return { percent: null, sampleSize: 0 }
  const failures = completed.filter((r) => r.status === 'failure').length
  return { percent: Math.round((failures / completed.length) * 100), sampleSize: completed.length }
}
