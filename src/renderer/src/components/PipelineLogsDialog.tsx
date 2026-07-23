import { useEffect, useState } from 'react'
import type { PipelineKind, PipelineLogs } from '@shared/domain'
import { tracker } from '../tracker'

interface Props {
  projectId: string
  pipeline: PipelineKind
  runId: string
  title: string
  onClose: () => void
}

/** Modal that fetches and displays one pipeline run's build/deploy logs on demand. */
export function PipelineLogsDialog({ projectId, pipeline, runId, title, onClose }: Props): React.JSX.Element {
  const [logs, setLogs] = useState<PipelineLogs | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The dialog only renders while inspecting one run and unmounts on close
  // (see PipelinesTab), so a fresh mount is the only time this needs to load.
  useEffect(() => {
    let cancelled = false
    tracker
      .invoke('getPipelineLogs', projectId, pipeline, runId)
      .then((result) => {
        if (!cancelled) setLogs(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, pipeline, runId])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Logs · {title}</h2>
        {error && <p className="error-text">{error}</p>}
        {!error && logs === null && <p className="muted">Loading logs…</p>}
        {logs && (
          <>
            {logs.lines.length === 0 ? (
              <p className="empty-state">No logs captured for this run.</p>
            ) : (
              <pre className="log-lines">
                {logs.lines.map((line, i) => (
                  <div key={i} className={`log-line log-${line.stream}`}>
                    {line.text}
                  </div>
                ))}
              </pre>
            )}
            <p className="muted">
              <a href={logs.externalUrl} target="_blank" rel="noreferrer">
                View full logs externally ↗
              </a>
            </p>
          </>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
