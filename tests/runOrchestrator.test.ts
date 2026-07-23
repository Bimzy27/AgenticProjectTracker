import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  model: string | null
  owner: SessionOwner
  observer: RunSessionObserver
  resumeSessionId: string | undefined
}

/** Scripted stand-in for SessionService: tests drive agent turns explicitly. */
class FakeSessions implements RunSessionPort {
  sessions: FakeSession[] = []
  sent: Array<{ sessionId: string; message: string }> = []
  interrupted: string[] = []
  modelSwitches: Array<{ sessionId: string; model: string | null }> = []
  private readonly dead = new Set<string>()
  private seq = 0

  startOwnedSession(
    projectId: string,
    prompt: string,
    mode: SessionPermissionMode,
    model: string | null,
    owner: SessionOwner,
    observer: RunSessionObserver,
    resumeSessionId?: string
  ): SessionSummary {
    const id = `fake-${++this.seq}`
    this.sessions.push({ id, projectId, prompt, mode, model, owner, observer, resumeSessionId })
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

  async setSessionModel(sessionId: string, model: string | null): Promise<void> {
    if (this.dead.has(sessionId)) throw new Error('Session has ended')
    this.modelSwitches.push({ sessionId, model })
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

  turn(session: FakeSession, text: string, tokens = 0, changedFiles: string[] = []): void {
    session.observer.turnCompleted(session.id, text, tokens, changedFiles)
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

function taskBlock(title: string, purpose = 'Because it matters'): string {
  return `\`\`\`apt-task\n{ "title": "${title}", "purpose": "${purpose}", "acceptanceCriteria": ["done"] }\n\`\`\``
}

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

  function makeOrchestrator(
    options: {
      maxConcurrentRuns?: number
      isProjectLooping?: (projectId: string) => boolean
      allowAgentTasks?: (projectId: string) => boolean
    } = {}
  ): RunOrchestrator {
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

    sessions.turn(session, status('working', 'scaffolding the page'), 12_000, ['src/login.ts'])
    let run = orch.latestRun(task.id)!
    expect(run.progressNote).toBe('scaffolding the page')
    expect(run.stepsUsed).toBe(1)
    expect(run.tokensUsed).toBe(12_000)
    expect(run.filesChanged).toEqual(['src/login.ts'])
    expect(run.workflowVerified).toBe(true)

    // Repeated edits stay distinct while new files accumulate across turns.
    sessions.turn(session, COMPLETE_OK, 8_000, ['src/login.ts', 'src/login.test.ts'])
    run = orch.latestRun(task.id)!
    expect(run.state).toBe('review')
    expect(run.tokensUsed).toBe(20_000)
    expect(run.filesChanged).toEqual(['src/login.ts', 'src/login.test.ts'])
    expect(run.completion).toMatchObject({
      summary: 'built it',
      gatePassed: true,
      gateSummary: 'patrol green',
      debugUrl: null,
      changesUrl: null
    })
    expect(tasks.getOrThrow(task.id).state).toBe('review')

    orch.accept(task.id)
    expect(tasks.getOrThrow(task.id).state).toBe('done')
    expect(orch.latestRun(task.id)!.state).toBe('done')
  })

  it('auto-approves a completed run instead of parking it in review', () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { autoApprove: true })
    orch.delegate(task.id)
    const session = sessions.last()

    sessions.turn(session, COMPLETE_OK)

    // The task skips review and lands in done, archived automatically.
    const stored = tasks.getOrThrow(task.id)
    expect(stored.state).toBe('done')
    expect(stored.archived).toBe(true)
    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('done')
    expect(run.endedAt).not.toBeNull()
    // The completion is still recorded, and an accepted event marks the auto-approve.
    expect(run.completion).toMatchObject({ summary: 'built it', gatePassed: true })
    const accepted = run.events.find((e) => e.kind === 'accepted')
    expect(accepted?.detail).toBe('Auto-approved on completion')
  })

  it('does not auto-approve a run that escalates a question', async () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { autoApprove: true })
    orch.delegate(task.id)
    const session = sessions.last()

    // A question always reaches the user, even under auto-approve.
    sessions.turn(session, status('question', 'which auth provider?'))
    expect(tasks.getOrThrow(task.id).state).toBe('needs-input')
    expect(orch.latestRun(task.id)!.state).toBe('needs-input')

    // Once answered and completed, auto-approve still finishes it without review.
    await orch.answer(task.id, 'use OAuth')
    sessions.turn(sessions.last(), COMPLETE_OK)
    expect(tasks.getOrThrow(task.id).state).toBe('done')
  })

  it('looping mode auto-approves completions and picks up the next draft in backlog order', () => {
    const looping = new Set(['p1'])
    const orch = makeOrchestrator({ isProjectLooping: (id) => looping.has(id) })
    const first = makeTask('p1', { title: 'First loop task' })
    const second = makeTask('p1', { title: 'Second loop task' })
    const otherProject = makeTask('p2', { title: 'Not looping' })
    orch.delegate(first.id)

    sessions.turn(sessions.last(), COMPLETE_OK)

    // The completion never parks in review: the run is accepted by the loop...
    expect(tasks.getOrThrow(first.id).state).toBe('done')
    expect(tasks.getOrThrow(first.id).archived).toBe(true)
    const firstRun = orch.latestRun(first.id)!
    expect(firstRun.state).toBe('done')
    expect(firstRun.events.find((e) => e.kind === 'accepted')?.detail).toBe('Auto-approved by looping mode')
    // ...and the next draft task starts on its own, in a fresh session.
    expect(tasks.getOrThrow(second.id).state).toBe('running')
    expect(sessions.sessions).toHaveLength(2)
    expect(sessions.last().prompt).toContain('Second loop task')
    // Drafts of projects without looping mode are left alone.
    expect(tasks.getOrThrow(otherProject.id).state).toBe('draft')

    // The loop rests once the backlog is empty.
    sessions.turn(sessions.last(), COMPLETE_OK)
    expect(tasks.getOrThrow(second.id).state).toBe('done')
    expect(sessions.sessions).toHaveLength(2)
  })

  it('enabling looping mid-flight unblocks a task parked in review and resumes the backlog', () => {
    const looping = new Set<string>()
    const orch = makeOrchestrator({ isProjectLooping: (id) => looping.has(id) })
    const first = makeTask('p1')
    const second = makeTask('p1', { title: 'Next in line' })
    orch.delegate(first.id)
    sessions.turn(sessions.last(), COMPLETE_OK)

    // Looping is off: the completion waits for the user's review as usual.
    expect(tasks.getOrThrow(first.id).state).toBe('review')

    looping.add('p1')
    orch.reschedule()

    // The parked review is accepted and the backlog continues immediately.
    expect(tasks.getOrThrow(first.id).state).toBe('done')
    expect(orch.latestRun(first.id)!.events.find((e) => e.kind === 'accepted')?.detail).toBe(
      'Auto-approved by looping mode'
    )
    expect(tasks.getOrThrow(second.id).state).toBe('running')
  })

  it('looping mode skips tasks toggled out of the loop and picks the next enabled draft', () => {
    const orch = makeOrchestrator({ isProjectLooping: () => true })
    const parked = makeTask('p1', { title: 'Parked task', loopEnabled: false })
    const enabled = makeTask('p1', { title: 'Loop task' })
    orch.reschedule()

    // The loop passes over the parked draft and starts the next enabled one.
    expect(tasks.getOrThrow(parked.id).state).toBe('draft')
    expect(tasks.getOrThrow(enabled.id).state).toBe('running')
    expect(sessions.last().prompt).toContain('Loop task')

    // Once only parked drafts remain, the loop rests instead of starting them.
    sessions.turn(sessions.last(), COMPLETE_OK)
    expect(tasks.getOrThrow(enabled.id).state).toBe('done')
    expect(tasks.getOrThrow(parked.id).state).toBe('draft')
    expect(sessions.sessions).toHaveLength(1)

    // Manual delegation still works for a task toggled out of the loop.
    orch.delegate(parked.id)
    expect(tasks.getOrThrow(parked.id).state).toBe('running')
  })

  it('toggling a parked draft back into the loop lets the reschedule pick it up', () => {
    const orch = makeOrchestrator({ isProjectLooping: () => true })
    const parked = makeTask('p1', { title: 'Parked task', loopEnabled: false })
    orch.reschedule()
    expect(tasks.getOrThrow(parked.id).state).toBe('draft')

    // Same flow the updateTask API drives: patch the flag, then reschedule.
    tasks.update(parked.id, { loopEnabled: true })
    orch.reschedule()
    expect(tasks.getOrThrow(parked.id).state).toBe('running')
  })

  it('looping mode does not bypass questions: needs-input still blocks the loop', async () => {
    const orch = makeOrchestrator({ isProjectLooping: () => true })
    const first = makeTask('p1')
    const second = makeTask('p1')
    orch.delegate(first.id)

    sessions.turn(sessions.last(), status('question', 'which auth provider?'))

    // The question escalates to the user and no new work is picked up meanwhile.
    expect(tasks.getOrThrow(first.id).state).toBe('needs-input')
    expect(tasks.getOrThrow(second.id).state).toBe('draft')
    expect(sessions.sessions).toHaveLength(1)

    // Once answered and completed, the loop continues with the next task.
    await orch.answer(first.id, 'use OAuth')
    sessions.turn(sessions.last(), COMPLETE_OK)
    expect(tasks.getOrThrow(first.id).state).toBe('done')
    expect(tasks.getOrThrow(second.id).state).toBe('running')
  })

  it('looping mode moves past a stopped task without ever restarting it', async () => {
    const orch = makeOrchestrator({ isProjectLooping: () => true })
    const first = makeTask('p1')
    const second = makeTask('p1')
    orch.delegate(first.id)

    await orch.stop(first.id)

    // The stopped task stays failed (only drafts are picked up), and the loop
    // carries on with the rest of the backlog.
    expect(tasks.getOrThrow(first.id).state).toBe('failed')
    expect(tasks.getOrThrow(second.id).state).toBe('running')
    sessions.turn(sessions.last(), COMPLETE_OK)
    expect(tasks.getOrThrow(first.id).state).toBe('failed')
    expect(tasks.getOrThrow(second.id).state).toBe('done')
  })

  it('runs with the CLI default model when the task does not pick one', () => {
    const orch = makeOrchestrator()
    orch.delegate(makeTask().id)
    expect(sessions.last().model).toBeNull()
  })

  it('forwards the task model to the run session, including on resume', async () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { model: 'opus' })
    orch.delegate(task.id)
    expect(sessions.last().model).toBe('opus')

    // A question escalates; killing the session forces the answer to resume through the SDK.
    sessions.turn(sessions.last(), status('question', 'which auth provider?'))
    sessions.kill(sessions.last(), null)
    await orch.answer(task.id, 'use OAuth')

    const resumed = sessions.last()
    expect(resumed.resumeSessionId).toBe('sdk-fake-1')
    expect(resumed.model).toBe('opus')
  })

  it('switches a live session to another model when the answer picks one', async () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { model: 'opus' })
    orch.delegate(task.id)
    const session = sessions.last()
    sessions.turn(session, status('question', 'Usage limit reached; how should I continue?'))

    await orch.answer(task.id, 'Continue on Sonnet', 'sonnet')

    // The live session is switched in place; the answer goes to the same session.
    expect(sessions.modelSwitches).toEqual([{ sessionId: session.id, model: 'sonnet' }])
    expect(sessions.sessions).toHaveLength(1)
    expect(sessions.sent[0].message).toContain('Continue on Sonnet')
    // The task definition carries the new model so later restarts inherit it.
    expect(tasks.getOrThrow(task.id).model).toBe('sonnet')
    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('active')
    expect(run.events.find((e) => e.kind === 'model-changed')?.detail).toBe(
      'Model changed from Opus to Sonnet'
    )
  })

  it('starts the resumed session on the new model when the old session has died', async () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { model: 'opus' })
    orch.delegate(task.id)
    sessions.turn(sessions.last(), status('question', 'which auth provider?'))
    sessions.kill(sessions.last(), null)

    await orch.answer(task.id, 'use OAuth', 'haiku')

    // No live switch is possible; the SDK resume starts on the new model instead.
    expect(sessions.modelSwitches).toHaveLength(0)
    const resumed = sessions.last()
    expect(resumed.resumeSessionId).toBe('sdk-fake-1')
    expect(resumed.model).toBe('haiku')
    expect(tasks.getOrThrow(task.id).model).toBe('haiku')
  })

  it('resumes an interrupted run on another model when one is picked', async () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { model: 'opus' })
    orch.delegate(task.id)
    sessions.turn(sessions.last(), status('working', 'going'))
    sessions.kill(sessions.last(), 'usage credits exhausted')

    // null switches to the CLI's default model.
    await orch.resume(task.id, null)

    expect(sessions.last().model).toBeNull()
    expect(tasks.getOrThrow(task.id).model).toBeNull()
    expect(orch.latestRun(task.id)!.events.find((e) => e.kind === 'model-changed')?.detail).toBe(
      'Model changed from Opus to Default'
    )
  })

  it('answering with the unchanged model records no model-changed event', async () => {
    const orch = makeOrchestrator()
    const task = makeTask('p1', { model: 'opus' })
    orch.delegate(task.id)
    const session = sessions.last()
    sessions.turn(session, status('question', 'which auth provider?'))

    await orch.answer(task.id, 'use OAuth', 'opus')

    // The live switch is still applied (retry semantics), but nothing changed.
    expect(sessions.modelSwitches).toEqual([{ sessionId: session.id, model: 'opus' }])
    expect(orch.latestRun(task.id)!.events.some((e) => e.kind === 'model-changed')).toBe(false)
    expect(tasks.getOrThrow(task.id).model).toBe('opus')
  })

  it('archives an accepted task and refuses to delegate it until revived', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    sessions.turn(sessions.last(), COMPLETE_OK)
    orch.accept(task.id)

    expect(tasks.getOrThrow(task.id).archived).toBe(true)
    expect(() => orch.delegate(task.id)).toThrow(/revive it first/)

    tasks.revive(task.id)
    orch.delegate(task.id)
    expect(tasks.getOrThrow(task.id).state).toBe('running')
  })

  it('stores the completion links and defaults fields missing from older persisted records', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    sessions.turn(
      sessions.last(),
      status(
        'complete',
        'built it',
        ', "gatePassed": true, "gateSummary": "patrol green", "debugUrl": "http://localhost:5173/login"' +
          ', "changesUrl": "https://github.com/o/r/pull/7"'
      ),
      0,
      ['src/login.ts']
    )
    const completed = orch.latestRun(task.id)!
    expect(completed.completion!.debugUrl).toBe('http://localhost:5173/login')
    expect(completed.completion!.changesUrl).toBe('https://github.com/o/r/pull/7')

    // Strip the fields from the persisted record to simulate a release before they existed.
    const runsPath = join(userData, 'runs.json')
    const persisted = JSON.parse(readFileSync(runsPath, 'utf8'))
    delete persisted.runs[0].completion.debugUrl
    delete persisted.runs[0].completion.changesUrl
    delete persisted.runs[0].filesChanged
    writeFileSync(runsPath, JSON.stringify(persisted))

    const orch2 = new RunOrchestrator(userData, tasks, new FakeSessions(), sink as RunEventSink, {
      claudeHome
    })
    const reloaded = orch2.latestRun(task.id)!
    expect(reloaded.completion!.debugUrl).toBeNull()
    expect(reloaded.completion!.changesUrl).toBeNull()
    expect(reloaded.filesChanged).toEqual([])
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

  it('escalates questions immediately without consuming recovery attempts', async () => {
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

    await orch.answer(task.id, 'Use SQLite')
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

  it('marks active runs interrupted on restart and resumes them by session id', async () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()
    sessions.turn(session, status('working', 'halfway through'), 5000)
    const sdkId = orch.latestRun(task.id)!.sdkSessionId
    expect(sdkId).toBe(`sdk-${session.id}`)

    // simulate a restart: fresh orchestrator over the same persisted state
    const sessions2 = new FakeSessions()
    const orch2 = new RunOrchestrator(userData, tasks, sessions2, sink as RunEventSink, { claudeHome })
    orch2.restore()

    let run = orch2.latestRun(task.id)!
    expect(run.state).toBe('interrupted')
    expect(run.progressNote).toBe('halfway through')
    expect(run.tokensUsed).toBe(5000)
    expect(run.events.map((e) => e.kind)).toContain('interrupted')
    expect(tasks.getOrThrow(task.id).state).toBe('needs-input')

    await orch2.resume(task.id)
    expect(sessions2.last().resumeSessionId).toBe(sdkId)
    run = orch2.latestRun(task.id)!
    expect(run.state).toBe('active')
    expect(tasks.getOrThrow(task.id).state).toBe('running')

    sessions2.turn(sessions2.last(), COMPLETE_OK)
    expect(tasks.getOrThrow(task.id).state).toBe('review')
  })

  it('interrupted sessions surface as resumable when the stream dies mid-run', async () => {
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

    await orch.resume(task.id)
    expect(sessions.last().resumeSessionId).toBe(`sdk-${session.id}`)
  })

  it('restarts from a fresh briefing when the session died before it had an id', async () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()

    // The stream dies before any turn (e.g. the CLI binary failed to spawn),
    // so no SDK session id was ever assigned and there is nothing to resume.
    sessions.kill(session, 'native binary failed to launch')
    let run = orch.latestRun(task.id)!
    expect(run.state).toBe('interrupted')
    expect(run.sdkSessionId).toBeNull()

    await orch.resume(task.id)
    const restarted = sessions.last()
    expect(restarted.id).not.toBe(session.id)
    expect(restarted.resumeSessionId).toBeUndefined()
    expect(restarted.prompt).toContain('Build the login page')
    expect(restarted.prompt).toContain('apt-status')
    run = orch.latestRun(task.id)!
    expect(run.state).toBe('active')
    expect(run.events.filter((e) => e.kind === 'started')).toHaveLength(2)
    expect(tasks.getOrThrow(task.id).state).toBe('running')

    sessions.turn(restarted, COMPLETE_OK)
    expect(tasks.getOrThrow(task.id).state).toBe('review')
  })

  it('carries the user answer into the restart briefing when nothing can be resumed', async () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    sessions.kill(sessions.last(), 'native binary failed to launch')

    await orch.answer(task.id, 'Try again; the binary is fixed now')
    const restarted = sessions.last()
    expect(restarted.resumeSessionId).toBeUndefined()
    expect(restarted.prompt).toContain('Build the login page')
    expect(restarted.prompt).toContain('Additional direction from the user')
    expect(restarted.prompt).toContain('Try again; the binary is fixed now')
    expect(tasks.getOrThrow(task.id).state).toBe('running')
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

  it('creates draft backlog tasks from apt-task blocks when the project allows it', () => {
    const orch = makeOrchestrator({ allowAgentTasks: (id) => id === 'p1' })
    const task = makeTask()
    orch.delegate(task.id)
    // The briefing invites proposals only because the project allows them.
    expect(sessions.last().prompt).toContain('apt-task')

    sessions.turn(
      sessions.last(),
      `${taskBlock('Report: flaky login test')}\n${status('working', 'scouting')}`
    )

    const created = tasks.listTasks('p1').find((t) => t.title === 'Report: flaky login test')
    expect(created).toMatchObject({
      state: 'draft',
      purpose: 'Because it matters',
      acceptanceCriteria: ['done'],
      archived: false
    })
    // The proposing run keeps working and records the creation in its timeline.
    const run = orch.latestRun(task.id)!
    expect(run.state).toBe('active')
    expect(run.events.find((e) => e.kind === 'task-created')?.detail).toContain('Report: flaky login test')
    // Drafts wait for the user: no new run was started for the proposal.
    expect(sessions.sessions).toHaveLength(1)
  })

  it('ignores apt-task blocks when the project does not allow agent task creation', () => {
    const orch = makeOrchestrator()
    const task = makeTask()
    orch.delegate(task.id)
    expect(sessions.last().prompt).not.toContain('apt-task')

    sessions.turn(sessions.last(), `${taskBlock('Sneaky extra work')}\n${status('working', 'scouting')}`)

    expect(tasks.listTasks('p1')).toHaveLength(1)
    expect(orch.latestRun(task.id)!.events.some((e) => e.kind === 'task-created')).toBe(false)
  })

  it('consults the agent-tasks toggle live: turning it off mid-run stops creation', () => {
    const allowed = new Set(['p1'])
    const orch = makeOrchestrator({ allowAgentTasks: (id) => allowed.has(id) })
    const task = makeTask()
    orch.delegate(task.id)

    allowed.delete('p1')
    sessions.turn(sessions.last(), `${taskBlock('Too late')}\n${status('working', 'scouting')}`)

    expect(tasks.listTasks('p1')).toHaveLength(1)
  })

  it('skips proposals whose title matches an existing unarchived task', () => {
    const orch = makeOrchestrator({ allowAgentTasks: () => true })
    const task = makeTask()
    orch.delegate(task.id)
    const session = sessions.last()

    // Duplicates within one turn and across turns collapse to a single draft.
    sessions.turn(
      session,
      `${taskBlock('Improve logging')}\n${taskBlock('improve logging')}\n${status('working', 'one')}`
    )
    sessions.turn(session, `${taskBlock('Improve logging')}\n${status('working', 'two')}`)

    expect(tasks.listTasks('p1').filter((t) => t.title.toLowerCase() === 'improve logging')).toHaveLength(1)
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
      paused: 0,
      activeTaskTitle: 'Running task',
      activeProgressNote: 'building the form'
    })
  })

  describe('pause and requeue', () => {
    it('pauses a running task, interrupting its session and freeing the project for the next queued task', async () => {
      const orch = makeOrchestrator()
      const first = makeTask('p1', { title: 'Blocked on upstream' })
      const second = makeTask('p1', { title: 'Next in line' })
      orch.delegate(first.id)
      orch.delegate(second.id)
      const session = sessions.last()
      sessions.turn(session, status('working', 'digging into the upstream dependency'))
      expect(tasks.getOrThrow(second.id).state).toBe('queued')

      await orch.pause(first.id)

      expect(sessions.interrupted).toContain(session.id)
      const run = orch.latestRun(first.id)!
      expect(run.state).toBe('interrupted')
      expect(run.escalation).toMatchObject({ kind: 'interrupted', message: 'Paused by the user' })
      expect(run.events.map((e) => e.kind)).toContain('paused')
      expect(tasks.getOrThrow(first.id).state).toBe('paused')

      // Pausing frees the project immediately: the next queued task starts.
      expect(tasks.getOrThrow(second.id).state).toBe('running')
    })

    it('pauses a queued task that never started, with no run to touch', async () => {
      const orch = makeOrchestrator({ maxConcurrentRuns: 1 })
      const first = makeTask('p1', { title: 'Running' })
      const second = makeTask('p1', { title: 'Waiting' })
      orch.delegate(first.id)
      orch.delegate(second.id)
      expect(tasks.getOrThrow(second.id).state).toBe('queued')

      await orch.pause(second.id)

      expect(tasks.getOrThrow(second.id).state).toBe('paused')
      expect(orch.latestRun(second.id)).toBeNull()
      // The first task is untouched; it keeps running.
      expect(tasks.getOrThrow(first.id).state).toBe('running')
    })

    it('pauses a needs-input task so it no longer blocks its project', async () => {
      const orch = makeOrchestrator()
      const first = makeTask('p1')
      const second = makeTask('p1', { title: 'Waiting behind the block' })
      orch.delegate(first.id)
      orch.delegate(second.id)
      sessions.turn(sessions.last(), status('question', 'which auth provider?'))
      expect(tasks.getOrThrow(first.id).state).toBe('needs-input')
      expect(tasks.getOrThrow(second.id).state).toBe('queued')

      await orch.pause(first.id)

      expect(tasks.getOrThrow(first.id).state).toBe('paused')
      expect(orch.latestRun(first.id)!.state).toBe('interrupted')
      expect(tasks.getOrThrow(second.id).state).toBe('running')
    })

    it.each(['draft', 'review', 'done', 'failed'] as const)(
      'refuses to pause a task in %s state',
      async (state) => {
        const orch = makeOrchestrator()
        const task = makeTask()
        tasks.setState(task.id, state)
        await expect(orch.pause(task.id)).rejects.toThrow(/cannot be paused/)
      }
    )

    it('requeues a paused task, resuming its parked run instead of starting a fresh briefing', async () => {
      const orch = makeOrchestrator()
      const task = makeTask('p1', { title: 'Blocked on upstream' })
      orch.delegate(task.id)
      const firstSession = sessions.last()
      sessions.turn(firstSession, status('working', 'digging in'))
      await orch.pause(task.id)

      orch.requeue(task.id)

      // The requeued task resumes the same session rather than starting a new one.
      expect(sessions.sessions).toHaveLength(1)
      expect(sessions.sent.at(-1)?.sessionId).toBe(firstSession.id)
      expect(orch.latestRun(task.id)!.events.map((e) => e.kind)).toContain('resumed')
      expect(tasks.getOrThrow(task.id).state).toBe('running')

      sessions.turn(firstSession, COMPLETE_OK)
      expect(tasks.getOrThrow(task.id).state).toBe('review')
    })

    it('requeues a paused task that never had a run, starting it fresh', async () => {
      const orch = makeOrchestrator({ maxConcurrentRuns: 1 })
      const first = makeTask('p1', { title: 'Running' })
      const second = makeTask('p1', { title: 'Paused before it started' })
      orch.delegate(first.id)
      orch.delegate(second.id)
      await orch.pause(second.id)

      orch.requeue(second.id)
      // Capacity is still full with the first task running, so it waits queued.
      expect(tasks.getOrThrow(second.id).state).toBe('queued')

      sessions.turn(sessions.sessions[0], COMPLETE_OK)
      expect(tasks.getOrThrow(second.id).state).toBe('running')
      expect(sessions.last().prompt).toContain('Paused before it started')
    })

    it('refuses to requeue a task that is not paused', () => {
      const orch = makeOrchestrator()
      const task = makeTask()
      expect(() => orch.requeue(task.id)).toThrow(/not paused/)
    })

    it('lets the user give up on a paused task by marking it failed', async () => {
      const orch = makeOrchestrator()
      const task = makeTask()
      orch.delegate(task.id)
      sessions.turn(sessions.last(), status('working', 'going'))
      await orch.pause(task.id)

      await orch.stop(task.id)

      expect(tasks.getOrThrow(task.id).state).toBe('failed')
      expect(orch.latestRun(task.id)!.state).toBe('failed')
    })
  })
})
