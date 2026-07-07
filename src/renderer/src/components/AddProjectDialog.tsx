import { useState } from 'react'
import type { DirectoryInspection } from '@shared/domain'
import { tracker } from '../tracker'

/** Registration flow: pick directory, validate, confirm name/repo/tags (task 2.2). */
export function AddProjectDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [inspection, setInspection] = useState<DirectoryInspection | null>(null)
  const [name, setName] = useState('')
  const [tags, setTags] = useState('')
  const [manualRepo, setManualRepo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pick = async (): Promise<void> => {
    setError(null)
    const path = await tracker.invoke('pickProjectDirectory')
    if (!path) return
    const result = await tracker.invoke('inspectDirectory', path)
    setInspection(result)
    setName(result.suggestedName)
    setManualRepo(result.detectedGithub ? `${result.detectedGithub.owner}/${result.detectedGithub.repo}` : '')
    if (!result.isGitRepo) {
      setError('The selected directory is not a git repository. Choose a directory with a .git folder.')
    }
  }

  const submit = async (): Promise<void> => {
    if (!inspection) return
    setBusy(true)
    setError(null)
    try {
      const github = parseRepoSlug(manualRepo)
      if (manualRepo.trim() && !github) {
        throw new Error('GitHub repo must be in owner/repo form')
      }
      await tracker.invoke('addProject', {
        path: inspection.path,
        name,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        github
      })
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
        <h2>Add project</h2>

        <div className="form-row">
          <button onClick={() => void pick()}>Choose directory…</button>
          {inspection && <code className="path">{inspection.path}</code>}
        </div>

        {inspection?.isGitRepo && (
          <>
            <label className="form-row">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
            </label>
            <label className="form-row">
              GitHub repo
              <input
                value={manualRepo}
                onChange={(e) => setManualRepo(e.target.value)}
                placeholder="owner/repo (optional)"
              />
            </label>
            {inspection.detectedGithub === null && manualRepo.trim() === '' && (
              <p className="muted">
                No GitHub remote detected. Pipelines and releases stay unavailable until you link a repo.
              </p>
            )}
            <label className="form-row">
              Categories
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="comma, separated, tags"
              />
            </label>
          </>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!inspection?.isGitRepo || !name.trim() || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </div>
    </div>
  )
}

function parseRepoSlug(slug: string): { owner: string; repo: string } | null {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(slug.trim())
  return m ? { owner: m[1], repo: m[2] } : null
}
