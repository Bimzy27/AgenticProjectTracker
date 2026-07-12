import { useState } from 'react'
import type { Project, ProjectLink } from '@shared/domain'
import { tracker } from '../tracker'

interface Row {
  label: string
  url: string
}

/**
 * Modal editor for a project's important links (label + URL rows).
 * Saving replaces the whole list via updateProject; rows left completely
 * empty are dropped, everything else is validated by the main process.
 */
export function ProjectLinksDialog({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>(
    project.links.length > 0 ? project.links.map((l) => ({ ...l })) : [{ label: '', url: '' }]
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const setRow = (index: number, patch: Partial<Row>): void => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeRow = (index: number): void => {
    setRows((prev) => prev.filter((_, i) => i !== index))
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const links: ProjectLink[] = rows
        .map((row) => ({ label: row.label.trim(), url: row.url.trim() }))
        .filter((row) => row.label !== '' || row.url !== '')
      await tracker.invoke('updateProject', project.id, { links })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Important links</h2>
        <p className="muted">
          Quick links for this project, e.g. the Vercel dashboard or the hosted website. They open in your
          browser.
        </p>

        {rows.length === 0 && <p className="muted">No links. Add one below.</p>}
        {rows.map((row, index) => (
          <div className="link-row" key={index}>
            <input
              value={row.label}
              onChange={(e) => setRow(index, { label: e.target.value })}
              placeholder="Label"
              aria-label="Link label"
              className="link-row-label"
            />
            <input
              value={row.url}
              onChange={(e) => setRow(index, { url: e.target.value })}
              placeholder="https://…"
              aria-label="Link URL"
              className="link-row-url"
            />
            <button title="Remove this link" aria-label="Remove link" onClick={() => removeRow(index)}>
              ✕
            </button>
          </div>
        ))}

        <div className="form-row">
          <button onClick={() => setRows((prev) => [...prev, { label: '', url: '' }])}>+ Add link</button>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save links'}
          </button>
        </div>
      </div>
    </div>
  )
}
