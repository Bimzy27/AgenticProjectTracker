import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPermissionMode, SessionSummary } from '../src/shared/domain'
import { RunOrchestrator } from '../src/main/services/RunOrchestrator'
import type { RunEventSink, RunSessionPort } from '../src/main/services/RunOrchestrator'
import type { RunSessionObserver, SessionOwner } from '../src/main/services/SessionService'
import { TaskService } from '../src/main/services/TaskService'

interface FakeSession {
  id: string
  projectId: string
  prompt: string
  mode: SessionPermissionMode
  owner: SessionOwner
  observer: RunSessionObserver
  resumeSessionId: string | undefined
}

/** Scripted stand-in for SessionService: tests drive agent turns explicitly. */
class FakeSessions implements RunSessionPort {
  sessions: FakeSession[] = []
  sent: Array<{ sessionId: string; message: string }> = []
  interrupted: string[] = []
  private readonly dead = new Set<string>()
  private seq = 0

  startOwnedSession(
    projectId: string,
    prompt: string,
    mode: SessionPermissionMode,
    owner: SessionOwner,
    observer: RunSessionObserver,
    resumeSessionId?: string
  ): SessionSummary {
    const id = `fake-${++this.seq}`
    this.sessions.push({ id, projectId, prompt, mode, owner, observer, resumeSessionId })
    return {
      id,
      projectId,
      title: null,
      summary: null,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      origin: 'managed',
      liveExternal: false,
      state: 'running',
      mode,
      pinned: false,
      archived: false,
      messageCount: 1,
      taskId: owner.taskId,
      taskTitle: owner.taskTitle
    }
  }

  sendToSession(sessionId: string, message: string): void {
    if (this.dead.has(sessionId)) throw new Error('Session has ended')
    this.sent.push({ sessionId, message })
  }

  isSessionAlive(sessionId: string): boolean {
    return this.sessions.some((s) => s.id === sessionId) && !this.dead.has(sessionId)
  }

  sdkSessionIdFor(sessionId: string): string | null {
    return this.dead.has(sessionId) ? null : `sdk-${sessionId}`
  }

  async interruptSession(_projectId: string, sessionId: string): Promise<void> {
    this.interrupted.push(sessionId)
  }

  // Test drivers
  last(): FakeSession {
    return this.sessions[this.sessions.length - 1]
  }

  turn(session: FakeSession, text: string): void {
    session.observer.turnCompleted(session.id, text)
  }

  kill(session: FakeSession, error: string | null): void {
    this.dead.add(session.id)
    session.observer.closed(session.id, error)
  }
}

function status(state: string, note: string, extra = ''): string {
  return `Some prose.\n\`\`\`apt-status\n{ "state": "${state}", "note": "${note}"${extra} }\n\`\`\``
}

const COMPLETE_OK = status('complete', 'built it', ', "gatePassed": true, "gateSummary": "patrol green"')

describe('RunOrchestrator', () => {
  let userData: string
  let claudeHome: string
  let tasks: TaskService
  let sessions: FakeSessions
  let sink: { runUpdated: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'apt-orch-'))
    claudeHome = mkdtempSync(join(tmpdir(), 'apt-orch-home-'))
    mkdirSync(join(claudeHome, 'skills', 'patrol'), { recursive: true })
    tasks = new TaskService(userData, { tasksChanged: () => {} })
    sessions = new FakeSessions()
    sink = { runUpdated: vi.fn() }
  })

  afterEach(() => {
    for (const dir of [userData, claudeHome]) rmSync(dir, { recursive: true, force: true })
  })

  function makeOrchestrator(options: { maxConcurrentRuns?: number } = {}): RunOrchestrator {
    return new RunOrchestrator(userData, tasks, sessions, sink as RunEventSink, { claudeHome, ...options })
  }

  function makeTask(projectId = 'p1', overrides: Partial<Parameters<TaskService['create']>[1]> = {}) {
    return tasks.create(projectId, {
      title: 'Build login',
      purpose: 'Build the login page',
      acceptanceCriteria: ['form validates'],
      ...overrides
    })
  }

  it('runs the happy path: delegate, work, complete with gate, review, accept', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)

    expect(tasks.getOrThrow(task.id).state).toBe('running')
    const session = sessions.last()
    expect(session.prompt).toContain('Build the login page')
    expect(session.prompt).toContain('apt-status')
    expect(session.prompt).toContain('/patrol')
    expect(session.mode).toBe('acceptEdits')
    expect(session.owner).toMatchObject({ taskId: task.id, taskTitle: 'Build login' })

    sessions.turn(session, status('working', 'scaffolding the page'))
    let run = orch.latestRun(task.id)!
    expect(run.progressNote).toBe('scaffolding the page')
    expect(run.stepsUsed).toBe(1)
    expect(run.workflowVerified).toBe(true)

    sessions.turn(session, COMPLETE_OK)
    run = orch.latestRun(task.id)!
    expect(run.state).toBe('review')
    expect(run.completion).toMatchObject({
      summary: 'built it',
      gatePassed: true,
      gateSummary: 'patrol green'
    })
    expect(tasks.getOrThrow(task.id).state).toBe('review')

    orch.accept(task.id)
    expect(tasks.getOrThrow(task.id).state).toBe('done')
    expect(orch.latestRun(task.id)!.state).toBe('done')
  })

  it('recovers from blocked reports with corrective nudges and succeeds', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()

    sessions.turn(session, status('blocked', 'tests are failing'))
    expect(tasks.getOrThrow(task.id).state).toBe('running')
    expect(sessions.sent).toHaveLength(1)
    expect(sessions.sent[0].message).toContain('tests are failing')
    expect(orch.latestRun(task.id)!.nudgesUsed).toBe(1)

    sessions.turn(session, COMPLETE_OK)
    expect(tasks.getOrThrow(task.id).state).toBe('review')
  })

  it('escalates with failure history when the recovery budget is exhausted', () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { recoveryBudget: 2 })
    orch.delegate(task.id)
    const session = sessions.last()

    sessions.turn(session, status('blocked', 'failure one'))
    sessions.turn(session, status('blocked', 'failure two'))
    expect(tasks.getOrThrow(task.id).state).toBe('running')

    sessions.turn(session, status('blocked', 'failure three'))
    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('needs-input')
    expect(run.escalation).toMatchObject({ kind: 'recovery-exhausted', message: 'failure three' })
    expect(run.escalation!.history).toEqual(['failure one', 'failure two'])
    expect(tasks.getOrThrow(task.id).state).toBe('needs-input')
  })

  it('escalates questions immediately without consuming recovery attempts', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()

    sessions.turn(session, status('question', 'Postgres or SQLite?'))
    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('needs-input')
    expect(run.escalation).toMatchObject({ kind: 'question', message: 'Postgres or SQLite?' })
    expect(run.nudgesUsed).toBe(0)
    expect(sessions.sent).toHaveLength(0)

    orch.answer(task.id, 'Use SQLite')
    expect(tasks.getOrThrow(task.id).state).toBe('running')
    expect(orch.latestRun(task.id)!.state).toBe('active')
    expect(sessions.sent[0].message).toContain('Use SQLite')

    sessions.turn(session, COMPLETE_OK)
    expect(tasks.getOrThrow(task.id).state).toBe('review')
  })

  it('treats completion without a passing gate as blocked', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()

    sessions.turn(session, status('complete', 'all done'))
    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('active')
    expect(run.nudgesUsed).toBe(1)
    expect(sessions.sent[0].message).toContain('quality gate')
    expect(tasks.getOrThrow(task.id).state).toBe('running')
  })

  it('re-prompts once for a missing status block, then treats it as blocked', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()

    sessions.turn(session, 'I did some work but forgot the block.')
    expect(sessions.sent).toHaveLength(1)
    expect(sessions.sent[0].message).toContain('apt-status')
    expect(orch.latestRun(task.id)!.nudgesUsed).toBe(0)

    sessions.turn(session, 'Still no block here.')
    expect(orch.latestRun(task.id)!.nudgesUsed).toBe(1)
    expect(sessions.sent[1].message).toContain('status')
  })

  it('interrupts and escalates when the step budget is exceeded', () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { stepBudget: 2 })
    orch.delegate(task.id)
    const session = sessions.last()

    sessions.turn(session, status('working', 'one'))
    sessions.turn(session, status('working', 'two'))
    sessions.turn(session, status('working', 'three'))

    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('needs-input')
    expect(run.escalation).toMatchObject({ kind: 'step-budget' })
    expect(sessions.interrupted).toContain(session.id)
    expect(tasks.getOrThrow(task.id).state).toBe('needs-input')
  })

  it('stops a run manually, moving the task to failed with history retained', async () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()
    sessions.turn(session, status('working', 'midway'))

    await orch.stop(task.id)
    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('failed')
    expect(run.events.map((e) => e.kind)).toContain('stopped')
    expect(run.events.map((e) => e.kind)).toContain('status')
    expect(sessions.interrupted).toContain(session.id)
    expect(tasks.getOrThrow(task.id).state).toBe('failed')
  })

  it('re-queues a sent-back task and includes the feedback in the next briefing', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    sessions.turn(sessions.last(), COMPLETE_OK)

    orch.sendBack(task.id, 'The buttons are misaligned')
    // send-back re-queues; with capacity free the task starts again immediately
    expect(tasks.getOrThrow(task.id).state).toBe('running')
    expect(sessions.last().prompt).toContain('The buttons are misaligned')
  })

  it('enforces one active run per project and the global cap with FIFO queueing', () => {
    const orch = makeOrchestrator({ maxConcurrentRuns: 2 })
    const a1 = makeTask('p1')
    const a2 = makeTask('p1', { title: 'Second in p1' })
    const b1 = makeTask('p2')
    const c1 = makeTask('p3')

    orch.delegate(a1.id)
    orch.delegate(a2.id)
    expect(tasks.getOrThrow(a1.id).state).toBe('running')
    expect(tasks.getOrThrow(a2.id).state).toBe('queued')

    orch.delegate(b1.id)
    expect(tasks.getOrThrow(b1.id).state).toBe('running')

    orch.delegate(c1.id)
    expect(tasks.getOrThrow(c1.id).state).toBe('queued')

    // finishing p1's run frees a slot; a2 was queued before c1, so FIFO starts a2
    sessions.turn(sessions.sessions[0], COMPLETE_OK)
    expect(tasks.getOrThrow(a2.id).state).toBe('running')
    expect(tasks.getOrThrow(c1.id).state).toBe('queued')
  })

  it('marks active runs interrupted on restart and resumes them by session id', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()
    sessions.turn(session, status('working', 'halfway through'))
    const sdkId = orch.latestRun(task.id)!.sdkSessionId
    expect(sdkId).toBe(`sdk-${session.id}`)

    // simulate a restart: fresh orchestrator over the same persisted state
    const sessions2 = new FakeSessions()
    const orch2 = new RunOrchestrator(userData, tasks, sessions2, sink as RunEventSink, { claudeHome })
    orch2.restore()

    let run = orch2.latestRun(task.id)!
    expect(run.state).toBe('interrupted')
    expect(run.progressNote).toBe('halfway through')
    expect(run.events.map((e) => e.kind)).toContain('interrupted')
    expect(tasks.getOrThrow(task.id).state).toBe('needs-input')

    orch2.resume(task.id)
    expect(sessions2.last().resumeSessionId).toBe(sdkId)
    run = orch2.latestRun(task.id)!
    expect(run.state).toBe('active')
    expect(tasks.getOrThrow(task.id).state).toBe('running')

    sessions2.turn(sessions2.last(), COMPLETE_OK)
    expect(tasks.getOrThrow(task.id).state).toBe('review')
  })

  it('interrupted sessions surface as resumable when the stream dies mid-run', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()
    sessions.turn(session, status('working', 'going'))

    sessions.kill(session, 'CLI crashed')
    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('interrupted')
    expect(run.escalation).toMatchObject({ kind: 'interrupted' })
    expect(run.escalation!.message).toContain('CLI crashed')
    expect(tasks.getOrThrow(task.id).state).toBe('needs-input')

    orch.resume(task.id)
    expect(sessions.last().resumeSessionId).toBe(`sdk-${session.id}`)
  })

  it('marks runs as unverified when workspace skills are missing', () => {
    rmSync(join(claudeHome, 'skills'), { recursive: true, force: true })
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const run = orch.latestRun(task.id)!
    expect(run.workflowVerified).toBe(false)
    expect(sessions.last().prompt).not.toContain('/patrol')
  })

  it('reports the delegation summary for dashboard cards', () => {
    const orch = makeOrchestrator({ maxConcurrentRuns: 1 })
    const t1 = makeTask('p1', { title: 'Running task' })
    const t2 = makeTask('p1', { title: 'Waiting task' })
    orch.delegate(t1.id)
    orch.delegate(t2.id)
    sessions.turn(sessions.last(), status('working', 'building the form'))

    expect(orch.delegationSummary('p1')).toEqual({
      queued: 1,
      running: 1,
      needsInput: 0,
      review: 0,
      activeTaskTitle: 'Running task',
      activeProgressNote: 'building the form'
    })
  })
})
