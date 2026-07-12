import { useCallback, useEffect, useState } from 'react'
import type { ClaudeUsage } from '@shared/domain'
import { tracker } from '../tracker'
import { formatReset, windowLabel } from '../usage'

/** Background re-fetch cadence; usage budgets drift slowly, so 5 minutes is plenty. */
const REFRESH_INTERVAL_MS = 5 * 60_000
/** On hover, re-fetch only when the shown data is older than this. */
const HOVER_REFRESH_MIN_AGE_MS = 60_000

/** Placeholder count while loading or when no usage data is available. */
const PLACEHOLDER_BARS = [0, 1, 2]

interface SidebarUsageProps {
  /** Invoked when the bars are clicked; the App routes this to the About view. */
  onOpen: () => void
}

/**
 * Compact Claude usage meter for the sidebar: one thin bar per usage-limit
 * window (capped at three), a hover overlay with the full details, and a
 * click-through to the About view. Failure modes never break the sidebar:
 * while loading, logged out, or on fetch errors it renders empty tracks and
 * explains the state in the overlay.
 */
export function SidebarUsage({ onOpen }: SidebarUsageProps): React.JSX.Element {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [showTip, setShowTip] = useState(false)

  const refresh = useCallback(() => {
    tracker
      .invoke('getAboutInfo')
      .then((info) => setUsage(info.usage))
      .catch(console.error)
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const windows = usage?.status === 'ok' ? usage.windows.slice(0, 3) : []

  const handleEnter = (): void => {
    setShowTip(true)
    // Keep the overlay honest without polling aggressively: refresh stale data on hover.
    if (usage && Date.now() - Date.parse(usage.fetchedAt) > HOVER_REFRESH_MIN_AGE_MS) refresh()
  }

  return (
    <div
      className="sidebar-usage"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShowTip(false)}
      onFocus={handleEnter}
      onBlur={() => setShowTip(false)}
    >
      <button className="sidebar-usage-bars" aria-label="Claude usage" onClick={onOpen}>
        {windows.length > 0
          ? windows.map((window) => (
              <span className="usage-bar-track" key={`${window.kind}-${window.scope ?? ''}`}>
                <span
                  className={`usage-bar-fill ${window.severity !== 'normal' ? 'usage-bar-warn' : ''}`}
                  style={{ width: `${Math.min(100, Math.max(0, window.percent))}%` }}
                />
              </span>
            ))
          : PLACEHOLDER_BARS.map((i) => <span className="usage-bar-track" key={i} />)}
      </button>
      {showTip && (
        <div className="sidebar-usage-tip" role="tooltip">
          <div className="sidebar-usage-tip-title">
            Claude usage
            {usage?.status === 'ok' && usage.subscription ? ` · ${usage.subscription}` : ''}
          </div>
          {usage === null && <div className="muted">Loading usage…</div>}
          {usage?.status === 'not-logged-in' && (
            <div className="muted">No Claude account found. Log in with the Claude CLI.</div>
          )}
          {usage?.status === 'error' && (
            <div className="error-text">Could not fetch usage: {usage.error}</div>
          )}
          {usage?.status === 'ok' && windows.length === 0 && (
            <div className="muted">No usage limits reported for this account.</div>
          )}
          {windows.map((window) => (
            <div className="sidebar-usage-tip-row" key={`${window.kind}-${window.scope ?? ''}`}>
              <span>{windowLabel(window)}</span>
              <span className="muted">
                {Math.round(window.percent)}% used{formatReset(window.resetsAt)}
              </span>
            </div>
          ))}
          <div className="sidebar-usage-tip-footer muted">Click for details</div>
        </div>
      )}
    </div>
  )
}
