import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  SessionCurationPatch,
  SessionPermissionMode,
  SessionState,
  SessionSummary,
  TranscriptItem
} from '@shared/domain'
import type { ProjectStore } from './ProjectStore'
import type { SessionStorage } from './SessionStorage'

/** A session file touched this recently is assumed live in an external process. */
const LIVE_EXTERNAL_WINDOW_MS = 2 * 60 * 1000

const MODE_TO_SDK: Record<SessionPermissionMode, PermissionMode> = {
  plan: 'plan',
  acceptEdits: 'acceptEdits',
  auto: 'bypassPermissions'
}

interface CurationRecord {
  pinned?: boolean
  title?: string | null
  archived?: boolean
}

export interface SessionEventSink {
  sessionUpdated(summary: SessionSummary): void
  transcriptAppended(projectId: string, sessionId: string, items: TranscriptItem[]): void
}

/** Identifies the task/run that started a session through the run loop. */
export interface SessionOwner {
  taskId: string
  taskTitle: string
  runId: string
}

/** Hooks the run orchestrator uses to supervise an owned session. */
export interface RunSessionObserver {
  /**
   * The agent's turn ended (SDK result message); text is the turn's assistant
   * output and turnTokens the tokens that turn consumed (usage on the result
   * message is per-turn, verified against the live CLI). changedFiles holds
   * the project-relative paths the turn's file-editing tool calls touched.
   */
  turnCompleted(sessionId: string, assistantText: string, turnTokens: number, changedFiles: string[]): void
  stateChanged(sessionId: string, state: SessionState): void
  /** The SDK stream ended; error is null on a clean end. */
  closed(sessionId: string, error: string | null): void
}

/** Injectable factory matching the SDK's query(); replaced by the E2E fake agent seam. */
export type QueryFn = typeof query

/** A live session driven through the Claude Agent SDK (D3 managed sessions). */
class ManagedSession {
  readonly items: TranscriptItem[] = []
  state: SessionState = 'running'
  mode: SessionPermissionMode
  startedAt = new Date().toISOString()
  lastActivityAt = new Date().toISOString()
  /** Session ID reported by the CLI; keys this session in listings. */
  sdkSessionId: string | null = null
  /** Set when the session was started by the run loop for a task. */
  owner: SessionOwner | null = null
  observer: RunSessionObserver | null = null
  private queryHandle: Query | null = null
  private pendingMessages: SDKUserMessage[] = []
  private wakeInput: (() => void) | null = null
  /** FIFO of unanswered permission prompts; the CLI can request several tools in parallel. */
  private pendingPermissions: Array<{ resolve: (allow: boolean) => void; toolName: string }> = []
  private closed = false
  /** Assistant text accumulated within the current turn, for the observer. */
  private turnText: string[] = []
  /** Files touched by the current turn's file-editing tool calls, for the observer. */
  private turnChangedFiles = new Set<string>()
  private lastNotifiedState: SessionState | null = null
  private streamError: string | null = null

  constructor(
    readonly projectId: string,
    readonly localId: string,
    private readonly cwd: string,
    mode: SessionPermissionMode,
    /** Model alias or full id for the session; null inherits the CLI default. */
    private readonly model: string | null,
    private readonly onChange: (session: ManagedSession, newItems: TranscriptItem[]) => void,
    private readonly queryFn: QueryFn
  ) {
    this.mode = mode
  }

  start(initialPrompt: string, resumeSessionId?: string): void {
    this.pushUserMessage(initialPrompt)
    this.queryHandle = this.queryFn({
      prompt: this.inputStream(),
      options: {
        cwd: this.cwd,
        permissionMode: MODE_TO_SDK[this.mode],
        model: this.model ?? undefined,
        resume: resumeSessionId,
        canUseTool: async (toolName, input) => {
          const allow = await new Promise<boolean>((resolve) => {
            this.pendingPermissions.push({ resolve, toolName })
            this.state = 'permission-prompt'
            this.touch([
              { kind: 'system', text: `Permission requested: ${toolName}`, at: new Date().toISOString() }
            ])
          })
          // Parallel tool calls prompt concurrently; stay prompting until all are answered.
          if (this.pendingPermissions.length === 0) this.state = 'running'
          this.touch([])
          return allow
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'Denied from Agentic Project Tracker' }
        }
      }
    })
    void this.consume()
  }

  send(message: string): void {
    if (this.closed) throw new Error('Session has ended')
    this.pushUserMessage(message)
    this.state = 'running'
    this.turnText = []
    this.turnChangedFiles.clear()
    this.touch([{ kind: 'user', text: message, at: new Date().toISOString() }])
  }

  async setMode(mode: SessionPermissionMode): Promise<void> {
    if (!this.queryHandle) throw new Error('Session not started')
    await this.queryHandle.setPermissionMode(MODE_TO_SDK[mode])
    this.mode = mode
    // Switching to a more permissive mode implicitly answers pending prompts.
    if (mode === 'acceptEdits' || mode === 'auto') {
      while (this.pendingPermissions.length > 0) {
        this.pendingPermissions.shift()!.resolve(true)
      }
    }
    this.touch([])
  }

  /** Answer the oldest pending permission prompt. */
  respondToPermission(allow: boolean): void {
    const pending = this.pendingPermissions.shift()
    if (!pending) throw new Error('No pending permission prompt')
    pending.resolve(allow)
  }

  async interrupt(): Promise<void> {
    await this.queryHandle?.interrupt()
    this.state = 'awaiting-input'
    this.touch([])
  }

  get hasPendingPermission(): boolean {
    return this.pendingPermissions.length > 0
  }

  get pendingPermissionToolName(): string | null {
    return this.pendingPermissions[0]?.toolName ?? null
  }

  get isClosed(): boolean {
    return this.closed
  }

  private pushUserMessage(text: string): void {
    this.pendingMessages.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId ?? ''
    })
    this.wakeInput?.()
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.pendingMessages.length > 0) {
        yield this.pendingMessages.shift()!
      }
      await new Promise<void>((resolve) => {
        this.wakeInput = resolve
      })
      this.wakeInput = null
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.queryHandle!) {
        this.handleSdkMessage(message)
      }
    } catch (err) {
      this.streamError = err instanceof Error ? err.message : String(err)
      this.touch([
        { kind: 'system', text: `Session error: ${this.streamError}`, at: new Date().toISOString() }
      ])
    } finally {
      this.closed = true
      this.state = 'idle'
      this.wakeInput?.()
      this.touch([])
      this.observer?.closed(this.localId, this.streamError)
    }
  }

  private handleSdkMessage(message: SDKMessage): void {
    if ('session_id' in message && message.session_id) this.sdkSessionId = message.session_id
    const at = new Date().toISOString()
    const newItems: TranscriptItem[] = []

    let turnEnded = false
    let turnTokens = 0
    if (message.type === 'assistant') {
      for (const part of message.message.content) {
        if (part.type === 'text' && part.text.trim()) {
          newItems.push({ kind: 'assistant', text: part.text, at })
          this.turnText.push(part.text)
        } else if (part.type === 'tool_use') {
          const changedFile = changedFilePath(part.name, part.input)
          if (changedFile) this.turnChangedFiles.add(relativizePath(this.cwd, changedFile))
          newItems.push({
            kind: 'tool',
            name: part.name,
            input: JSON.stringify(part.input),
            output: null,
            at
          })
        }
      }
    } else if (message.type === 'result') {
      this.state = 'awaiting-input'
      turnEnded = true
      turnTokens = usageTotal(message)
    }
    this.touch(newItems)
    if (turnEnded) {
      const assistantText = this.turnText.join('\n\n')
      const changedFiles = [...this.turnChangedFiles]
      this.turnText = []
      this.turnChangedFiles.clear()
      this.observer?.turnCompleted(this.localId, assistantText, turnTokens, changedFiles)
    }
  }

  private touch(newItems: TranscriptItem[]): void {
    this.lastActivityAt = new Date().toISOString()
    this.items.push(...newItems)
    this.onChange(this, newItems)
    if (this.state !== this.lastNotifiedState) {
      this.lastNotifiedState = this.state
      this.observer?.stateChanged(this.localId, this.state)
    }
  }
}

/**
 * Discovers sessions from Claude's storage, runs managed sessions through the
 * Agent SDK, and overlays app-side curation (pin/rename/archive).
 */
export class SessionService {
  private readonly curationPath: string
  private curation: Record<string, CurationRecord> = {}
  private readonly managed = new Map<string, ManagedSession>()
  /** Resolves task attribution for discovered sessions, wired to the run orchestrator. */
  private attributionLookup: (sdkSessionId: string) => SessionOwner | null = () => null

  constructor(
    private readonly storage: SessionStorage,
    private readonly projects: ProjectStore,
    userDataDir: string,
    private readonly sink: SessionEventSink,
    private readonly queryFn: QueryFn = query
  ) {
    this.curationPath = join(userDataDir, 'sessions-meta.json')
    this.loadCuration()
  }

  setAttributionLookup(lookup: (sdkSessionId: string) => SessionOwner | null): void {
    this.attributionLookup = lookup
  }

  listSessions(projectId: string): SessionSummary[] {
    const project = this.projects.getOrThrow(projectId)
    const summaries = new Map<string, SessionSummary>()

    for (const file of this.storage.listSessionFiles(project.path)) {
      try {
        const stored = this.storage.readSession(file.filePath)
        summaries.set(
          file.sessionId,
          this.discoveredSummary(
            projectId,
            file.sessionId,
            stored.summary,
            stored.firstTimestamp,
            stored.lastTimestamp ?? file.modifiedAt.toISOString(),
            stored.messageCount,
            file.modifiedAt
          )
        )
      } catch {
        // per-session failure must not break the listing
      }
    }

    for (const session of this.managed.values()) {
      if (session.projectId !== projectId) continue
      const summary = this.managedSummary(session)
      // A managed session may also appear as a storage file under its SDK id;
      // the managed (live) view wins.
      if (session.sdkSessionId) summaries.delete(session.sdkSessionId)
      summaries.set(summary.id, summary)
    }

    return [...summaries.values()].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
    })
  }

  getTranscript(projectId: string, sessionId: string): TranscriptItem[] {
    const managedSession = this.managed.get(sessionId)
    if (managedSession) return [...managedSession.items]
    const project = this.projects.getOrThrow(projectId)
    const file = this.storage.listSessionFiles(project.path).find((f) => f.sessionId === sessionId)
    if (!file) throw new Error(`Unknown session: ${sessionId}`)
    return this.storage.readSession(file.filePath).items
  }

  startSession(projectId: string, prompt: string, mode: SessionPermissionMode): SessionSummary {
    const project = this.projects.getOrThrow(projectId)
    const session = this.createManaged(projectId, project.path, mode)
    session.start(prompt)
    return this.managedSummary(session)
  }

  /**
   * Start a session on behalf of the run loop: tagged with its owning task and
   * observed for turn completions, state changes, and stream end.
   */
  startOwnedSession(
    projectId: string,
    prompt: string,
    mode: SessionPermissionMode,
    model: string | null,
    owner: SessionOwner,
    observer: RunSessionObserver,
    resumeSessionId?: string
  ): SessionSummary {
    const project = this.projects.getOrThrow(projectId)
    const session = this.createManaged(projectId, project.path, mode, model)
    session.owner = owner
    session.observer = observer
    session.start(prompt, resumeSessionId)
    return this.managedSummary(session)
  }

  /** Programmatic follow-up from the run loop; only live managed sessions qualify. */
  sendToSession(sessionId: string, message: string): void {
    this.requireManaged(sessionId).send(message)
  }

  isSessionAlive(sessionId: string): boolean {
    const session = this.managed.get(sessionId)
    return session !== undefined && !session.isClosed
  }

  /** Live managed sessions across all projects; used by the attention inbox. */
  listManagedSessions(): SessionSummary[] {
    return [...this.managed.values()].filter((s) => !s.isClosed).map((s) => this.managedSummary(s))
  }

  /** Tool name of a live session's pending permission prompt, when one exists. */
  pendingPermissionTool(sessionId: string): string | null {
    return this.managed.get(sessionId)?.pendingPermissionToolName ?? null
  }

  sdkSessionIdFor(sessionId: string): string | null {
    return this.managed.get(sessionId)?.sdkSessionId ?? null
  }

  respondToSession(projectId: string, sessionId: string, message: string): void {
    const managedSession = this.managed.get(sessionId)
    if (managedSession && !managedSession.isClosed) {
      managedSession.send(message)
      return
    }
    // Discovered session: resume it through the SDK (D3), unless it is live elsewhere.
    const project = this.projects.getOrThrow(projectId)
    const file = this.storage.listSessionFiles(project.path).find((f) => f.sessionId === sessionId)
    if (!file) throw new Error(`Unknown session: ${sessionId}`)
    if (this.isLiveExternal(file.modifiedAt)) {
      throw new Error('This session is currently controlled by another process and is view-only')
    }
    const session = this.createManaged(projectId, project.path, 'plan')
    session.start(message, sessionId)
  }

  async setSessionMode(_projectId: string, sessionId: string, mode: SessionPermissionMode): Promise<void> {
    const managedSession = this.requireManaged(sessionId)
    await managedSession.setMode(mode)
  }

  respondToPermission(_projectId: string, sessionId: string, allow: boolean): void {
    this.requireManaged(sessionId).respondToPermission(allow)
  }

  async interruptSession(_projectId: string, sessionId: string): Promise<void> {
    await this.requireManaged(sessionId).interrupt()
  }

  curateSession(projectId: string, sessionId: string, patch: SessionCurationPatch): void {
    const record = { ...this.curation[sessionId] }
    if (patch.pinned !== undefined) record.pinned = patch.pinned
    if (patch.title !== undefined) record.title = patch.title
    if (patch.archived !== undefined) record.archived = patch.archived
    this.curation[sessionId] = record
    this.saveCuration()
    const summary = this.listSessions(projectId).find((s) => s.id === sessionId)
    if (summary) this.sink.sessionUpdated(summary)
  }

  /** Counts used by the dashboard status summary. */
  attentionCounts(projectId: string): { total: number; needingAttention: number } {
    const sessions = this.listSessions(projectId).filter((s) => !s.archived)
    return {
      total: sessions.length,
      needingAttention: sessions.filter(
        (s) => s.state === 'awaiting-input' || s.state === 'permission-prompt'
      ).length
    }
  }

  private requireManaged(sessionId: string): ManagedSession {
    const managedSession = this.managed.get(sessionId)
    if (!managedSession || managedSession.isClosed) {
      throw new Error('Only sessions managed by the app can be controlled; respond first to resume it')
    }
    return managedSession
  }

  private createManaged(
    projectId: string,
    cwd: string,
    mode: SessionPermissionMode,
    model: string | null = null
  ): ManagedSession {
    const localId = `managed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const session = new ManagedSession(
      projectId,
      localId,
      cwd,
      mode,
      model,
      (s, newItems) => {
        if (newItems.length > 0) this.sink.transcriptAppended(s.projectId, s.localId, newItems)
        this.sink.sessionUpdated(this.managedSummary(s))
      },
      this.queryFn
    )
    this.managed.set(localId, session)
    return session
  }

  private managedSummary(session: ManagedSession): SessionSummary {
    const curation = this.curation[session.sdkSessionId ?? session.localId] ?? {}
    const firstUser = session.items.find((i) => i.kind === 'user')
    return {
      id: session.localId,
      projectId: session.projectId,
      title: curation.title ?? null,
      summary: firstUser && firstUser.kind === 'user' ? truncate(firstUser.text) : null,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      origin: 'managed',
      liveExternal: false,
      state: session.state,
      mode: session.mode,
      pinned: curation.pinned ?? false,
      archived: curation.archived ?? false,
      messageCount: session.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length,
      taskId: session.owner?.taskId ?? null,
      taskTitle: session.owner?.taskTitle ?? null
    }
  }

  private discoveredSummary(
    projectId: string,
    sessionId: string,
    summary: string | null,
    startedAt: string | null,
    lastActivityAt: string | null,
    messageCount: number,
    modifiedAt: Date
  ): SessionSummary {
    const curation = this.curation[sessionId] ?? {}
    // Sessions the run loop started in an earlier app run stay attributed after restarts.
    const owner = this.attributionLookup(sessionId)
    return {
      id: sessionId,
      projectId,
      title: curation.title ?? null,
      summary: summary ? truncate(summary) : null,
      startedAt,
      lastActivityAt,
      origin: 'discovered',
      liveExternal: this.isLiveExternal(modifiedAt),
      state: 'idle',
      mode: null,
      pinned: curation.pinned ?? false,
      archived: curation.archived ?? false,
      messageCount,
      taskId: owner?.taskId ?? null,
      taskTitle: owner?.taskTitle ?? null
    }
  }

  private isLiveExternal(modifiedAt: Date): boolean {
    return Date.now() - modifiedAt.getTime() < LIVE_EXTERNAL_WINDOW_MS
  }

  private loadCuration(): void {
    try {
      this.curation = JSON.parse(readFileSync(this.curationPath, 'utf8')) as Record<string, CurationRecord>
    } catch {
      this.curation = {}
    }
  }

  private saveCuration(): void {
    const tmpPath = this.curationPath + '.tmp'
    mkdirSync(dirname(this.curationPath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(this.curation, null, 2), 'utf8')
    renameSync(tmpPath, this.curationPath)
  }
}

/** Tokens a result message reports for its turn; tolerant of the fake-agent seam omitting usage. */
function usageTotal(message: SDKMessage): number {
  const usage = (message as { usage?: Record<string, unknown> }).usage
  if (!usage) return 0
  let total = 0
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens'
  ]) {
    const value = usage[key]
    if (typeof value === 'number') total += value
  }
  return total
}

/** SDK tools that change a file, mapped to the input key holding its path. */
const FILE_EDIT_TOOL_PATH_KEYS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path'
}

/** Path a tool_use changes, or null when the tool does not edit files (or the input is malformed). */
function changedFilePath(toolName: string, input: unknown): string | null {
  const pathKey = FILE_EDIT_TOOL_PATH_KEYS[toolName]
  if (!pathKey || typeof input !== 'object' || input === null) return null
  const value = (input as Record<string, unknown>)[pathKey]
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Normalize a changed-file path for display: relative to the project root with
 * forward slashes; paths outside the project stay absolute.
 */
function relativizePath(cwd: string, filePath: string): string {
  const resolved = resolve(cwd, filePath)
  const rel = relative(cwd, resolved)
  const display = rel.startsWith('..') || isAbsolute(rel) ? resolved : rel
  return display.replaceAll('\\', '/')
}

function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}
