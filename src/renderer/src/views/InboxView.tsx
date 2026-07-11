import { useCallback, useEffect, useState } from 'react'
import type { InboxItem } from '@shared/domain'
import { formatRelativeTime, tracker, useTrackerEvent } from '../tracker'

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  question: 'question',
  permission: 'permission',
  'recovery-exhausted': 'recovery exhausted',
  'step-budget': 'step budget',
  review: 'review',
  interrupted: 'interrupted'
}

interface Props {
  /** Navigate to the owning task or session. */
  onOpen: (projectId: string, target: 'tasks' | 'sessions', focusId: string) => void
}

export function InboxView({ onOpen }: Props): React.JSX.Element {
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    tracker.invoke('listInbox').then(setItems).catch(console.error)
  }, [])
  useTrackerEvent(
    'inbox-changed',
    useCallback((next: InboxItem[]) => setItems(next), [])
  )

  if (items === null) return <div className="empty-state">Loading inbox…</div>

  const act = (fn: () => Promise<unknown>): void => {
    setError(null)
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  return (
    <div className="inbox-view">
      <header className="view-header">
        <h1>Attention inbox</h1>
        <p className="muted">{items.length === 0 ? 'All clear' : `${items.length} waiting`}</p>
      </header>
      {error && <div className="error-text">{error}</div>}
      {items.length === 0 ? (
        <div className="empty-state">Nothing needs you right now. Delegated runs are on their own.</div>
      ) : (
        <div className="inbox-list">
          {items.map((item) => (
            <InboxCard key={item.id} item={item} onOpen={onOpen} onAct={act} />
          ))}
        </div>
      )}
    </div>
  )
}

function InboxCard({
  item,
  onOpen,
  onAct
}: {
  item: InboxItem
  onOpen: Props['onOpen']
  onAct: (fn: () => Promise<unknown>) => void
}): React.JSX.Element {
  const [reply, setReply] = useState('')

  const answer = (): void => {
    if (!item.taskId) return
    const text = reply.trim()
    if (!text) return
    onAct(async () => {
      await tracker.invoke('answerRun', item.projectId, item.taskId!, text)
      setReply('')
    })
  }

  return (
    <div className="inbox-card">
      <div className="inbox-card-header">
        <span className={`badge inbox-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        <span className="inbox-card-origin">
          {item.projectName}
          {item.taskTitle ? ` · ${item.taskTitle}` : ''}
        </span>
        <span className="muted">{formatRelativeTime(item.at)}</span>
      </div>
      <pre className="inbox-card-message">{item.message}</pre>
      <div className="inbox-card-actions">
        {(item.kind === 'question' || item.kind === 'recovery-exhausted' || item.kind === 'step-budget') &&
          item.taskId && (
            <>
              <textarea
                value={reply}
                placeholder={item.kind === 'question' ? 'Answer the agent…' : 'Give direction to continue…'}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) answer()
                }}
              />
              <button className="primary" disabled={!reply.trim()} onClick={answer}>
                Send
              </button>
            </>
          )}
        {item.kind === 'permission' && item.sessionId && (
          <>
            <button
              className="primary"
              onClick={() =>
                onAct(() => tracker.invoke('respondToPermission', item.projectId, item.sessionId!, true))
              }
            >
              Allow
            </button>
            <button
              onClick={() =>
                onAct(() => tracker.invoke('respondToPermission', item.projectId, item.sessionId!, false))
              }
            >
              Deny
            </button>
          </>
        )}
        {item.kind === 'interrupted' && item.taskId && (
          <>
            <button
              className="primary"
              onClick={() => onAct(() => tracker.invoke('resumeRun', item.projectId, item.taskId!))}
            >
              Resume
            </button>
            <button
              className="danger"
              onClick={() => onAct(() => tracker.invoke('stopRun', item.projectId, item.taskId!))}
            >
              Mark failed
            </button>
          </>
        )}
        {item.kind === 'review' && item.taskId && (
          <>
            <button
              className="primary"
              onClick={() => onAct(() => tracker.invoke('acceptTask', item.projectId, item.taskId!))}
            >
              ✓ Accept
            </button>
            <textarea
              value={reply}
              placeholder="Feedback if sending back…"
              onChange={(e) => setReply(e.target.value)}
            />
            <button
              disabled={!reply.trim()}
              onClick={() =>
                onAct(async () => {
                  await tracker.invoke('sendBackTask', item.projectId, item.taskId!, reply.trim())
                  setReply('')
                })
              }
            >
              ↩ Send back
            </button>
          </>
        )}
        {item.taskId && (
          <button onClick={() => onOpen(item.projectId, 'tasks', item.taskId!)}>Open task</button>
        )}
        {item.sessionId && (
          <button onClick={() => onOpen(item.projectId, 'sessions', item.sessionId!)}>Open transcript</button>
        )}
      </div>
    </div>
  )
}
