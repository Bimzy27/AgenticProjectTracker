import { useCallback, useEffect, useState } from 'react'
import type { Project, ProjectStatusSummary, ReleasePreview } from '@shared/domain'
import { InfoTip } from '../components/InfoTip'
import { formatRelativeTime, tracker, useTrackerEvent } from '../tracker'

interface Props {
  project: Project
  /** Navigate to the Tasks tab with the publish task selected. */
  onOpenTask: (taskId: string) => void
}

/** Tooltip for the publish button; explains why it is disabled when it is. */
function publishButtonTitle(preview: ReleasePreview, status: ProjectStatusSummary | null): string {
  if (preview.commits.length > 0) {
    return `Delegate publishing ${preview.nextVersion} to an agent (runs in Auto mode)`
  }
  return status?.dirty
    ? 'There are no unreleased commits; commit the pending working-tree changes so they can ship'
    : 'Everything has shipped; there is nothing to release'
}

/**
 * The next release that should be published: pending commits, completed tasks,
 * a suggested version, and the button that delegates publishing to an agent.
 */
export function ReleaseTab({ project, onOpenTask }: Props): React.JSX.Element {
  const [preview, setPreview] = useState<ReleasePreview | null>(null)
  const [status, setStatus] = useState<ProjectStatusSummary | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)

  const load = useCallback(() => {
    tracker
      .invoke('getReleasePreview', project.id)
      .then((p) => {
        setPreview(p)
        setLoadError(null)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
    tracker.invoke('getProjectStatus', project.id).then(setStatus).catch(console.error)
  }, [project.id])
  useEffect(load, [load])

  // New commits change the preview; publish-task state changes move the action panel.
  useTrackerEvent(
    'diff-changed',
    useCallback(
      (payload: { projectId: string }) => {
        if (payload.projectId === project.id) load()
      },
      [project.id, load]
    )
  )
  useTrackerEvent(
    'tasks-changed',
    useCallback(
      (payload: { projectId: string }) => {
        if (payload.projectId === project.id) load()
      },
      [project.id, load]
    )
  )

  if (loadError) return <div className="error-text">{loadError}</div>
  if (preview === null) return <div className="empty-state">Loading release preview…</div>

  const activeTask = preview.activePublishTask

  const publish = (): void => {
    setActionError(null)
    setPublishing(true)
    tracker
      .invoke('publishRelease', project.id)
      .then((task) => onOpenTask(task.id))
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPublishing(false))
  }

  return (
    <div className="release-tab">
      <section>
        <div className="release-next-header">
          <h2>
            Next release <span className="badge release-version">{preview.nextVersion}</span>
            <InfoTip text="Suggested tag for the next release: a semver bump of the last release tag, derived from the conventional-commit subjects waiting to ship (breaking bumps major, feat bumps minor, anything else bumps patch). The publishing agent verifies and may adjust it." />
          </h2>
          <span className="muted">
            {preview.lastTag
              ? `Last release ${preview.lastTag} · tagged ${formatRelativeTime(preview.lastTagAt)}`
              : 'No release has been published yet.'}
          </span>
        </div>

        {actionError && <div className="error-text">{actionError}</div>}

        {activeTask ? (
          <div className="release-publish-panel">
            <span className="muted">
              Publishing is in flight: {activeTask.title} ({activeTask.state.replace('-', ' ')})
            </span>
            <button onClick={() => onOpenTask(activeTask.taskId)}>Open publish task →</button>
          </div>
        ) : (
          <div className="release-publish-panel">
            <button
              className="primary"
              disabled={publishing || preview.commits.length === 0}
              title={publishButtonTitle(preview, status)}
              onClick={publish}
            >
              🚀 Publish release
            </button>
            <span className="muted">
              Delegates publishing to an agent using the repository&apos;s release process.
            </span>
          </div>
        )}
        {status?.dirty && (
          <p className="muted release-dirty-warning">
            {preview.commits.length === 0
              ? '⚠ The working tree has uncommitted changes but no commits are waiting to ship; ' +
                'completed work stays out of the release until it is committed.'
              : '⚠ The working tree has uncommitted changes; the publishing agent will have to deal ' +
                'with them before tagging.'}
          </p>
        )}
      </section>

      <section>
        <h2>
          {preview.lastTag ? `Changes since ${preview.lastTag}` : 'Changes'}
          <InfoTip text="Commits reachable from HEAD that are not part of the last release tag, newest first. These are what the next release ships." />
        </h2>
        {preview.commits.length === 0 ? (
          <div className="empty-state">Everything has shipped; there are no unreleased commits.</div>
        ) : (
          <table className="runs-table release-commits">
            <tbody>
              {preview.commits.map((commit) => (
                <tr key={commit.sha}>
                  <td className="release-commit-sha">{commit.sha.slice(0, 7)}</td>
                  <td>{commit.subject}</td>
                  <td className="muted">{commit.author}</td>
                  <td className="muted">{formatRelativeTime(commit.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>
          Tasks completed
          <InfoTip text="Backlog tasks that reached done after the last release was tagged. They describe, in product terms, what this release delivers." />
        </h2>
        {preview.completedTasks.length === 0 ? (
          <div className="empty-state">No tasks were completed since the last release.</div>
        ) : (
          <ul className="release-task-list">
            {preview.completedTasks.map((task) => (
              <li key={task.taskId}>
                <button className="stat linkish" onClick={() => onOpenTask(task.taskId)}>
                  {task.title}
                </button>
                <span className="muted"> · completed {formatRelativeTime(task.completedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
