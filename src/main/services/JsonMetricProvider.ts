import type { WidgetData, WidgetKindDescriptor, WidgetPoint, WidgetStat } from '@shared/domain'
import type { WidgetFetchContext, WidgetProvider } from './AnalyticsService'

/** Injectable fetch (D2/testability); production uses the global fetch. */
export type FetchFn = (url: string, init: { headers: Record<string, string> }) => Promise<Response>

/**
 * Generic widget source for any HTTP endpoint that returns JSON: product
 * analytics (e.g. Vercel or Plausible API routes), uptime counters, or your
 * own services. The user points it at a URL and a dot path inside the
 * response; a number renders as a stat tile and an array of dated objects as
 * a timeseries chart. An optional bearer token (stored encrypted via the OS
 * vault) covers authenticated APIs.
 */
export class JsonMetricProvider implements WidgetProvider {
  readonly descriptor: WidgetKindDescriptor = {
    kind: 'json-metric',
    label: 'JSON metric',
    description:
      'Pulls a number or a dated series from any HTTP endpoint that returns JSON - e.g. a Vercel or Plausible API route, or your own service. A number renders as a stat, an array of dated points as a chart.',
    requiresGithub: false,
    configFields: [
      {
        key: 'url',
        label: 'Endpoint URL',
        type: 'url',
        required: true,
        placeholder: 'https://api.example.com/stats',
        help: 'GET endpoint returning JSON.'
      },
      {
        key: 'path',
        label: 'Value path',
        type: 'text',
        required: false,
        placeholder: 'data.visitors',
        help: 'Dot path to the value inside the response; leave empty when the response itself is the value.'
      },
      {
        key: 'unit',
        label: 'Unit',
        type: 'text',
        required: false,
        placeholder: 'views',
        help: 'What the number counts; shown next to values.'
      },
      {
        key: 'dateField',
        label: 'Date field',
        type: 'text',
        required: false,
        placeholder: 'date',
        help: "For series responses: each point's date field. Defaults to date."
      },
      {
        key: 'valueField',
        label: 'Value field',
        type: 'text',
        required: false,
        placeholder: 'value',
        help: "For series responses: each point's number field. Defaults to value."
      },
      {
        key: 'token',
        label: 'Bearer token',
        type: 'secret',
        required: false,
        placeholder: null,
        help: 'Sent as an Authorization: Bearer header. Stored encrypted with the OS credential vault.'
      }
    ]
  }

  constructor(private readonly fetchFn: FetchFn = (url, init) => fetch(url, init)) {}

  async fetch(ctx: WidgetFetchContext): Promise<WidgetData> {
    const url = (ctx.config.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('The endpoint URL must start with http:// or https://')
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = ctx.config.token?.trim()
    if (token) headers.authorization = `Bearer ${token}`

    const response = await this.fetchFn(url, { headers })
    if (response.status === 401 || response.status === 403) {
      return {
        shape: 'unavailable',
        reason: `The endpoint rejected the request (HTTP ${response.status}); check the bearer token.`
      }
    }
    if (!response.ok) throw new Error(`The endpoint answered HTTP ${response.status}`)
    const body = (await response.json()) as unknown

    const path = (ctx.config.path ?? '').trim()
    const value = resolvePath(body, path)
    const unit = (ctx.config.unit ?? '').trim()

    const numeric = asNumber(value)
    if (numeric !== null) return { shape: 'stat', stats: [statOf(numeric, unit)] }
    if (Array.isArray(value)) {
      return {
        shape: 'timeseries',
        unit,
        points: mapSeries(value, ctx.config.dateField, ctx.config.valueField, path)
      }
    }
    throw new Error(`The value at "${path || '(response root)'}" is not a number or an array of points`)
  }
}

/** Walk a dot path ('data.visitors.0.total'); an empty path is the root. */
function resolvePath(body: unknown, path: string): unknown {
  if (path === '') return body
  let current: unknown = body
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      throw new Error(`The response has nothing at "${path}"`)
    }
    current = (current as Record<string, unknown>)[segment]
  }
  if (current === undefined) throw new Error(`The response has nothing at "${path}"`)
  return current
}

/** Numbers and numeric strings count as numbers; everything else does not. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

function statOf(value: number, unit: string): WidgetStat {
  const formatted = Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2)
  return { label: unit || 'Value', value: formatted }
}

/**
 * Map an array of response objects to chart points via the configured field
 * names. Entries without a usable date or number are skipped (tolerant, like
 * session parsing); an array that yields no points at all is a config error
 * worth surfacing.
 */
function mapSeries(
  entries: unknown[],
  dateField: string | undefined,
  valueField: string | undefined,
  path: string
): WidgetPoint[] {
  const dateKey = dateField?.trim() || 'date'
  const valueKey = valueField?.trim() || 'value'
  const points: WidgetPoint[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const date = record[dateKey]
    const value = asNumber(record[valueKey])
    if (typeof date !== 'string' || date === '' || value === null) continue
    points.push({ date, value, details: [] })
  }
  if (entries.length > 0 && points.length === 0) {
    throw new Error(
      `No points found in the array at "${path || '(response root)'}"; check the date and value field names`
    )
  }
  return points
}
