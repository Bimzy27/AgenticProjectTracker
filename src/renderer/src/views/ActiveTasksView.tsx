import { useCallback, useEffect, useState } from 'react'
import type { ActiveTaskEntry, ActiveTasksGroup, TaskState } from '@shared/domain'
import { formatRelativeTime, tracker, useTrackerEvent } from '../tracker'

const STATE_LABEL: Partial<Record<TaskState, string>> = {
  queued: 'queued',
  running: 'running',
  'needs-input': 'needs input',
  review: 'review'
}

const ATTENTION_STATES: ReadonlySet<TaskState> = new Set(['needs-input', 'review'])

interface Props {
  /** Open the project's Tasks tab, focused on one task when taskId is given. */
  onOpen: (projectId: string, taskId?: string) => void
}

/** Cross-project monitor of all currently active tasks, grouped per project. */
export function ActiveTasksView({ onOpen }: Props): React.JSX.Element {
  const [groups, setGroups] = useState<ActiveTasksGroup[] | null>(null)

  const load = useCallback(() => {
    tracker.invoke('listActiveTasks').then(setGroups).catch(console.error)
  }, [])
  useEffect(load, [load])
  // The overview is derived from task and run state, so any change refreshes it.
  useTrackerEvent('tasks-changed', load)
  useTrackerEvent('run-updated', load)
  useTrackerEvent('projects-changed', load)

  if (groups === null) return <div className="empty-state">Loading active tasks…</div>

  const taskCount = groups.reduce((sum, group) => sum + group.tasks.length, 0)

  return (
    <div className="active-tasks-view">
      <header className="view-header">
        <h1>Active tasks</h1>
        <p className="muted">
          {taskCount === 0
            ? 'Nothing in flight'
            : `${taskCount} active across ${groups.length} project${groups.length === 1 ? '' : 's'}`}
        </p>
      </header>
      {taskCount === 0 ? (
        <div className="empty-state">
          No active tasks. Delegate a task from a project's Tasks tab and monitor it here.
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.projectId} className="active-project-group">
            <button className="active-project-name linkish" onClick={() => onOpen(group.projectId)}>
              {group.projectName} →
            </button>
            <div className="active-task-list">
              {group.tasks.map((entry) => (
                <ActiveTaskRow
                  key={entry.task.id}
                  entry={entry}
                  onOpen={() => onOpen(group.projectId, entry.task.id)}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

function ActiveTaskRow({ entry, onOpen }: { entry: ActiveTaskEntry; onOpen: () => void }): React.JSX.Element {
  const { task, progressNote, stepsUsed } = entry
  return (
    <button className="active-task-row" onClick={onOpen}>
      <span className={`badge task-${task.state} ${ATTENTION_STATES.has(task.state) ? 'attention' : ''}`}>
        {STATE_LABEL[task.state] ?? task.state}
      </span>
      <span className="active-task-main">
        <span className="active-task-title">{task.title}</span>
        {progressNote && <span className="active-task-note muted">{progressNote}</span>}
      </span>
      <span className="active-task-meta muted">
        {stepsUsed !== null && (
          <span>
            {stepsUsed}/{task.stepBudget} steps
          </span>
        )}
        <span>{formatRelativeTime(task.updatedAt)}</span>
      </span>
    </button>
  )
}
