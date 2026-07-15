import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Agent SDK before importing the service under test.
const queryMock = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))

const { SessionService } = await import('../src/main/services/SessionService')
const { SessionStorage } = await import('../src/main/services/SessionStorage')
const { ProjectStore } = await import('../src/main/services/ProjectStore')

interface FakeQuery extends AsyncIterable<unknown> {
  setPermissionMode: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  emit(message: unknown): void
  end(): void
}

/** An SDK query stub whose message stream is driven by the test. */
function fakeQuery(): FakeQuery {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  let done = false
  return {
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    emit(message: unknown) {
      queue.push(message)
      wake?.()
    },
    end() {
      done = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = null
          continue
        }
        yield queue.shift()
      }
    }
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('SessionService', () => {
  let userData: string
  let claudeHome: string
  let store: InstanceType<typeof ProjectStore>
  let service: InstanceType<typeof SessionService>
  let projectId: string
  let projectPath: string
  let sink: { sessionUpdated: ReturnType<typeof vi.fn>; transcriptAppended: ReturnType<typeof vi.fn> }
  let currentQuery: FakeQuery

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'apt-sess-'))
    claudeHome = mkdtempSync(join(tmpdir(), 'apt-claude-home-'))
    projectPath = mkdtempSync(join(tmpdir(), 'apt-proj-'))
    store = new ProjectStore(userData)
    projectId = store.add({ path: projectPath, name: 'Demo', tags: [], github: null }).id
    sink = { sessionUpdated: vi.fn(), transcriptAppended: vi.fn() }
    const storage = new SessionStorage(claudeHome)
    service = new SessionService(storage, store, userData, sink as never)
    currentQuery = fakeQuery()
    queryMock.mockReset()
    queryMock.mockImplementation(() => currentQuery)
  })

  afterEach(() => {
    for (const dir of [userData, claudeHome, projectPath]) rmSync(dir, { recursive: true, force: true })
  })

  function writeStoredSession(id: string, ageMinutes: number): void {
    const storage = new SessionStorage(claudeHome)
    const dir = storage.sessionDirFor(projectPath)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-01T10:00:00Z',
        message: { role: 'user', content: 'hello from terminal' }
      }) + '\n'
    )
    const mtime = new Date(Date.now() - ageMinutes * 60_000)
    utimesSync(file, mtime, mtime)
  }

  it('lists discovered sessions and flags recently-touched ones as live external', () => {
    writeStoredSession('old-session', 60)
    writeStoredSession('live-session', 0)
    const sessions = service.listSessions(projectId)
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.id === 'old-session')?.liveExternal).toBe(false)
    expect(sessions.find((s) => s.id === 'live-session')?.liveExternal).toBe(true)
  })

  it('rejects responding to a session that is live in another terminal', () => {
    writeStoredSession('live-session', 0)
    expect(() => service.respondToSession(projectId, 'live-session', 'hi')).toThrow(/view-only/)
  })

  it('resumes an idle discovered session through the SDK', () => {
    writeStoredSession('old-session', 60)
    service.respondToSession(projectId, 'old-session', 'continue please')
    expect(queryMock).toHaveBeenCalledOnce()
    expect(queryMock.mock.calls[0][0].options.resume).toBe('old-session')
  })

  it('walks a managed session through running, awaiting-input, and mode changes', async () => {
    const summary = service.startSession(projectId, 'build the thing', 'plan')
    expect(summary.state).toBe('running')
    expect(summary.mode).toBe('plan')
    expect(queryMock.mock.calls[0][0].options.permissionMode).toBe('plan')

    currentQuery.emit({
      type: 'assistant',
      session_id: 'sdk-1',
      message: { content: [{ type: 'text', text: 'On it.' }] }
    })
    currentQuery.emit({ type: 'result', session_id: 'sdk-1' })
    await settle()

    const [session] = service.listSessions(projectId)
    expect(session.state).toBe('awaiting-input')
    expect(session.origin).toBe('managed')
    expect(sink.transcriptAppended).toHaveBeenCalled()

    await service.setSessionMode(projectId, session.id, 'auto')
    expect(currentQuery.setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
    expect(service.listSessions(projectId)[0].mode).toBe('auto')

    service.respondToSession(projectId, session.id, 'keep going')
    expect(service.listSessions(projectId)[0].state).toBe('running')
  })

  it('surfaces permission prompts and resolves them via respondToPermission', async () => {
    service.startSession(projectId, 'risky work', 'plan')
    const canUseTool = queryMock.mock.calls[0][0].options.canUseTool
    const decision = canUseTool('Bash', { command: 'rm -rf' })
    await settle()

    const [session] = service.listSessions(projectId)
    expect(session.state).toBe('permission-prompt')
    expect(service.attentionCounts(projectId).needingAttention).toBe(1)

    service.respondToPermission(projectId, session.id, false)
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' })
    await settle()
    expect(service.listSessions(projectId)[0].state).toBe('running')
  })

  it('handles parallel permission prompts without dropping any of them', async () => {
    // Real CLI turns can request several tools at once; each must resolve independently.
    service.startSession(projectId, 'parallel reads', 'plan')
    const canUseTool = queryMock.mock.calls[0][0].options.canUseTool
    const first = canUseTool('Read', { file_path: 'a.ts' })
    const second = canUseTool('Read', { file_path: 'b.ts' })
    await settle()

    const [session] = service.listSessions(projectId)
    expect(session.state).toBe('permission-prompt')

    service.respondToPermission(projectId, session.id, true)
    await expect(first).resolves.toMatchObject({ behavior: 'allow' })
    await settle()
    // One prompt is still open, so the session keeps asking.
    expect(service.listSessions(projectId)[0].state).toBe('permission-prompt')

    service.respondToPermission(projectId, session.id, false)
    await expect(second).resolves.toMatchObject({ behavior: 'deny' })
    await settle()
    expect(service.listSessions(projectId)[0].state).toBe('running')
  })

  it('auto-approves Bash for owned run-loop sessions when the project is looping', async () => {
    store.update(projectId, { looping: true })
    const observer = { turnCompleted: vi.fn(), stateChanged: vi.fn(), closed: vi.fn() }
    const summary = service.startOwnedSession(
      projectId,
      'the briefing',
      'acceptEdits',
      null,
      { taskId: 't1', taskTitle: 'Add login', runId: 'r1' },
      observer
    )
    const canUseTool = queryMock.mock.calls[0][0].options.canUseTool

    // Bash is approved immediately without ever stalling in a permission prompt.
    await expect(canUseTool('Bash', { command: 'npm test' })).resolves.toMatchObject({
      behavior: 'allow'
    })
    await settle()
    expect(service.listSessions(projectId).find((s) => s.id === summary.id)?.state).not.toBe(
      'permission-prompt'
    )
    expect(service.attentionCounts(projectId).needingAttention).toBe(0)

    // Other tools still prompt: looping only auto-approves bash commands.
    void canUseTool('WebFetch', { url: 'https://example.com' })
    await settle()
    expect(service.listSessions(projectId).find((s) => s.id === summary.id)?.state).toBe('permission-prompt')
  })

  it('still prompts for Bash on manual sessions even when the project is looping', async () => {
    // Looping auto-approval is scoped to the unattended run loop; a manual
    // session has a user present, so its bash prompts must not be skipped.
    store.update(projectId, { looping: true })
    service.startSession(projectId, 'manual work', 'acceptEdits')
    const canUseTool = queryMock.mock.calls[0][0].options.canUseTool
    void canUseTool('Bash', { command: 'rm -rf build' })
    await settle()
    expect(service.listSessions(projectId)[0].state).toBe('permission-prompt')
  })

  it('persists curation across instances without touching session files', () => {
    writeStoredSession('old-session', 60)
    service.curateSession(projectId, 'old-session', { pinned: true, title: 'Login bug hunt' })
    service.curateSession(projectId, 'old-session', { archived: true })

    const reloaded = new SessionService(new SessionStorage(claudeHome), store, userData, sink as never)
    const [session] = reloaded.listSessions(projectId)
    expect(session).toMatchObject({ pinned: true, title: 'Login bug hunt', archived: true })
    // underlying jsonl still parses fine
    expect(session.messageCount).toBe(1)
  })

  it('tags owned sessions with their task and reports turns to the observer', async () => {
    const observer = { turnCompleted: vi.fn(), stateChanged: vi.fn(), closed: vi.fn() }
    const summary = service.startOwnedSession(
      projectId,
      'the briefing',
      'acceptEdits',
      null,
      { taskId: 't1', taskTitle: 'Add login', runId: 'r1' },
      observer
    )
    expect(summary).toMatchObject({ taskId: 't1', taskTitle: 'Add login', mode: 'acceptEdits' })
    // No model picked: the CLI's configured default must stay in charge.
    expect(queryMock.mock.calls[0][0].options.model).toBeUndefined()

    currentQuery.emit({
      type: 'assistant',
      session_id: 'sdk-9',
      message: { content: [{ type: 'text', text: 'Working on it.' }] }
    })
    currentQuery.emit({
      type: 'result',
      session_id: 'sdk-9',
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 500 }
    })
    await settle()

    expect(observer.turnCompleted).toHaveBeenCalledWith(summary.id, 'Working on it.', 2000, [])
    expect(observer.stateChanged).toHaveBeenCalledWith(summary.id, 'awaiting-input')
    expect(service.listSessions(projectId)[0]).toMatchObject({ taskId: 't1', taskTitle: 'Add login' })
    expect(service.sdkSessionIdFor(summary.id)).toBe('sdk-9')
    expect(service.isSessionAlive(summary.id)).toBe(true)

    service.sendToSession(summary.id, 'corrective nudge')
    expect(service.listSessions(projectId)[0].state).toBe('running')

    currentQuery.end()
    await settle()
    expect(observer.closed).toHaveBeenCalledWith(summary.id, null)
    expect(service.isSessionAlive(summary.id)).toBe(false)
  })

  it('reports the files a turn changed through file-editing tools, project-relative and deduped', async () => {
    const observer = { turnCompleted: vi.fn(), stateChanged: vi.fn(), closed: vi.fn() }
    const summary = service.startOwnedSession(
      projectId,
      'the briefing',
      'acceptEdits',
      null,
      { taskId: 't1', taskTitle: 'Add login', runId: 'r1' },
      observer
    )

    currentQuery.emit({
      type: 'assistant',
      session_id: 'sdk-9',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'u1',
            name: 'Edit',
            input: { file_path: join(projectPath, 'src', 'a.ts') }
          },
          {
            type: 'tool_use',
            id: 'u2',
            name: 'Write',
            input: { file_path: join(projectPath, 'src', 'a.ts') }
          },
          {
            type: 'tool_use',
            id: 'u3',
            name: 'NotebookEdit',
            input: { notebook_path: join(projectPath, 'nb.ipynb') }
          },
          // Non-editing tools and malformed inputs must not count.
          {
            type: 'tool_use',
            id: 'u4',
            name: 'Read',
            input: { file_path: join(projectPath, 'read-only.ts') }
          },
          { type: 'tool_use', id: 'u5', name: 'Edit', input: {} },
          { type: 'text', text: 'Edited things.' }
        ]
      }
    })
    currentQuery.emit({ type: 'result', session_id: 'sdk-9' })
    await settle()

    expect(observer.turnCompleted).toHaveBeenCalledWith(summary.id, 'Edited things.', 0, [
      'src/a.ts',
      'nb.ipynb'
    ])

    // The next turn starts from a clean slate.
    service.sendToSession(summary.id, 'continue')
    currentQuery.emit({
      type: 'assistant',
      session_id: 'sdk-9',
      message: { content: [{ type: 'text', text: 'No edits this turn.' }] }
    })
    currentQuery.emit({ type: 'result', session_id: 'sdk-9' })
    await settle()
    expect(observer.turnCompleted).toHaveBeenLastCalledWith(summary.id, 'No edits this turn.', 0, [])
  })

  it('resumes an owned session by SDK session id', () => {
    const observer = { turnCompleted: vi.fn(), stateChanged: vi.fn(), closed: vi.fn() }
    service.startOwnedSession(
      projectId,
      'continue where you left off',
      'acceptEdits',
      null,
      { taskId: 't1', taskTitle: 'Add login', runId: 'r2' },
      observer,
      'sdk-prev'
    )
    expect(queryMock.mock.calls[0][0].options.resume).toBe('sdk-prev')
  })

  it('passes the owned session model through to the Agent SDK', () => {
    const observer = { turnCompleted: vi.fn(), stateChanged: vi.fn(), closed: vi.fn() }
    service.startOwnedSession(
      projectId,
      'the briefing',
      'acceptEdits',
      'claude-opus-4-8',
      { taskId: 't1', taskTitle: 'Add login', runId: 'r1' },
      observer
    )
    expect(queryMock.mock.calls[0][0].options.model).toBe('claude-opus-4-8')
  })

  it('starts manual sessions on the CLI default model', () => {
    service.startSession(projectId, 'manual work', 'plan')
    expect(queryMock.mock.calls[0][0].options.model).toBeUndefined()
  })

  it('leaves manually started sessions unattributed', () => {
    const summary = service.startSession(projectId, 'manual work', 'plan')
    expect(summary.taskId).toBeNull()
    expect(summary.taskTitle).toBeNull()
  })

  it('attributes discovered sessions through the attribution lookup', () => {
    writeStoredSession('old-session', 60)
    service.setAttributionLookup((sdkSessionId) =>
      sdkSessionId === 'old-session' ? { taskId: 't7', taskTitle: 'Old task', runId: 'r7' } : null
    )
    const [session] = service.listSessions(projectId)
    expect(session).toMatchObject({ taskId: 't7', taskTitle: 'Old task' })
  })

  it('pins sessions to the top of the list', () => {
    writeStoredSession('a', 120)
    writeStoredSession('b', 60)
    service.curateSession(projectId, 'a', { pinned: true })
    const sessions = service.listSessions(projectId)
    expect(sessions[0].id).toBe('a')
  })
})
