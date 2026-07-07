import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/** A live session driven through the Claude Agent SDK (D3 managed sessions). */
class ManagedSession {
  readonly items: TranscriptItem[] = []
  state: SessionState = 'running'
  mode: SessionPermissionMode
  startedAt = new Date().toISOString()
  lastActivityAt = new Date().toISOString()
  /** Session ID reported by the CLI; keys this session in listings. */
  sdkSessionId: string | null = null
  private queryHandle: Query | null = null
  private pendingMessages: SDKUserMessage[] = []
  private wakeInput: (() => void) | null = null
  private pendingPermission: { resolve: (allow: boolean) => void; toolName: string } | null = null
  private closed = false

  constructor(
    readonly projectId: string,
    readonly localId: string,
    private readonly cwd: string,
    mode: SessionPermissionMode,
    private readonly onChange: (session: ManagedSession, newItems: TranscriptItem[]) => void
  ) {
    this.mode = mode
  }

  start(initialPrompt: string, resumeSessionId?: string): void {
    this.pushUserMessage(initialPrompt)
    this.queryHandle = query({
      prompt: this.inputStream(),
      options: {
        cwd: this.cwd,
        permissionMode: MODE_TO_SDK[this.mode],
        resume: resumeSessionId,
        canUseTool: async (toolName, input) => {
          this.state = 'permission-prompt'
          this.touch([
            { kind: 'system', text: `Permission requested: ${toolName}`, at: new Date().toISOString() }
          ])
          const allow = await new Promise<boolean>((resolve) => {
            this.pendingPermission = { resolve, toolName }
          })
          this.pendingPermission = null
          this.state = 'running'
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
    this.touch([{ kind: 'user', text: message, at: new Date().toISOString() }])
  }

  async setMode(mode: SessionPermissionMode): Promise<void> {
    if (!this.queryHandle) throw new Error('Session not started')
    await this.queryHandle.setPermissionMode(MODE_TO_SDK[mode])
    this.mode = mode
    // Switching to a more permissive mode implicitly answers a pending prompt.
    if (this.pendingPermission && (mode === 'acceptEdits' || mode === 'auto')) {
      this.pendingPermission.resolve(true)
    }
    this.touch([])
  }

  respondToPermission(allow: boolean): void {
    if (!this.pendingPermission) throw new Error('No pending permission prompt')
    this.pendingPermission.resolve(allow)
  }

  async interrupt(): Promise<void> {
    await this.queryHandle?.interrupt()
    this.state = 'awaiting-input'
    this.touch([])
  }

  get hasPendingPermission(): boolean {
    return this.pendingPermission !== null
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
      this.touch([
        {
          kind: 'system',
          text: `Session error: ${err instanceof Error ? err.message : String(err)}`,
          at: new Date().toISOString()
        }
      ])
    } finally {
      this.closed = true
      this.state = 'idle'
      this.wakeInput?.()
      this.touch([])
    }
  }

  private handleSdkMessage(message: SDKMessage): void {
    if ('session_id' in message && message.session_id) this.sdkSessionId = message.session_id
    const at = new Date().toISOString()
    const newItems: TranscriptItem[] = []

    if (message.type === 'assistant') {
      for (const part of message.message.content) {
        if (part.type === 'text' && part.text.trim()) {
          newItems.push({ kind: 'assistant', text: part.text, at })
        } else if (part.type === 'tool_use') {
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
    }
    this.touch(newItems)
  }

  private touch(newItems: TranscriptItem[]): void {
    this.lastActivityAt = new Date().toISOString()
    this.items.push(...newItems)
    this.onChange(this, newItems)
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

  constructor(
    private readonly storage: SessionStorage,
    private readonly projects: ProjectStore,
    userDataDir: string,
    private readonly sink: SessionEventSink
  ) {
    this.curationPath = join(userDataDir, 'sessions-meta.json')
    this.loadCuration()
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

  private createManaged(projectId: string, cwd: string, mode: SessionPermissionMode): ManagedSession {
    const localId = `managed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const session = new ManagedSession(projectId, localId, cwd, mode, (s, newItems) => {
      if (newItems.length > 0) this.sink.transcriptAppended(s.projectId, s.localId, newItems)
      this.sink.sessionUpdated(this.managedSummary(s))
    })
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
      messageCount: session.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length
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
      messageCount
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

function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}
