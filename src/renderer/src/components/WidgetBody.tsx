import type { ReleaseInfo, WidgetData, WidgetPoint, WidgetStat } from '@shared/domain'

/** Per-widget fetch state kept by the analytics tab. */
export type WidgetResult = 'loading' | { data: WidgetData } | { error: string }

/**
 * Renders any widget's body from its generic data envelope. New sources need
 * no UI work as long as they resolve to one of the WidgetData shapes.
 */
export function WidgetBody({ result }: { result: WidgetResult }): React.JSX.Element {
  if (result === 'loading') return <div className="empty-state">Loading…</div>
  if ('error' in result) return <div className="error-text">{result.error}</div>
  const data = result.data
  switch (data.shape) {
    case 'unavailable':
      return <div className="empty-state">{data.reason}</div>
    case 'stat':
      return <StatTiles stats={data.stats} />
    case 'timeseries':
      return <TimeseriesChart unit={data.unit} points={data.points} />
    case 'releases':
      return data.releases.length === 0 ? (
        <div className="empty-state">No releases exist for this repo yet.</div>
      ) : (
        <div>
          {data.releases.map((release) => (
            <ReleaseCard key={release.tag} release={release} />
          ))}
        </div>
      )
  }
}

/** A row of headline-number tiles (values wear text tokens, not series color). */
function StatTiles({ stats }: { stats: WidgetStat[] }): React.JSX.Element {
  return (
    <div className="stat-tiles">
      {stats.map((stat) => (
        <div className="stat-tile" key={stat.label}>
          <span className="stat-value">{stat.value}</span>
          <span className="stat-label">{stat.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Minimal dependency-free single-series bar chart. Each bar sits in a
 * full-height slot that acts as the hover/focus hit target and carries an
 * in-DOM tooltip with the point's details; native `title` tooltips are
 * unreliable inside Electron and invisible to keyboard users, so the bubble is
 * our own (same pattern as InfoTip and the sidebar usage meter).
 */
function TimeseriesChart({ unit, points }: { unit: string; points: WidgetPoint[] }): React.JSX.Element {
  const max = Math.max(1, ...points.map((p) => p.value))
  const total = points.reduce((sum, p) => sum + p.value, 0)
  if (points.length === 0) return <div className="empty-state">No data.</div>
  return (
    <div className="timeseries-chart">
      <div className="timeseries-total muted">{countLabel(total, unit)} total</div>
      <div className="bars">
        {points.map((p, i) => {
          const label = countLabel(p.value, unit)
          return (
            <div
              key={p.date}
              className={`bar-slot ${tipAlign(i, points.length)}`}
              tabIndex={0}
              aria-label={[`${formatDay(p.date)}: ${label}`, ...p.details].join(', ')}
            >
              <div className="bar" style={{ height: `${Math.max(4, (p.value / max) * 100)}%` }} />
              <div className="bar-tip" role="tooltip">
                <span className="bar-tip-value">{label}</span>
                {p.details.map((detail) => (
                  <span className="bar-tip-detail" key={detail}>
                    {detail}
                  </span>
                ))}
                <span className="bar-tip-detail">{formatDay(p.date)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ReleaseCard({ release }: { release: ReleaseInfo }): React.JSX.Element {
  const totalDownloads = release.assets.reduce((sum, a) => sum + a.downloadCount, 0)
  return (
    <div className="release-card">
      <div className="release-header">
        <h3>
          <a href={release.url} target="_blank" rel="noreferrer">
            {release.name ?? release.tag}
          </a>
          <span className="badge">{release.tag}</span>
        </h3>
        <span className="muted">
          {release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : 'unpublished'} ·{' '}
          {totalDownloads} download{totalDownloads === 1 ? '' : 's'}
        </span>
      </div>
      {release.assets.length > 0 && (
        <table className="assets-table">
          <tbody>
            {release.assets.map((asset) => (
              <tr key={asset.name}>
                <td>{asset.name}</td>
                <td>{formatBytes(asset.sizeBytes)}</td>
                <td>{asset.downloadCount} downloads</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {release.notes && <pre className="release-notes">{truncate(release.notes, 1500)}</pre>}
    </div>
  )
}

/** '42 views' with a naive singular for one ('1 view'); bare number without a unit. */
function countLabel(value: number, unit: string): string {
  if (unit === '') return String(value)
  return `${value} ${value === 1 ? unit.replace(/s$/, '') : unit}`
}

/** Bars in the right third of the chart open their tooltip to the left. */
function tipAlign(index: number, count: number): string {
  return index >= (2 * count) / 3 ? 'bar-tip-end' : ''
}

/** Source timestamps are midnight UTC; format in UTC to keep the day. */
function formatDay(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
