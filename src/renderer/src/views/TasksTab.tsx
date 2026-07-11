import { useCallback, useEffect, useState } from 'react'
import type {
  Project,
  RunRecord,
  SessionPermissionMode,
  TaskDefinition,
  TaskInput,
  TaskState
} from '@shared/domain'
import { InfoTip } from '../components/InfoTip'
import { formatRelativeTime, tracker, useTrackerEvent } from '../tracker'

const MODES: Array<{ id: SessionPermissionMode; label: string; hint: string }> = [
  { id: 'acceptEdits', label: 'Accept edits', hint: 'File edits are automatic; other tools ask first' },
  { id: 'auto', label: 'Auto', hint: 'All tool use is automatic; for trusted projects' }
]

const STATE_LABEL: Record<TaskState, string> = {
  draft: 'draft',
  queued: 'queued',
  running: 'running',
  'needs-input': 'needs input',
  review: 'review',
  done: 'done',
  failed: 'failed'
}

const ATTENTION_STATES: ReadonlySet<TaskState> = new Set(['needs-input', 'review'])

interface Props {
  project: Project
  /** Pre-select a task, e.g. when navigating from the inbox or a session. */
  initialSelectedId?: string | null
  /** Navigate to the run's session transcript in the Sessions tab. */
  onOpenTranscript: (sessionId: string) => void
}

export function TasksTab({ project, initialSelectedId, onOpenTranscript }: Props): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskDefinition[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const [editing, setEditing] = useState<TaskDefinition | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    tracker.invoke('listTasks', project.id).then(setTasks).catch(console.error)
  }, [project.id])
  useEffect(load, [load])

  useTrackerEvent(
    'tasks-changed',
    useCallback(
      (payload: { projectId: string; tasks: TaskDefinition[] }) => {
        if (payload.projectId === project.id) setTasks(payload.tasks)
      },
      [project.id]
    )
  )

  if (tasks === null) return <div className="empty-state">Loading tasks…</div>

  const selected = tasks.find((t) => t.id === selectedId) ?? null

  const act = (fn: () => Promise<unknown>): void => {
    setError(null)
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  const move = (task: TaskDefinition, direction: -1 | 1): void => {
    const index = tasks.findIndex((t) => t.id === task.id)
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= tasks.length) return
    // Moving down one slot means inserting before the element after the neighbor.
    const beforeId = direction === -1 ? tasks[targetIndex].id : (tasks[targetIndex + 1]?.id ?? null)
    act(() => tracker.invoke('reorderTask', project.id, task.id, beforeId))
  }

  return (
    <div className="tasks-tab">
      <aside className="task-list">
        <div className="toolbar">
          <button className="primary" onClick={() => setEditing('new')}>
            + New task
          </button>
        </div>
        {tasks.length === 0 && (
          <div className="empty-state">
            No tasks yet. Describe what an agent should build, then delegate it.
          </div>
        )}
        {tasks.map((task, index) => (
          <div key={task.id} className={`task-row ${task.id === selectedId ? 'active' : ''}`}>
            <button className="task-row-main" onClick={() => setSelectedId(task.id)}>
              <div className="task-row-title">{task.title}</div>
              <div className="task-row-meta muted">
                <span
                  className={`badge task-${task.state} ${ATTENTION_STATES.has(task.state) ? 'attention' : ''}`}
                >
                  {STATE_LABEL[task.state]}
                </span>
                <span>{formatRelativeTime(task.updatedAt)}</span>
              </div>
            </button>
            <div className="task-row-order">
              <button title="Move up" disabled={index === 0} onClick={() => move(task, -1)}>
                ↑
              </button>
              <button title="Move down" disabled={index === tasks.length - 1} onClick={() => move(task, 1)}>
                ↓
              </button>
            </div>
          </div>
        ))}
      </aside>
      <section className="task-detail">
        {error && <div className="error-text">{error}</div>}
        {selected ? (
          <TaskDetail
            project={project}
            task={selected}
            onEdit={() => setEditing(selected)}
            onAction={act}
            onOpenTranscript={onOpenTranscript}
          />
        ) : (
          <div className="empty-state">Select a task, or create one to delegate to an agent.</div>
        )}
      </section>
      {editing && (
        <TaskDialog
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            if (editing === 'new') {
              const created = await tracker.invoke('createTask', project.id, input)
              setSelectedId(created.id)
            } else {
              await tracker.invoke('updateTask', project.id, editing.id, input)
            }
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function TaskDetail({
  project,
  task,
  onEdit,
  onAction,
  onOpenTranscript
}: {
  project: Project
  task: TaskDefinition
  onEdit: () => void
  onAction: (fn: () => Promise<unknown>) => void
  onOpenTranscript: (sessionId: string) => void
}): React.JSX.Element {
  const [run, setRun] = useState<RunRecord | null>(null)

  const loadRun = useCallback(() => {
    tracker.invoke('getTaskRun', project.id, task.id).then(setRun).catch(console.error)
  }, [project.id, task.id])
  useEffect(loadRun, [loadRun])

  useTrackerEvent(
    'run-updated',
    useCallback(
      (updated: RunRecord) => {
        if (updated.taskId === task.id) setRun(updated)
      },
      [task.id]
    )
  )

  const editable = task.state !== 'running' && task.state !== 'needs-input'

  return (
    <div className="task-detail-inner">
      <div className="task-detail-header">
        <div>
          <h2>{task.title}</h2>
          <div className="task-row-meta muted">
            <span className={`badge task-${task.state}`}>{STATE_LABEL[task.state]}</span>
            <span className="badge">{MODES.find((m) => m.id === task.mode)?.label ?? task.mode}</span>
            {run && !run.workflowVerified && (
              <span className="badge attention" title="Workspace quality-gate skills were not detected">
                unverified workflow
              </span>
            )}
          </div>
        </div>
        <div className="task-detail-actions">
          <button disabled={!editable} onClick={onEdit} title={editable ? '' : 'Stop the run first'}>
            Edit
          </button>
          <button
            className="danger"
            disabled={!editable}
            title={editable ? '' : 'Stop the run first'}
            onClick={() => onAction(() => tracker.invoke('deleteTask', project.id, task.id))}
          >
            Delete
          </button>
        </div>
      </div>

      <section className="task-section">
        <h3>Purpose</h3>
        <p className="task-purpose">{task.purpose}</p>
        {task.acceptanceCriteria.length > 0 && (
          <>
            <h3>Acceptance criteria</h3>
            <ul>
              {task.acceptanceCriteria.map((criterion, i) => (
                <li key={i}>{criterion}</li>
              ))}
            </ul>
          </>
        )}
        {task.reviewFeedback && (
          <>
            <h3>Pending review feedback</h3>
            <p className="task-purpose muted">{task.reviewFeedback}</p>
          </>
        )}
      </section>

      <TaskActions project={project} task={task} run={run} onAction={onAction} />

      {run && <RunPanel run={run} task={task} onOpenTranscript={onOpenTranscript} />}
    </div>
  )
}

function TaskActions({
  project,
  task,
  run,
  onAction
}: {
  project: Project
  task: TaskDefinition
  run: RunRecord | null
  onAction: (fn: () => Promise<unknown>) => void
}): React.JSX.Element | null {
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState('')

  const invoke = (method: 'delegateTask' | 'stopRun' | 'resumeRun' | 'acceptTask') => () =>
    onAction(() => tracker.invoke(method, project.id, task.id))

  switch (task.state) {
    case 'draft':
    case 'failed':
    case 'done':
      return (
        <div className="task-action-bar">
          <button className="primary" onClick={invoke('delegateTask')}>
            {task.state === 'draft' ? 'Delegate to agent' : 'Delegate again'}
          </button>
        </div>
      )
    case 'queued':
      return (
        <div className="task-action-bar">
          <span className="muted">Queued; starts when a run slot is free.</span>
        </div>
      )
    case 'running':
      return (
        <div className="task-action-bar">
          <span className="muted">{run?.progressNote ?? 'The agent is working…'}</span>
          <button className="danger" onClick={invoke('stopRun')}>
            ⏹ Stop run
          </button>
        </div>
      )
    case 'needs-input': {
      const interrupted = run?.state === 'interrupted'
      return (
        <div className="escalation-panel">
          <h3>{interrupted ? 'Run interrupted' : 'The agent needs you'}</h3>
          <pre className="escalation-message">{run?.escalation?.message ?? 'Waiting for input.'}</pre>
          {interrupted ? (
            <div className="task-action-bar">
              <button className="primary" onClick={invoke('resumeRun')}>
                Resume run
              </button>
              <button className="danger" onClick={invoke('stopRun')}>
                Mark failed
              </button>
            </div>
          ) : (
            <>
              <textarea
                value={answer}
                placeholder="Answer or give direction…"
                onChange={(e) => setAnswer(e.target.value)}
              />
              <div className="task-action-bar">
                <button
                  className="primary"
                  disabled={!answer.trim()}
                  onClick={() =>
                    onAction(async () => {
                      await tracker.invoke('answerRun', project.id, task.id, answer.trim())
                      setAnswer('')
                    })
                  }
                >
                  Send answer
                </button>
                <button className="danger" onClick={invoke('stopRun')}>
                  Mark failed
                </button>
              </div>
            </>
          )}
        </div>
      )
    }
    case 'review':
      return (
        <div className="review-panel">
          <h3>Ready for review</h3>
          {run?.completion && (
            <>
              <pre className="escalation-message">{run.completion.summary}</pre>
              <p className="muted">
                Quality gate: {run.completion.gatePassed ? 'reported passing' : 'not verified'}
                {run.completion.gateSummary ? ` · ${run.completion.gateSummary}` : ''}
                {!run.workflowVerified && ' · workspace workflow was not detected on this machine'}
              </p>
            </>
          )}
          <textarea
            value={feedback}
            placeholder="Feedback if sending back…"
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="task-action-bar">
            <button className="primary" onClick={invoke('acceptTask')}>
              ✓ Accept
            </button>
            <button
              disabled={!feedback.trim()}
              onClick={() =>
                onAction(async () => {
                  await tracker.invoke('sendBackTask', project.id, task.id, feedback.trim())
                  setFeedback('')
                })
              }
            >
              ↩ Send back
            </button>
          </div>
        </div>
      )
    default:
      return null
  }
}

function RunPanel({
  run,
  task,
  onOpenTranscript
}: {
  run: RunRecord
  task: TaskDefinition
  onOpenTranscript: (sessionId: string) => void
}): React.JSX.Element {
  return (
    <section className="task-section run-panel">
      <div className="run-panel-header">
        <h3>Latest run</h3>
        <div className="task-row-meta muted">
          <span>
            {run.stepsUsed}/{task.stepBudget} steps
          </span>
          <span>
            {run.nudgesUsed}/{task.recoveryBudget} recoveries
          </span>
          {run.sessionId && (
            <button className="stat linkish" onClick={() => onOpenTranscript(run.sessionId)}>
              Open transcript →
            </button>
          )}
        </div>
      </div>
      <ol className="run-timeline">
        {[...run.events].reverse().map((event, i) => (
          <li key={i} className={`run-event run-event-${event.kind}`}>
            <span className="run-event-kind">{event.kind}</span>
            <span className="run-event-detail">{event.detail || '–'}</span>
            <span className="muted">{formatRelativeTime(event.at)}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function TaskDialog({
  initial,
  onClose,
  onSave
}: {
  initial: TaskDefinition | null
  onClose: () => void
  onSave: (input: TaskInput) => Promise<void>
}): React.JSX.Element {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [purpose, setPurpose] = useState(initial?.purpose ?? '')
  const [criteria, setCriteria] = useState(initial?.acceptanceCriteria.join('\n') ?? '')
  const [mode, setMode] = useState<SessionPermissionMode>(initial?.mode ?? 'acceptEdits')
  const [stepBudget, setStepBudget] = useState(initial?.stepBudget ?? 30)
  const [recoveryBudget, setRecoveryBudget] = useState(initial?.recoveryBudget ?? 3)
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    onSave({
      title,
      purpose,
      acceptanceCriteria: criteria
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean),
      mode,
      stepBudget,
      recoveryBudget
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit task' : 'New task'}</h2>
        <input autoFocus value={title} placeholder="Task title" onChange={(e) => setTitle(e.target.value)} />
        <textarea
          value={purpose}
          placeholder="What should the agent build? Be specific about the goal."
          onChange={(e) => setPurpose(e.target.value)}
        />
        <textarea
          value={criteria}
          placeholder="Acceptance criteria, one per line (optional)"
          onChange={(e) => setCriteria(e.target.value)}
        />
        <div className="form-row">
          Mode{' '}
          <InfoTip text="How much the agent may do without asking. Accept edits approves file changes automatically but asks before other tools run; Auto approves everything and is meant for trusted projects." />
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`chip ${mode === m.id ? 'active' : ''}`}
              title={m.hint}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="form-row">
          <label>
            Step budget{' '}
            <InfoTip text="Maximum agent turns the run may use. When it is exceeded the session is interrupted and the task escalates to your inbox. Raise it for larger tasks." />{' '}
            <input
              type="number"
              min={1}
              value={stepBudget}
              onChange={(e) => setStepBudget(Number(e.target.value))}
            />
          </label>
          <label>
            Recovery budget{' '}
            <InfoTip text="How many corrective retries the loop sends when the agent reports a failure, before giving up and asking you for direction. Questions always reach you immediately without using retries." />{' '}
            <input
              type="number"
              min={0}
              value={recoveryBudget}
              onChange={(e) => setRecoveryBudget(Number(e.target.value))}
            />
          </label>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!title.trim() || !purpose.trim()} onClick={save}>
            {initial ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
