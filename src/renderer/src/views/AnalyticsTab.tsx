import { useEffect, useState } from 'react'
import type { GithubAuthState, Project, ReleaseInfo, TrafficMetrics, TrafficPoint } from '@shared/domain'
import { InfoTip } from '../components/InfoTip'
import { tracker } from '../tracker'

export function AnalyticsTab({ project }: { project: Project }): React.JSX.Element {
  const [releases, setReleases] = useState<ReleaseInfo[] | null>(null)
  const [traffic, setTraffic] = useState<TrafficMetrics | null>(null)
  const [auth, setAuth] = useState<GithubAuthState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    tracker.invoke('getGithubAuthState').then(setAuth).catch(console.error)
    if (!project.github) return
    tracker
      .invoke('getReleases', project.id)
      .then(setReleases)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    tracker.invoke('getTraffic', project.id).then(setTraffic).catch(console.error)
  }, [project.id, project.github])

  if (!project.github) {
    return <div className="empty-state">Link a GitHub repo to this project to see releases and usage.</div>
  }
  if (auth && !auth.configured) {
    return <div className="empty-state">Analytics needs a GitHub token. Configure one in Settings.</div>
  }
  if (error) return <div className="error-text">{error}</div>

  return (
    <div className="analytics-tab">
      <section>
        <h2>
          Traffic (last 14 days)
          <InfoTip text="Repository traffic from GitHub. GitHub only retains the most recent 14 days, so longer trends are not available. Requires a token with push access to the repo." />
        </h2>
        {traffic === null ? (
          <div className="empty-state">Loading traffic…</div>
        ) : !traffic.available ? (
          <div className="empty-state">
            Traffic data is unavailable; the token needs push access to this repo.
          </div>
        ) : (
          <div className="traffic-charts">
            <TrafficChart
              title="Views"
              tip="How many times people viewed the repo on GitHub each day. Hover a bar to see that day's views and how many were unique visitors."
              points={traffic.views}
            />
            <TrafficChart
              title="Clones"
              tip="How many times the repo was cloned each day, including clones made by CI systems. Hover a bar to see that day's clones and how many came from unique sources."
              points={traffic.clones}
            />
          </div>
        )}
      </section>

      <section>
        <h2>
          Releases
          <InfoTip text="Published GitHub releases for this repo, newest first. Download counts are lifetime totals per asset - a rough proxy for how many people installed each version." />
        </h2>
        {releases === null ? (
          <div className="empty-state">Loading releases…</div>
        ) : releases.length === 0 ? (
          <div className="empty-state">No releases exist for this repo yet.</div>
        ) : (
          releases.map((release) => <ReleaseCard key={release.tag} release={release} />)
        )}
      </section>
    </div>
  )
}

function ReleaseCard({ release }: { release: ReleaseInfo }): React.JSX.Element {
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

/**
 * Minimal dependency-free bar chart. Each bar sits in a full-height slot that
 * acts as the hover/focus hit target and carries an in-DOM tooltip with the
 * day's details; native `title` tooltips are unreliable inside Electron and
 * invisible to keyboard users, so the bubble is our own (same pattern as
 * InfoTip and the sidebar usage meter).
 */
function TrafficChart({
  title,
  tip,
  points
}: {
  title: string
  tip: string
  points: TrafficPoint[]
}): React.JSX.Element {
  const max = Math.max(1, ...points.map((p) => p.count))
  const total = points.reduce((sum, p) => sum + p.count, 0)
  const unit = title.toLowerCase()
  return (
    <div className="traffic-chart">
      <h3>
        {title} <span className="muted">{total} total</span>
        <InfoTip text={tip} />
      </h3>
      {points.length === 0 ? (
        <div className="empty-state">No data.</div>
      ) : (
        <div className="bars">
          {points.map((p, i) => {
            const count = `${p.count} ${p.count === 1 ? unit.replace(/s$/, '') : unit}`
            return (
              <div
                key={p.date}
                className={`bar-slot ${tipAlign(i, points.length)}`}
                tabIndex={0}
                aria-label={`${formatDay(p.date)}: ${count}, ${p.uniques} unique`}
              >
                <div className="bar" style={{ height: `${Math.max(4, (p.count / max) * 100)}%` }} />
                <div className="bar-tip" role="tooltip">
                  <span className="bar-tip-value">{count}</span>
                  <span className="bar-tip-detail">{p.uniques} unique</span>
                  <span className="bar-tip-detail">{formatDay(p.date)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Bars in the right third of the chart open their tooltip to the left. */
function tipAlign(index: number, count: number): string {
  return index >= (2 * count) / 3 ? 'bar-tip-end' : ''
}

/** GitHub traffic timestamps are midnight UTC; format in UTC to keep the day. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
