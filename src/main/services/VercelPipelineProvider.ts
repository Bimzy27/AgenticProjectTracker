import type {
  PipelineKind,
  PipelineLogLine,
  PipelineLogs,
  PipelineRun,
  Project,
  RunStatus
} from '@shared/domain'
import type { PipelinePoll, PipelineProvider } from './PipelineProvider'
import { PipelineNotConfiguredError } from './PipelineProvider'
import type { VercelTokenStore } from './VercelTokenStore'

/** The real Vercel REST API; overridden by tests via the APT_VERCEL_API seam. */
const PRODUCTION_API = 'https://api.vercel.com'

/** Recent deployments to fetch per poll, matching the Vercel dashboard's default page size. */
const DEPLOYMENTS_LIMIT = 20

/** Injectable fetch (D2/testability); production uses the global fetch. */
export type FetchFn = (url: string, init: { headers: Record<string, string> }) => Promise<Response>

/** The subset of the deployment object (GET /v6/deployments) this provider reads. */
interface VercelDeployment {
  uid: string
  name: string
  url: string
  inspectorUrl?: string | null
  created: number
  buildingAt?: number
  ready?: number
  readyState: string
  target?: 'production' | 'staging' | null
  meta?: Record<string, unknown>
}

export interface VercelPipelineOptions {
  fetchFn?: FetchFn
  /** API base URL override, injected from the composition root (APT_VERCEL_API test seam); undefined uses the real API. */
  apiBase?: string
}

/**
 * PipelineProvider backed by Vercel deployments (`GET /v6/deployments`) and
 * their build logs (`GET /v3/deployments/{id}/events`). Needs a Vercel access
 * token (VercelTokenStore) and the project's linked Vercel project/team.
 * Vercel's deployments endpoint has no documented ETag support, so unlike
 * GitHub Actions this provider re-fetches in full on every poll.
 */
export class VercelPipelineProvider implements PipelineProvider {
  readonly kind: PipelineKind = 'vercel'

  private readonly fetchFn: FetchFn
  private readonly apiBase: string

  constructor(
    private readonly tokens: VercelTokenStore,
    options: VercelPipelineOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
    this.apiBase = options.apiBase ?? PRODUCTION_API
  }

  isConfigured(project: Project): boolean {
    return project.vercel !== null
  }

  async poll(project: Project, _prevEtag: string | null): Promise<PipelinePoll> {
    const token = this.tokens.getToken()
    if (!token) throw new PipelineNotConfiguredError('No Vercel access token configured')
    if (!project.vercel) return { runs: [], etag: null, notModified: false }
    const params = new URLSearchParams({
      projectId: project.vercel.projectId,
      limit: String(DEPLOYMENTS_LIMIT)
    })
    if (project.vercel.teamId) params.set('teamId', project.vercel.teamId)
    const response = await this.fetchFn(`${this.apiBase}/v6/deployments?${params.toString()}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` }
    })
    if (!response.ok) throw new Error(`Vercel answered HTTP ${response.status} listing deployments`)
    const body = (await response.json()) as { deployments?: unknown }
    const deployments = Array.isArray(body.deployments) ? (body.deployments as VercelDeployment[]) : []
    return { runs: deployments.map(mapDeployment), etag: null, notModified: false }
  }

  async fetchLogs(project: Project, runId: string): Promise<PipelineLogs> {
    const externalUrl = `https://vercel.com/deployments/${runId}`
    const token = this.tokens.getToken()
    if (!token) throw new PipelineNotConfiguredError('No Vercel access token configured')
    const params = new URLSearchParams({ builds: '1' })
    if (project.vercel?.teamId) params.set('teamId', project.vercel.teamId)
    const response = await this.fetchFn(
      `${this.apiBase}/v3/deployments/${encodeURIComponent(runId)}/events?${params.toString()}`,
      { headers: { accept: 'application/json', authorization: `Bearer ${token}` } }
    )
    if (!response.ok) throw new Error(`Vercel answered HTTP ${response.status} fetching logs`)
    const body = (await response.json()) as unknown
    const events = Array.isArray(body) ? body : []
    return { lines: events.flatMap(mapLogEvent), externalUrl }
  }
}

function mapDeployment(d: VercelDeployment): PipelineRun {
  const meta = d.meta ?? {}
  const commitSha = strOf(meta.githubCommitSha) ?? strOf(meta.gitCommitSha) ?? ''
  const commitMessage = strOf(meta.githubCommitMessage) ?? strOf(meta.gitCommitMessage) ?? d.name
  const branch = strOf(meta.githubCommitRef) ?? strOf(meta.gitCommitRef) ?? ''
  const startedAt = d.buildingAt ?? d.created
  const isTerminal = d.readyState === 'READY' || d.readyState === 'ERROR' || d.readyState === 'CANCELED'
  const durationSeconds =
    isTerminal && d.buildingAt && d.ready ? Math.max(0, Math.round((d.ready - d.buildingAt) / 1000)) : null
  return {
    id: d.uid,
    pipeline: 'vercel',
    name: d.target === 'production' ? 'Production' : d.target === 'staging' ? 'Staging' : 'Preview',
    branch,
    commitSha,
    commitMessage,
    status: mapReadyState(d.readyState),
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    durationSeconds,
    url: d.inspectorUrl ?? `https://${d.url}`,
    logsAvailable: true
  }
}

function mapReadyState(state: string): RunStatus {
  switch (state) {
    case 'READY':
      return 'success'
    case 'ERROR':
      return 'failure'
    case 'CANCELED':
      return 'cancelled'
    case 'QUEUED':
      return 'queued'
    case 'BUILDING':
    case 'INITIALIZING':
      return 'in_progress'
    case 'BLOCKED':
      return 'action_required'
    case 'DELETED':
      return 'neutral'
    default:
      return 'unknown'
  }
}

/**
 * Map one deployment event to a log line; only events carrying a `text`
 * payload (stdout/stderr/command/exit/fatal) are worth showing, so anything
 * else (metrics, middleware invocations, delimiters) is skipped tolerantly,
 * the same way session parsing tolerates unknown shapes.
 */
function mapLogEvent(event: unknown): PipelineLogLine[] {
  if (event === null || typeof event !== 'object') return []
  const { type, text, created, date } = event as Record<string, unknown>
  if (typeof text !== 'string' || text === '') return []
  const stream = type === 'stderr' || type === 'fatal' ? 'stderr' : type === 'command' ? 'system' : 'stdout'
  const at = numOf(date) ?? numOf(created)
  return [{ at: at !== null ? new Date(at).toISOString() : null, stream, text }]
}

function strOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
