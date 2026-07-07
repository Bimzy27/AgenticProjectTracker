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

  it('pins sessions to the top of the list', () => {
    writeStoredSession('a', 120)
    writeStoredSession('b', 60)
    service.curateSession(projectId, 'a', { pinned: true })
    const sessions = service.listSessions(projectId)
    expect(sessions[0].id).toBe('a')
  })
})
