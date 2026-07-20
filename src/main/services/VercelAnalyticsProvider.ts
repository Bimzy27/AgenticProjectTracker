import type { WidgetData, WidgetKindDescriptor, WidgetPoint } from '@shared/domain'
import type { WidgetFetchContext, WidgetProvider } from './AnalyticsService'
import type { FetchFn } from './JsonMetricProvider'

/** The real Vercel REST API; overridden by tests via the APT_VERCEL_API seam. */
const PRODUCTION_API = 'https://api.vercel.com'

/** Days of history requested, matching the Vercel dashboard's default month view. */
const WINDOW_DAYS = 30

/** Injectable collaborators; production uses the global fetch, the real API, and the wall clock. */
export interface VercelAnalyticsOptions {
  fetchFn?: FetchFn
  apiBase?: string
  now?: () => Date
}

/**
 * First-class Vercel Web Analytics widget source: charts a Vercel project's
 * daily page views (with unique-visitor details) over the last 30 days via
 * `GET /v1/query/web-analytics/visits/aggregate`, so users configure only a
 * project and an access token instead of hand-wiring the generic JSON metric
 * widget. The token is stored encrypted through the standard widget-secret
 * flow. Auth rejections and unresolvable projects (HTTP 400/401/403/404) are
 * expected gaps reported in-band as 'unavailable'; other failures reject.
 */
export class VercelAnalyticsProvider implements WidgetProvider {
  readonly descriptor: WidgetKindDescriptor = {
    kind: 'vercel-analytics',
    label: 'Vercel analytics',
    description:
      'Daily page views and unique visitors from Vercel Web Analytics over the last 30 days. Needs Web Analytics enabled on the Vercel project and a Vercel access token.',
    requiresGithub: false,
    configFields: [
      {
        key: 'projectId',
        label: 'Vercel project',
        type: 'text',
        required: true,
        placeholder: 'prj_… or the project name',
        help: 'The Vercel project ID or name whose Web Analytics to chart.'
      },
      {
        key: 'token',
        label: 'Vercel access token',
        type: 'secret',
        required: true,
        placeholder: null,
        help: 'Created under Vercel account settings; for a team project, scope it to that team. Stored encrypted with the OS credential vault.'
      }
    ]
  }

  private readonly fetchFn: FetchFn
  private readonly apiBase: string
  private readonly now: () => Date

  constructor(options: VercelAnalyticsOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
    this.apiBase = options.apiBase ?? PRODUCTION_API
    this.now = options.now ?? (() => new Date())
  }

  async fetch(ctx: WidgetFetchContext): Promise<WidgetData> {
    const projectId = (ctx.config.projectId ?? '').trim()
    const token = (ctx.config.token ?? '').trim()
    // Saving validates both required fields, but dashboards.json is editable
    // on disk, so a gutted config degrades in-band instead of erroring.
    if (!projectId || !token) {
      return {
        shape: 'unavailable',
        reason: 'Configure the Vercel project and access token on this widget.'
      }
    }

    const until = this.now()
    const since = new Date(until.getTime() - (WINDOW_DAYS - 1) * 86_400_000)
    const params = new URLSearchParams({
      projectId,
      by: 'day',
      since: dayOf(since),
      until: dayOf(until)
    })
    const response = await this.fetchFn(
      `${this.apiBase}/v1/query/web-analytics/visits/aggregate?${params.toString()}`,
      { headers: { accept: 'application/json', authorization: `Bearer ${token}` } }
    )
    if (response.status === 401 || response.status === 403) {
      return {
        shape: 'unavailable',
        reason: `Vercel rejected the request (HTTP ${response.status}); check the access token - a team project needs a token scoped to that team.`
      }
    }
    if (response.status === 400 || response.status === 404) {
      return {
        shape: 'unavailable',
        reason: `Vercel could not resolve the query (HTTP ${response.status}); check the project ID or name and that Web Analytics is enabled for it.`
      }
    }
    if (!response.ok) throw new Error(`Vercel answered HTTP ${response.status}`)

    const body = (await response.json()) as { data?: unknown }
    const rows = Array.isArray(body.data) ? body.data : []
    return { shape: 'timeseries', unit: 'views', points: rows.flatMap(pointOf) }
  }
}

/** The API accepts date strings; day granularity only needs the date part. */
function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Map one aggregate row ({ timestamp, pageviews, visitors }) to a chart point.
 * Rows without a usable timestamp or page-view count are skipped (tolerant,
 * like session parsing); a missing visitors count only drops the detail line.
 */
function pointOf(row: unknown): WidgetPoint[] {
  if (row === null || typeof row !== 'object') return []
  const { timestamp, pageviews, visitors } = row as Record<string, unknown>
  if (typeof timestamp !== 'string' || timestamp === '') return []
  if (typeof pageviews !== 'number' || !Number.isFinite(pageviews)) return []
  const details = typeof visitors === 'number' && Number.isFinite(visitors) ? [`${visitors} unique`] : []
  return [{ date: timestamp, value: pageviews, details }]
}
