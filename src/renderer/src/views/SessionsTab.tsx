import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project, SessionPermissionMode, SessionSummary, TranscriptItem } from '@shared/domain'
import { formatRelativeTime, tracker, useTrackerEvent } from '../tracker'

const MODES: Array<{ id: SessionPermissionMode; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'auto', label: 'Auto' }
]

const STATE_LABEL: Record<SessionSummary['state'], string> = {
  idle: 'idle',
  running: 'running',
  'awaiting-input': 'awaiting input',
  'permission-prompt': 'permission needed'
}

export function SessionsTab({ project }: { project: Project }): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [starting, setStarting] = useState(false)

  const load = useCallback(() => {
    tracker.invoke('listSessions', project.id).then(setSessions).catch(console.error)
  }, [project.id])
  useEffect(load, [load])

  useTrackerEvent(
    'session-updated',
    useCallback(
      (summary: SessionSummary) => {
        if (summary.projectId !== project.id) return
        setSessions((prev) => {
          if (!prev) return prev
          const idx = prev.findIndex((s) => s.id === summary.id)
          const next = idx === -1 ? [summary, ...prev] : prev.map((s) => (s.id === summary.id ? summary : s))
          return next
        })
      },
      [project.id]
    )
  )

  if (sessions === null) return <div className="empty-state">Loading sessions…</div>

  const visible = sessions.filter((s) => (showArchived ? s.archived : !s.archived))
  const selected = sessions.find((s) => s.id === selectedId) ?? null

  return (
    <div className="sessions-tab">
      <aside className="session-list">
        <div className="toolbar">
          <button className="primary" onClick={() => setStarting(true)}>
            + New session
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            archived
          </label>
        </div>
        {visible.length === 0 && (
          <div className="empty-state">
            {showArchived ? 'No archived sessions.' : 'No Claude sessions found for this project yet.'}
          </div>
        )}
        {visible.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={session.id === selectedId}
            onSelect={() => setSelectedId(session.id)}
          />
        ))}
      </aside>
      <section className="session-detail">
        {selected ? (
          <SessionDetail project={project} session={selected} />
        ) : (
          <div className="empty-state">Select a session to view its transcript.</div>
        )}
      </section>
      {starting && (
        <StartSessionDialog
          onClose={() => setStarting(false)}
          onStart={async (prompt, mode) => {
            const summary = await tracker.invoke('startSession', project.id, prompt, mode)
            setStarting(false)
            setSelectedId(summary.id)
            load()
          }}
        />
      )}
    </div>
  )
}

function SessionRow({
  session,
  active,
  onSelect
}: {
  session: SessionSummary
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const needsAttention = session.state === 'awaiting-input' || session.state === 'permission-prompt'
  return (
    <button className={`session-row ${active ? 'active' : ''}`} onClick={onSelect}>
      <div className="session-row-title">
        {session.pinned && <span title="Pinned">📌 </span>}
        {session.title ?? session.summary ?? session.id.slice(0, 8)}
      </div>
      <div className="session-row-meta muted">
        <span className={`badge session-${session.state} ${needsAttention ? 'attention' : ''}`}>
          {STATE_LABEL[session.state]}
        </span>
        {session.origin === 'managed' && session.mode && <span className="badge">{session.mode}</span>}
        {session.liveExternal && <span className="badge live-external">live in terminal</span>}
        <span>{formatRelativeTime(session.lastActivityAt)}</span>
        <span>{session.messageCount} msgs</span>
      </div>
    </button>
  )
}

function SessionDetail({
  project,
  session
}: {
  project: Project
  session: SessionSummary
}): React.JSX.Element {
  const [items, setItems] = useState<TranscriptItem[] | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    tracker
      .invoke('getTranscript', project.id, session.id)
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [project.id, session.id])
  useEffect(load, [load])

  useTrackerEvent(
    'transcript-appended',
    useCallback(
      (payload: { projectId: string; sessionId: string; items: TranscriptItem[] }) => {
        if (payload.sessionId !== session.id) return
        setItems((prev) => (prev ? [...prev, ...payload.items] : payload.items))
      },
      [session.id]
    )
  )
  // Discovered sessions update via storage watcher; refetch on any update to this session.
  useTrackerEvent(
    'session-updated',
    useCallback(
      (summary: SessionSummary) => {
        if (summary.id === session.id && summary.origin === 'discovered') load()
      },
      [session.id, load]
    )
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items])

  const act = (fn: () => Promise<unknown>): void => {
    setError(null)
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  const send = (): void => {
    const text = message.trim()
    if (!text) return
    act(async () => {
      await tracker.invoke('respondToSession', project.id, session.id, text)
      setMessage('')
    })
  }

  const canControl = session.origin === 'managed'
  const viewOnly = session.liveExternal

  return (
    <div className="session-detail-inner">
      <div className="session-toolbar">
        <div className="session-mode">
          Mode:
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`chip ${session.mode === m.id ? 'active' : ''}`}
              disabled={!canControl}
              title={canControl ? '' : 'Respond first to resume this session, then modes become available'}
              onClick={() => act(() => tracker.invoke('setSessionMode', project.id, session.id, m.id))}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="session-actions">
          {canControl && session.state === 'running' && (
            <button onClick={() => act(() => tracker.invoke('interruptSession', project.id, session.id))}>
              ⏸ Interrupt
            </button>
          )}
          <button
            onClick={() =>
              act(() => tracker.invoke('curateSession', project.id, session.id, { pinned: !session.pinned }))
            }
          >
            {session.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button onClick={() => setRenaming(true)}>Rename</button>
          <button
            onClick={() =>
              act(() =>
                tracker.invoke('curateSession', project.id, session.id, { archived: !session.archived })
              )
            }
          >
            {session.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </div>

      {session.state === 'permission-prompt' && (
        <div className="permission-banner">
          This session is waiting for permission to use a tool.
          <button
            className="primary"
            onClick={() => act(() => tracker.invoke('respondToPermission', project.id, session.id, true))}
          >
            Allow
          </button>
          <button
            onClick={() => act(() => tracker.invoke('respondToPermission', project.id, session.id, false))}
          >
            Deny
          </button>
        </div>
      )}
      {viewOnly && (
        <div className="info-banner">
          This session is live in another terminal and is view-only until that process ends.
        </div>
      )}

      <div className="transcript" ref={scrollRef}>
        {items === null && <div className="empty-state">Loading transcript…</div>}
        {items?.map((item, i) => (
          <TranscriptEntry key={i} item={item} />
        ))}
        {items?.length === 0 && <div className="empty-state">Empty transcript.</div>}
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="respond-box">
        <textarea
          value={message}
          disabled={viewOnly}
          placeholder={viewOnly ? 'Session is controlled elsewhere' : 'Respond to this session…'}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send()
          }}
        />
        <button className="primary" disabled={viewOnly || !message.trim()} onClick={send}>
          Send
        </button>
      </div>

      {renaming && (
        <RenameDialog
          initial={session.title ?? ''}
          onClose={() => setRenaming(false)}
          onSave={(title) =>
            act(async () => {
              await tracker.invoke('curateSession', project.id, session.id, {
                title: title.trim() || null
              })
              setRenaming(false)
            })
          }
        />
      )}
    </div>
  )
}

function TranscriptEntry({ item }: { item: TranscriptItem }): React.JSX.Element {
  if (item.kind === 'tool') {
    return (
      <details className="transcript-item tool">
        <summary>
          🔧 {item.name}
          <span className="muted"> {truncate(item.input, 80)}</span>
        </summary>
        {item.output && <pre>{truncate(item.output, 4000)}</pre>}
      </details>
    )
  }
  const icon = item.kind === 'user' ? '👤' : item.kind === 'assistant' ? '🤖' : 'ℹ'
  return (
    <div className={`transcript-item ${item.kind}`}>
      <span className="transcript-icon">{icon}</span>
      <pre className="transcript-text">{item.text}</pre>
    </div>
  )
}

function StartSessionDialog({
  onClose,
  onStart
}: {
  onClose: () => void
  onStart: (prompt: string, mode: SessionPermissionMode) => Promise<void>
}): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<SessionPermissionMode>('plan')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New agent session</h2>
        <textarea
          autoFocus
          value={prompt}
          placeholder="What should Claude work on?"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="form-row">
          Mode:
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`chip ${mode === m.id ? 'active' : ''}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!prompt.trim()}
            onClick={() =>
              onStart(prompt, mode).catch((err) => setError(err instanceof Error ? err.message : String(err)))
            }
          >
            Start
          </button>
        </div>
      </div>
    </div>
  )
}

function RenameDialog({
  initial,
  onClose,
  onSave
}: {
  initial: string
  onClose: () => void
  onSave: (title: string) => void
}): React.JSX.Element {
  const [title, setTitle] = useState(initial)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Rename session</h2>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Session title"
        />
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSave(title)}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
