import { useCallback, useEffect, useState } from 'react'
import type { DiffFile, Project, RepoRefs } from '@shared/domain'
import { tracker, useTrackerEvent } from '../tracker'
import { DiffViewer } from '../components/DiffViewer'

type DiffSource = { kind: 'working-tree' } | { kind: 'refs'; base: string; head: string }

export function DiffsTab({ project }: { project: Project }): React.JSX.Element {
  const [source, setSource] = useState<DiffSource>({ kind: 'working-tree' })
  const [refs, setRefs] = useState<RepoRefs | null>(null)
  const [files, setFiles] = useState<DiffFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    const request =
      source.kind === 'working-tree'
        ? tracker.invoke('getWorkingTreeDiff', project.id)
        : tracker.invoke('getRefDiff', project.id, source.base, source.head)
    request
      .then((diff) => {
        setFiles(diff.files)
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [project.id, source])

  useEffect(load, [load])
  useEffect(() => {
    tracker.invoke('listRefs', project.id).then(setRefs).catch(console.error)
  }, [project.id])

  useTrackerEvent(
    'diff-changed',
    useCallback(
      (payload: { projectId: string }) => {
        if (payload.projectId === project.id) load()
      },
      [project.id, load]
    )
  )

  const compareToDefault = (): void => {
    if (!refs?.defaultBranch || !refs.currentBranch) return
    setSource({ kind: 'refs', base: refs.defaultBranch, head: refs.currentBranch })
  }

  return (
    <div className="diffs-tab">
      <div className="toolbar">
        <button
          className={`chip ${source.kind === 'working-tree' ? 'active' : ''}`}
          onClick={() => setSource({ kind: 'working-tree' })}
        >
          Working tree
        </button>
        {refs?.defaultBranch && refs.currentBranch && refs.defaultBranch !== refs.currentBranch && (
          <button className={`chip ${source.kind === 'refs' ? 'active' : ''}`} onClick={compareToDefault}>
            {refs.currentBranch} vs {refs.defaultBranch}
          </button>
        )}
        {refs && (
          <span className="ref-pickers">
            <RefSelect
              refs={refs}
              value={source.kind === 'refs' ? source.base : ''}
              placeholder="base"
              onChange={(base) =>
                setSource((prev) => ({
                  kind: 'refs',
                  base,
                  head: prev.kind === 'refs' ? prev.head : (refs.currentBranch ?? base)
                }))
              }
            />
            …
            <RefSelect
              refs={refs}
              value={source.kind === 'refs' ? source.head : ''}
              placeholder="head"
              onChange={(head) =>
                setSource((prev) => ({
                  kind: 'refs',
                  base: prev.kind === 'refs' ? prev.base : (refs.defaultBranch ?? head),
                  head
                }))
              }
            />
          </span>
        )}
        <button className="refresh" onClick={load} title="Refresh diff">
          ↻ Refresh
        </button>
      </div>
      {error ? (
        <div className="error-text">{error}</div>
      ) : files === null ? (
        <div className="empty-state">Loading diff…</div>
      ) : (
        <DiffViewer files={files} />
      )}
    </div>
  )
}

function RefSelect({
  refs,
  value,
  placeholder,
  onChange
}: {
  refs: RepoRefs
  value: string
  placeholder: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <select value={value} onChange={(e) => e.target.value && onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      <optgroup label="Branches">
        {refs.branches.map((b) => (
          <option key={`b-${b}`} value={b}>
            {b}
          </option>
        ))}
      </optgroup>
      {refs.tags.length > 0 && (
        <optgroup label="Tags">
          {refs.tags.map((t) => (
            <option key={`t-${t}`} value={t}>
              {t}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}
