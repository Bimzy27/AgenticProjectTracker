import { useState } from 'react'
import type { Project } from '@shared/domain'
import { tracker } from '../tracker'

/**
 * Modal editor for the project's linked Vercel project (id/name + optional
 * team id), used to poll Vercel deployments on the Pipelines tab. Saving
 * replaces the link via updateProject; clearing both fields unlinks it.
 */
export function ProjectVercelDialog({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.JSX.Element {
  const [projectId, setProjectId] = useState(project.vercel?.projectId ?? '')
  const [teamId, setTeamId] = useState(project.vercel?.teamId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const trimmedId = projectId.trim()
      const vercel = trimmedId ? { projectId: trimmedId, teamId: teamId.trim() || null } : null
      await tracker.invoke('updateProject', project.id, { vercel })
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
        <h2>Vercel project</h2>
        <p className="muted">
          Link this project to a Vercel project to see its deployments and inspect build logs on the Pipelines
          tab. Configure a Vercel access token in Settings first.
        </p>
        <div className="form-row">
          <input
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="prj_… or the project name"
            aria-label="Vercel project ID"
          />
        </div>
        <div className="form-row">
          <input
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            placeholder="Team ID (optional, for team projects)"
            aria-label="Vercel team ID"
          />
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
