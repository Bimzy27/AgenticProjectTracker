import { useCallback, useEffect, useState } from 'react'
import type { AboutInfo } from '@shared/domain'
import { tracker } from '../tracker'
import { formatReset, windowLabel } from '../usage'

export function AboutView(): React.JSX.Element {
  const [info, setInfo] = useState<AboutInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    tracker
      .invoke('getAboutInfo')
      .then((next) => {
        setInfo(next)
        setLoadError(null)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])
  useEffect(refresh, [refresh])

  return (
    <div className="settings-view">
      <header className="view-header">
        <h1>About</h1>
      </header>

      <section className="settings-section">
        <h2>Agentic Project Tracker</h2>
        <p>
          Version: <strong>{info ? info.appVersion : '…'}</strong>
        </p>
        <p className="muted">
          Mission control for long running projects: git diffs, Claude agent sessions, CI/CD pipelines, and
          release analytics.
        </p>
      </section>

      <section className="settings-section">
        <h2>Claude usage budget</h2>
        <p className="muted">
          Usage limits of the Claude account this machine is logged in with (the account the Claude CLI uses
          for agent sessions).
        </p>
        {loadError && <p className="error-text">{loadError}</p>}
        {!loadError && info === null && <p>Loading…</p>}
        {info?.usage.status === 'not-logged-in' && (
          <p>
            No Claude account found. Log in with the Claude CLI (<code>claude</code>) to see usage metrics.
          </p>
        )}
        {info?.usage.status === 'error' && (
          <p className="error-text">Could not fetch usage: {info.usage.error}</p>
        )}
        {info?.usage.status === 'ok' && (
          <>
            {info.usage.subscription && (
              <p>
                Plan: <strong>{info.usage.subscription}</strong>
              </p>
            )}
            {info.usage.windows.length === 0 && <p>No usage limits reported for this account.</p>}
            {info.usage.windows.map((window) => (
              <div className="usage-window" key={`${window.kind}-${window.scope ?? ''}`}>
                <div className="usage-window-header">
                  <span>{windowLabel(window)}</span>
                  <span className="muted">
                    {Math.round(window.percent)}% used{formatReset(window.resetsAt)}
                  </span>
                </div>
                <div className="usage-bar-track">
                  <div
                    className={`usage-bar-fill ${window.severity !== 'normal' ? 'usage-bar-warn' : ''}`}
                    style={{ width: `${Math.min(100, Math.max(0, window.percent))}%` }}
                  />
                </div>
              </div>
            ))}
          </>
        )}
        {info && (
          <div className="form-row">
            <button onClick={refresh}>Refresh</button>
            <span className="muted">Fetched {new Date(info.usage.fetchedAt).toLocaleTimeString()}</span>
          </div>
        )}
      </section>
    </div>
  )
}
