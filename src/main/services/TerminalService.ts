import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import * as nodePty from 'node-pty'
import type { IPty } from 'node-pty'
import type { TerminalSnapshot } from '@shared/domain'

/**
 * Output kept per terminal for replay when a (re)mounted Terminals tab
 * attaches to an already-running shell. A soft cap, not exact scrollback
 * fidelity: trimming from the front can occasionally cut mid-escape-sequence,
 * which a terminal emulator tolerates fine on the next full repaint.
 */
const SCROLLBACK_CAP = 200_000

export interface TerminalEventSink {
  /** `endOffset` is the terminal's total emitted-character count including this chunk. */
  terminalData(terminalId: string, chunk: string, endOffset: number): void
  terminalExit(terminalId: string, exitCode: number): void
}

/** Injectable factory matching node-pty's spawn(); replaced by tests with a fake IPty. */
export type SpawnPty = (
  file: string,
  args: string[],
  options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }
) => IPty

export interface TerminalServiceOptions {
  /**
   * E2E test seam (like APT_CLAUDE_HOME): a path to a Node script run through
   * a real node(.exe) instead of detecting the real shell, so Playwright can
   * assert against deterministic output. Unset uses the real default shell.
   */
  testShellScript?: string
  spawnPty?: SpawnPty
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fileExists?: (path: string) => boolean
}

/** One live or recently-exited PTY-backed shell, owned independent of any renderer view. */
class LiveTerminal {
  readonly id = randomUUID()
  readonly createdAt = new Date().toISOString()
  alive = true
  exitCode: number | null = null
  private buffer = ''
  /**
   * Total characters ever emitted by this shell, never reset by scrollback
   * trimming. Stamped on every data event and on each snapshot, so a pane
   * attaching asynchronously can tell which chunks its replayed buffer
   * already contains and drop them (see TerminalsTab).
   */
  private emitted = 0

  constructor(
    readonly projectId: string,
    private readonly title: string,
    private readonly pty: IPty,
    sink: TerminalEventSink
  ) {
    pty.onData((chunk) => {
      this.append(chunk)
      sink.terminalData(this.id, chunk, this.emitted)
    })
    pty.onExit(({ exitCode }) => {
      this.alive = false
      this.exitCode = exitCode
      sink.terminalExit(this.id, exitCode)
    })
  }

  private append(chunk: string): void {
    this.emitted += chunk.length
    this.buffer += chunk
    if (this.buffer.length > SCROLLBACK_CAP) {
      this.buffer = this.buffer.slice(this.buffer.length - SCROLLBACK_CAP)
    }
  }

  write(data: string): void {
    // A write can race a just-delivered exit event (the renderer hasn't
    // disabled input yet); dropping it is correct, not an error to surface.
    if (this.alive) this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.alive) this.pty.resize(cols, rows)
  }

  kill(): void {
    if (this.alive) this.pty.kill()
  }

  snapshot(): TerminalSnapshot {
    return {
      id: this.id,
      projectId: this.projectId,
      title: this.title,
      createdAt: this.createdAt,
      alive: this.alive,
      exitCode: this.exitCode,
      buffer: this.buffer,
      bufferEndOffset: this.emitted
    }
  }
}

/**
 * Owns every project's terminal instances (design: Terminals tab). Unlike a
 * Session, a terminal is an unmanaged raw shell the app never parses. Each
 * PTY lives here independent of whether any renderer view is currently
 * mounted, so switching tabs or projects does not interrupt it; buffered
 * output lets a (re)mounted view replay what it missed. Terminals do not
 * survive an app restart (see docs/adr/0002), so there is no persistence here.
 */
export class TerminalService {
  private readonly terminals = new Map<string, LiveTerminal>()
  /** Per-project auto-numbering for terminal titles ("Terminal 1", "Terminal 2", …). */
  private readonly titleCounters = new Map<string, number>()
  private readonly spawnPty: SpawnPty
  private readonly testShellScript: string | undefined
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly fileExists: (path: string) => boolean

  constructor(
    private readonly sink: TerminalEventSink,
    options: TerminalServiceOptions = {}
  ) {
    this.spawnPty = options.spawnPty ?? realSpawnPty
    this.testShellScript = options.testShellScript
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.fileExists = options.fileExists ?? existsSync
  }

  /** Spawn a new shell in `cwd`, sized to the given viewport. */
  create(projectId: string, cwd: string, cols: number, rows: number): TerminalSnapshot {
    const { command, args } = this.testShellScript
      ? {
          command: resolveTestShellCommand(this.env, this.platform, this.fileExists),
          args: [this.testShellScript]
        }
      : detectShell(this.env, this.platform, this.fileExists)
    const pty = this.spawnPty(command, args, { cwd, cols, rows, env: this.env })
    const n = (this.titleCounters.get(projectId) ?? 0) + 1
    this.titleCounters.set(projectId, n)
    const terminal = new LiveTerminal(projectId, `Terminal ${n}`, pty, this.sink)
    this.terminals.set(terminal.id, terminal)
    return terminal.snapshot()
  }

  /** Live and recently-exited terminals for a project, each with its buffered output. */
  list(projectId: string): TerminalSnapshot[] {
    return [...this.terminals.values()]
      .filter((terminal) => terminal.projectId === projectId)
      .map((terminal) => terminal.snapshot())
  }

  /**
   * One terminal with its buffer as of now, or null when the id is unknown
   * (it was closed). Lets a pane attaching to an already-running shell replay
   * output produced while nothing was mounted, without re-reading every
   * other terminal's buffer.
   */
  get(id: string): TerminalSnapshot | null {
    return this.terminals.get(id)?.snapshot() ?? null
  }

  /** Send input to a terminal's shell; a no-op for an unknown or already-exited id. */
  write(id: string, data: string): void {
    this.terminals.get(id)?.write(data)
  }

  /** Notify a terminal's shell of a viewport resize; a no-op for an unknown or already-exited id. */
  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.resize(cols, rows)
  }

  /** Kill the shell (if still alive) and forget the terminal. */
  close(id: string): void {
    const terminal = this.terminals.get(id)
    if (!terminal) return
    terminal.kill()
    this.terminals.delete(id)
  }

  /** Kill and forget every terminal belonging to a project (e.g. the project was removed). */
  closeAllForProject(projectId: string): void {
    for (const id of [...this.terminals.values()].filter((t) => t.projectId === projectId).map((t) => t.id)) {
      this.close(id)
    }
  }

  /** Kill and forget every terminal (app quit). */
  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id)
  }
}

/**
 * Default shell to spawn: PowerShell 7 (`pwsh.exe`) when installed, falling
 * back to Windows PowerShell (ships with every supported Windows version), or
 * the user's login shell on other platforms.
 */
function detectShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean
): { command: string; args: string[] } {
  if (platform !== 'win32') {
    return { command: env.SHELL ?? '/bin/bash', args: [] }
  }
  const pwsh = resolveOnWindowsPath('pwsh.exe', env, fileExists)
  if (pwsh) return { command: pwsh, args: [] }
  // node-pty requires a fully-qualified path on Windows (it does not search
  // PATH itself, unlike Unix's execvp), so this can't be the bare
  // "powershell.exe"; Windows PowerShell ships at this fixed path on every
  // supported Windows version.
  const windir = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  return { command: win32.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: [] }
}

/** Scans PATH for `name`, since node-pty needs a fully-qualified path on Windows. */
function resolveOnWindowsPath(
  name: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean
): string | null {
  const dirs = (env.PATH ?? '').split(win32.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = win32.join(dir, name)
    if (fileExists(candidate)) return candidate
  }
  return null
}

/**
 * Resolves a real Node runtime for the APT_TEST_SHELL seam. Electron's own
 * binary (`process.execPath`) can't be used here: on Windows it is a
 * GUI-subsystem executable that ConPTY does not attach stdio to correctly
 * even under ELECTRON_RUN_AS_NODE, so the seam instead requires a real
 * node(.exe) on PATH, which every dev/CI machine running these tests has.
 */
function resolveTestShellCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fileExists: (path: string) => boolean
): string {
  if (platform !== 'win32') return 'node'
  const node = resolveOnWindowsPath('node.exe', env, fileExists)
  if (!node) throw new Error('APT_TEST_SHELL seam requires node.exe on PATH')
  return node
}

const realSpawnPty: SpawnPty = (file, args, options) =>
  nodePty.spawn(file, args, {
    name: 'xterm-color',
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    env: options.env
  })
