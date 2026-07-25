import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Project, TerminalSnapshot } from '@shared/domain'
import { tracker, useTrackerEvent } from '../tracker'

/** Initial pty size before a mounted pane's fit-to-container resize corrects it. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export function TerminalsTab({ project }: { project: Project }): React.JSX.Element {
  const [terminals, setTerminals] = useState<TerminalSnapshot[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [closing, setClosing] = useState<TerminalSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    tracker
      .invoke('listTerminals', project.id)
      .then((list) => {
        setTerminals(list)
        setActiveId((prev) => prev ?? list[0]?.id ?? null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [project.id])

  useTrackerEvent(
    'terminal-exit',
    useCallback(({ terminalId, exitCode }: { terminalId: string; exitCode: number }) => {
      setTerminals((prev) =>
        prev ? prev.map((t) => (t.id === terminalId ? { ...t, alive: false, exitCode } : t)) : prev
      )
    }, [])
  )

  const createTerminal = (): void => {
    setError(null)
    tracker
      .invoke('createTerminal', project.id, DEFAULT_COLS, DEFAULT_ROWS)
      .then((snapshot) => {
        setTerminals((prev) => [...(prev ?? []), snapshot])
        setActiveId(snapshot.id)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  const doClose = (id: string): void => {
    tracker
      .invoke('closeTerminal', id)
      .then(() => {
        setTerminals((prev) => {
          const next = (prev ?? []).filter((t) => t.id !== id)
          setActiveId((current) => (current === id ? (next[0]?.id ?? null) : current))
          return next
        })
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  const requestClose = (terminal: TerminalSnapshot): void => {
    if (terminal.alive) {
      setClosing(terminal)
      return
    }
    doClose(terminal.id)
  }

  if (terminals === null) return <div className="empty-state">Loading terminals…</div>

  return (
    <div className="terminals-tab">
      <div className="terminal-subtabs">
        {terminals.map((t) => (
          <button
            key={t.id}
            className={`tab terminal-subtab ${t.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
          >
            {t.title}
            {!t.alive && (
              <span className="terminal-subtab-exited" title={`Exited (code ${t.exitCode})`}>
                ●
              </span>
            )}
            <span
              className="terminal-subtab-close"
              role="button"
              title="Close terminal"
              onClick={(e) => {
                e.stopPropagation()
                requestClose(t)
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button className="terminal-new" title="New terminal" onClick={createTerminal}>
          + New terminal
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="terminal-panes">
        {terminals.length === 0 && (
          <div className="empty-state">
            No terminals open for this project. Click "+ New terminal" to start a shell here.
          </div>
        )}
        {terminals.map((t) => (
          <TerminalPane key={t.id} terminal={t} active={t.id === activeId} />
        ))}
      </div>
      {closing && (
        <div className="modal-backdrop" onClick={() => setClosing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Close {closing.title}?</h2>
            <p>Its shell is still running; closing ends the process immediately.</p>
            <div className="modal-actions">
              <button onClick={() => setClosing(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  doClose(closing.id)
                  setClosing(null)
                }}
              >
                Close anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Reads the app's current theme colors from CSS custom properties for xterm's imperative theme option. */
function readXtermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined
  return {
    background: read('--bg-panel'),
    foreground: read('--text'),
    cursor: read('--text'),
    selectionBackground: read('--bg-active')
  }
}

function TerminalPane({
  terminal,
  active
}: {
  terminal: TerminalSnapshot
  active: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Latest alive flag for the onData closure, which is only created once at mount.
  const aliveRef = useRef(terminal.alive)

  useEffect(() => {
    aliveRef.current = terminal.alive
  }, [terminal.alive])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new XTerm({ theme: readXtermTheme(), cursorBlink: true, scrollback: 5000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    xtermRef.current = term
    fitRef.current = fit

    // Replay buffered output once, at attach time; live output arrives via terminal-data.
    if (terminal.buffer) term.write(terminal.buffer)

    fit.fit()
    void tracker.invoke('resizeTerminal', terminal.id, term.cols, term.rows).catch(() => {})

    const dataDisposable = term.onData((data) => {
      if (aliveRef.current) void tracker.invoke('writeToTerminal', terminal.id, data).catch(console.error)
    })

    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      void tracker.invoke('resizeTerminal', terminal.id, term.cols, term.rows).catch(() => {})
    })
    resizeObserver.observe(container)

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = (): void => {
      term.options.theme = readXtermTheme()
    }
    media.addEventListener('change', applyTheme)

    return () => {
      dataDisposable.dispose()
      resizeObserver.disconnect()
      media.removeEventListener('change', applyTheme)
      term.dispose()
    }
    // One xterm instance per terminal id for its whole mounted lifetime; the
    // initial buffer/theme are only ever applied here, at attach time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id])

  useTrackerEvent(
    'terminal-data',
    useCallback(
      (payload: { terminalId: string; chunk: string }) => {
        if (payload.terminalId !== terminal.id) return
        xtermRef.current?.write(payload.chunk)
      },
      [terminal.id]
    )
  )

  useEffect(() => {
    if (active) fitRef.current?.fit()
  }, [active])

  return (
    <div className={`terminal-pane ${active ? 'active' : ''}`}>
      <div className="terminal-surface" ref={containerRef} />
      {!terminal.alive && <div className="terminal-exited-banner">Exited (code {terminal.exitCode})</div>}
    </div>
  )
}
