import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  DelegationSummary,
  RunEscalationKind,
  RunEvent,
  RunRecord,
  RunStatusReport,
  SessionPermissionMode,
  SessionState,
  SessionSummary,
  TaskDefinition,
  TaskState
} from '@shared/domain'
import { ACTIVE_TASK_STATES, agentModelLabel } from '@shared/domain'
import {
  RESUME_PROMPT,
  STATUS_REPROMPT,
  buildAnswer,
  buildBriefing,
  buildNudge,
  hasWorkspaceWorkflow,
  parseStatusBlock,
  parseTaskBlocks
} from './RunProtocol'
import type { SessionOwner, RunSessionObserver } from './SessionService'
import type { TaskService } from './TaskService'

const DEFAULT_MAX_CONCURRENT_RUNS = 3

/** States from which a task may be manually paused (see RunOrchestrator.pause). */
const PAUSABLE_STATES: ReadonlySet<TaskState> = new Set(['queued', 'running', 'needs-input'])

interface RunsFile {
  version: 1
  runs: RunRecord[]
}

/** The slice of SessionService the orchestrator drives (design D1). */
export interface RunSessionPort {
  startOwnedSession(
    projectId: string,
    prompt: string,
    mode: SessionPermissionMode,
    model: string | null,
    owner: SessionOwner,
    observer: RunSessionObserver,
    resumeSessionId?: string
  ): SessionSummary
  sendToSession(sessionId: string, message: string): void
  /** Switch a live session's model; rejects when the session has ended. */
  setSessionModel(sessionId: string, model: string | null): Promise<void>
  isSessionAlive(sessionId: string): boolean
  sdkSessionIdFor(sessionId: string): string | null
  interruptSession(projectId: string, sessionId: string): Promise<void>
}

export interface RunEventSink {
  runUpdated(run: RunRecord): void
}

export interface RunOrchestratorOptions {
  /** Claude home dir for workspace-skill detection; the APT_CLAUDE_HOME seam is applied by the caller. */
  claudeHome?: string
  maxConcurrentRuns?: number
  /**
   * Whether a project has looping mode enabled (see Project.looping); the
   * scheduler consults it on every pass. Defaults to looping never being on.
   */
  isProjectLooping?: (projectId: string) => boolean
  /**
   * Whether a project lets agents create backlog tasks (see
   * Project.agentTaskCreation); consulted at briefing time and again on every
   * turn, so flipping the toggle takes effect mid-run. Defaults to never.
   */
  allowAgentTasks?: (projectId: string) => boolean
}

/** Per-run state that only matters while the app is alive. */
interface RunRuntime {
  /** True after one STATUS_REPROMPT was sent for a missing status block. */
  awaitingReprompt: boolean
  /** True while a manual stop is interrupting the session. */
  stopping: boolean
}

/**
 * Supervises delegated tasks end to end (design D1): starts owned sessions
 * through SessionService, drives the working/question/blocked/complete state
 * machine from parsed status reports, recovers within budgets, and hands
 * completed runs to the user for review.
 */
export class RunOrchestrator {
  private readonly filePath: string
  private runs: RunRecord[] = []
  private readonly runtime = new Map<string, RunRuntime>()
  private readonly maxConcurrentRuns: number
  private readonly claudeHome: string | undefined
  private readonly isProjectLooping: (projectId: string) => boolean
  private readonly allowAgentTasks: (projectId: string) => boolean

  constructor(
    userDataDir: string,
    private readonly tasks: TaskService,
    private readonly sessions: RunSessionPort,
    private readonly sink: RunEventSink,
    options: RunOrchestratorOptions = {}
  ) {
    this.filePath = join(userDataDir, 'runs.json')
    this.claudeHome = options.claudeHome
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS
    this.isProjectLooping = options.isProjectLooping ?? (() => false)
    this.allowAgentTasks = options.allowAgentTasks ?? (() => false)
    this.load()
  }

  /**
   * Reconcile persisted state after an app start: runs that were active at
   * shutdown become interrupted (resumable), and queued tasks start when
   * capacity allows.
   */
  restore(): void {
    for (const run of this.runs) {
      if (run.state !== 'active') continue
      run.state = 'interrupted'
      run.escalation = {
        kind: 'interrupted',
        message: 'The app was closed while this run was active',
        history: this.failureHistory(run),
        at: new Date().toISOString()
      }
      this.pushEvent(run, 'interrupted', 'App restarted while the run was active')
      const task = this.tasks.get(run.taskId)
      if (task && (task.state === 'running' || task.state === 'needs-input')) {
        this.tasks.setState(task.id, 'needs-input')
      }
      this.sink.runUpdated(run)
    }
    this.save()
    this.pump()
  }

  list(): RunRecord[] {
    return [...this.runs]
  }

  /** Latest run for a task; null when it was never delegated. */
  latestRun(taskId: string): RunRecord | null {
    const candidates = this.runs.filter((r) => r.taskId === taskId)
    if (candidates.length === 0) return null
    return candidates.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b))
  }

  /** Task attribution for a session discovered from storage (post-restart listings). */
  attributionFor(sdkSessionId: string): SessionOwner | null {
    const run = this.runs.find((r) => r.sdkSessionId === sdkSessionId)
    if (!run) return null
    const task = this.tasks.get(run.taskId)
    return { taskId: run.taskId, taskTitle: task?.title ?? run.taskId, runId: run.id }
  }

  /** Dashboard rollup of backlog counts and the active run's progress. */
  delegationSummary(projectId: string): DelegationSummary {
    const tasks = this.tasks.listTasks(projectId)
    const runningTask = tasks.find((t) => t.state === 'running')
    const activeRun = runningTask ? this.latestRun(runningTask.id) : null
    return {
      queued: tasks.filter((t) => t.state === 'queued').length,
      running: tasks.filter((t) => t.state === 'running').length,
      needsInput: tasks.filter((t) => t.state === 'needs-input').length,
      review: tasks.filter((t) => t.state === 'review').length,
      paused: tasks.filter((t) => t.state === 'paused').length,
      activeTaskTitle: runningTask?.title ?? null,
      activeProgressNote: activeRun?.progressNote ?? null
    }
  }

  /** Queue a task for execution; it starts immediately when capacity allows. */
  delegate(taskId: string): TaskDefinition {
    const task = this.tasks.getOrThrow(taskId)
    if (task.archived) throw new Error('Task is archived; revive it first')
    if (!['draft', 'done', 'failed'].includes(task.state)) {
      throw new Error(`Task cannot be delegated from state '${task.state}'`)
    }
    this.tasks.setState(taskId, 'queued')
    this.pump()
    // pump() may already have moved it to running.
    return this.tasks.getOrThrow(taskId)
  }

  /**
   * Deliver the user's answer to an escalated run; resumes the session if
   * needed. An explicit `model` switches the run to that model first (see
   * switchModel); undefined keeps the task's model.
   */
  async answer(taskId: string, answerText: string, model?: string | null): Promise<void> {
    let task = this.tasks.getOrThrow(taskId)
    if (task.state !== 'needs-input') throw new Error('Task is not waiting for input')
    const run = this.requireRun(taskId)
    if (model !== undefined) task = await this.switchModel(run, task, model)
    this.pushEvent(run, 'answered', answerText)
    this.resumeWith(run, task, buildAnswer(answerText), answerText)
  }

  /** Manually stop an active run; the task moves to failed with history retained. */
  async stop(taskId: string): Promise<void> {
    const task = this.tasks.getOrThrow(taskId)
    const run = this.requireRun(taskId)
    if (!['running', 'needs-input'].includes(task.state) && run.state !== 'interrupted') {
      throw new Error('Task has no active run to stop')
    }
    this.runtimeFor(run.id).stopping = true
    if (this.sessions.isSessionAlive(run.sessionId)) {
      await this.sessions.interruptSession(run.projectId, run.sessionId)
    }
    this.endRun(run, 'failed', 'stopped', 'Stopped by the user')
    this.tasks.setState(taskId, 'failed')
    this.pump()
  }

  /**
   * Reattach an interrupted run to its session and continue. An explicit
   * `model` switches the run to that model first (see switchModel); undefined
   * keeps the task's model.
   */
  async resume(taskId: string, model?: string | null): Promise<void> {
    let task = this.tasks.getOrThrow(taskId)
    const run = this.requireRun(taskId)
    if (run.state !== 'interrupted') throw new Error('Only interrupted runs can be resumed')
    this.assertCapacityFor(run)
    if (model !== undefined) task = await this.switchModel(run, task, model)
    this.pushEvent(run, 'resumed', 'Resumed by the user')
    this.resumeWith(run, task, RESUME_PROMPT)
  }

  /** Accept a reviewed task as done. */
  accept(taskId: string): void {
    const task = this.tasks.getOrThrow(taskId)
    if (task.state !== 'review') throw new Error('Task is not awaiting review')
    const run = this.requireRun(taskId)
    this.finishAccepted(run, task, 'Accepted by the user')
    this.pump()
  }

  /** Move a reviewed run and its task to done. Shared by manual and auto-approve accepts. */
  private finishAccepted(run: RunRecord, task: TaskDefinition, detail: string): void {
    this.endRun(run, 'done', 'accepted', detail)
    this.tasks.setReviewFeedback(task.id, null)
    this.tasks.setState(task.id, 'done')
  }

  /** Send a reviewed task back: re-queue it with feedback for the next briefing. */
  sendBack(taskId: string, feedback: string): void {
    const task = this.tasks.getOrThrow(taskId)
    if (task.state !== 'review') throw new Error('Task is not awaiting review')
    const run = this.requireRun(taskId)
    this.endRun(run, 'done', 'sent-back', feedback)
    this.tasks.setReviewFeedback(taskId, feedback)
    this.tasks.setState(taskId, 'queued')
    this.pump()
  }

  /**
   * Manually park a queued, running, or needs-input task without discarding
   * its run: a live session is interrupted, but (unlike stop(), which ends
   * the run in failed) the run is parked as interrupted so requeue() can pick
   * it back up. The task drops out of projectBusy immediately (see pump/
   * startCandidates), freeing its project for other queued work right away -
   * the escape hatch for a task blocked on something outside the agent's
   * control, e.g. an upstream review or a dependency update from a third
   * party.
   */
  async pause(taskId: string): Promise<void> {
    const task = this.tasks.getOrThrow(taskId)
    if (!PAUSABLE_STATES.has(task.state)) {
      throw new Error(`Task cannot be paused from state '${task.state}'`)
    }
    const run = this.latestRun(taskId)
    if (run && (run.state === 'active' || run.state === 'needs-input')) {
      this.runtimeFor(run.id).stopping = true
      if (this.sessions.isSessionAlive(run.sessionId)) {
        await this.sessions.interruptSession(run.projectId, run.sessionId)
      }
      run.state = 'interrupted'
      run.escalation = {
        kind: 'interrupted',
        message: 'Paused by the user',
        history: this.failureHistory(run),
        at: new Date().toISOString()
      }
      this.pushEvent(run, 'paused', 'Paused by the user')
      this.commit(run)
    }
    this.tasks.setState(taskId, 'paused')
    this.pump()
  }

  /**
   * Return a paused task to the queue; it starts (or resumes a parked run,
   * see beginRun) when capacity allows, same as any other queued task.
   */
  requeue(taskId: string): TaskDefinition {
    const task = this.tasks.getOrThrow(taskId)
    if (task.state !== 'paused') throw new Error('Task is not paused')
    this.tasks.setState(taskId, 'queued')
    this.pump()
    return this.tasks.getOrThrow(taskId)
  }

  // ---------- Scheduling ----------

  /**
   * Re-run the scheduler after an external scheduling input changed, e.g. the
   * user toggled a project's looping mode. Turning looping on takes effect
   * immediately: runs parked in review are auto-approved and the backlog is
   * picked up without waiting for the next run event.
   */
  reschedule(): void {
    this.pump()
  }

  /** Start queued tasks in order while per-project exclusivity and the global cap allow. */
  private pump(): void {
    this.pumpLooping()
    for (const task of this.startCandidates()) {
      if (this.activeRunCount() >= this.maxConcurrentRuns) return
      this.beginRun(task)
    }
  }

  /**
   * Start a queued task's next run. When its latest run is still parked as
   * interrupted - the shape a task is left in after pause() - reattach to it
   * instead of starting a fresh briefing, so a requeued task's agent picks up
   * where it left off; otherwise start clean, same as any first delegation.
   */
  private beginRun(task: TaskDefinition): void {
    const run = this.latestRun(task.id)
    if (run && run.state === 'interrupted') {
      this.pushEvent(run, 'resumed', 'Resumed after being requeued')
      this.resumeWith(run, task, RESUME_PROMPT)
    } else {
      this.startRun(task)
    }
  }

  /**
   * Apply looping mode (see Project.looping) before regular scheduling: in
   * looping projects, runs parked in review are approved automatically (the
   * user's sign-off is skipped), and when a project is otherwise idle the
   * first loop-enabled draft task in backlog order is queued so the agent
   * picks it up (tasks toggled out of the loop are skipped; see
   * TaskDefinition.loopEnabled). Questions and failures are untouched:
   * needs-input still blocks the loop until the user responds.
   */
  private pumpLooping(): void {
    const all = this.tasks.listAll()
    // Approve parked reviews first so their projects are free for the pickup pass.
    for (const task of all) {
      if (task.state !== 'review' || !this.isProjectLooping(task.projectId)) continue
      const run = this.latestRun(task.id)
      if (run?.state === 'review') this.finishAccepted(run, task, 'Auto-approved by looping mode')
    }
    const idleLoopingProjects = new Set(
      all
        .map((t) => t.projectId)
        .filter(
          (projectId) =>
            this.isProjectLooping(projectId) &&
            !this.projectBusy(projectId) &&
            !all.some((t) => t.projectId === projectId && ACTIVE_TASK_STATES.includes(t.state))
        )
    )
    for (const projectId of idleLoopingProjects) {
      const next = this.tasks
        .listTasks(projectId)
        .find((t) => t.state === 'draft' && !t.archived && t.loopEnabled)
      if (next) this.tasks.setState(next.id, 'queued')
    }
  }

  /**
   * Head of each project's queued backlog (backlog order decides within a
   * project), FIFO by queue time across projects, skipping busy projects.
   */
  private startCandidates(): TaskDefinition[] {
    const queuedByProject = new Map<string, TaskDefinition[]>()
    for (const task of this.tasks.listAll()) {
      if (task.state !== 'queued') continue
      const list = queuedByProject.get(task.projectId) ?? []
      list.push(task)
      queuedByProject.set(task.projectId, list)
    }
    const heads: TaskDefinition[] = []
    for (const [projectId, tasks] of queuedByProject) {
      if (this.projectBusy(projectId)) continue
      heads.push(tasks.sort((a, b) => a.order - b.order)[0])
    }
    return heads.sort((a, b) => queuedAt(a).localeCompare(queuedAt(b)))
  }

  private activeRunCount(): number {
    return this.runs.filter((r) => r.state === 'active').length
  }

  private projectBusy(projectId: string): boolean {
    return this.runs.some(
      (r) => r.projectId === projectId && (r.state === 'active' || r.state === 'needs-input')
    )
  }

  private assertCapacityFor(run: RunRecord): void {
    if (this.runs.some((r) => r.id !== run.id && r.projectId === run.projectId && r.state === 'active')) {
      throw new Error('Another run is already active in this project')
    }
    if (this.activeRunCount() >= this.maxConcurrentRuns) {
      throw new Error('The global concurrent-run limit is reached; stop or finish another run first')
    }
  }

  private startRun(task: TaskDefinition): void {
    const workflowVerified = hasWorkspaceWorkflow(this.claudeHome)
    const now = new Date().toISOString()
    const run: RunRecord = {
      id: randomUUID(),
      taskId: task.id,
      projectId: task.projectId,
      sessionId: '',
      sdkSessionId: null,
      state: 'active',
      progressNote: null,
      escalation: null,
      nudgesUsed: 0,
      stepsUsed: 0,
      tokensUsed: 0,
      filesChanged: [],
      completion: null,
      workflowVerified,
      events: [
        { kind: 'started', detail: workflowVerified ? '' : 'Workspace workflow not detected', at: now }
      ],
      startedAt: now,
      endedAt: null
    }
    this.runs.push(run)
    const briefing = buildBriefing({
      task,
      workflowVerified,
      allowTaskCreation: this.allowAgentTasks(task.projectId)
    })
    const summary = this.sessions.startOwnedSession(
      task.projectId,
      briefing,
      task.mode,
      task.model,
      { taskId: task.id, taskTitle: task.title, runId: run.id },
      this.observerFor(run)
    )
    run.sessionId = summary.id
    this.tasks.setState(task.id, 'running')
    this.commit(run)
  }

  /**
   * Switch the model driving a parked run before it resumes, the escape hatch
   * when the current model's usage credits run out mid-task. The task
   * definition is updated first so any later session start inherits the
   * choice, then a still-live session is switched in place through the SDK.
   * The live switch is attempted even when the model is unchanged, so
   * retrying after a failed switch still reaches the session.
   */
  private async switchModel(
    run: RunRecord,
    task: TaskDefinition,
    model: string | null
  ): Promise<TaskDefinition> {
    // Capture the previous model first: setModel mutates the shared task object.
    const previousModel = task.model
    const updated = this.tasks.setModel(task.id, model)
    if (updated.model !== previousModel) {
      this.pushEvent(
        run,
        'model-changed',
        `Model changed from ${agentModelLabel(previousModel)} to ${agentModelLabel(updated.model)}`
      )
    }
    if (this.sessions.isSessionAlive(run.sessionId)) {
      await this.sessions.setSessionModel(run.sessionId, updated.model)
    }
    return updated
  }

  /**
   * Send a follow-up to the run's session, resuming it through the SDK when it
   * has ended. When the session died before the CLI assigned it an id (it
   * likely never spawned), there is no conversation to resume: restart from a
   * fresh briefing instead of dead-ending the task, carrying userContext (the
   * user's answer, when there is one) into the new briefing.
   */
  private resumeWith(
    run: RunRecord,
    task: TaskDefinition,
    message: string,
    userContext: string | null = null
  ): void {
    if (this.sessions.isSessionAlive(run.sessionId)) {
      this.sessions.sendToSession(run.sessionId, message)
    } else {
      const owner = { taskId: task.id, taskTitle: task.title, runId: run.id }
      let summary: SessionSummary
      if (run.sdkSessionId) {
        summary = this.sessions.startOwnedSession(
          run.projectId,
          message,
          task.mode,
          task.model,
          owner,
          this.observerFor(run),
          run.sdkSessionId
        )
      } else {
        run.workflowVerified = hasWorkspaceWorkflow(this.claudeHome)
        const briefing = buildBriefing({
          task,
          workflowVerified: run.workflowVerified,
          allowTaskCreation: this.allowAgentTasks(run.projectId)
        })
        const prompt = userContext
          ? `${briefing}\n\n# Additional direction from the user\n\n${userContext.trim()}`
          : briefing
        this.pushEvent(run, 'started', 'No session to resume; restarted from a fresh briefing')
        summary = this.sessions.startOwnedSession(
          run.projectId,
          prompt,
          task.mode,
          task.model,
          owner,
          this.observerFor(run)
        )
      }
      run.sessionId = summary.id
    }
    run.state = 'active'
    run.escalation = null
    this.tasks.setState(task.id, 'running')
    this.commit(run)
  }

  // ---------- Session observation ----------

  private observerFor(run: RunRecord): RunSessionObserver {
    return {
      turnCompleted: (_sessionId, assistantText, turnTokens, changedFiles) =>
        this.onTurnCompleted(run, assistantText, turnTokens, changedFiles),
      stateChanged: (_sessionId, state) => this.onStateChanged(run, state),
      closed: (_sessionId, error) => this.onSessionClosed(run, error)
    }
  }

  private onTurnCompleted(
    run: RunRecord,
    assistantText: string,
    turnTokens: number,
    changedFiles: string[]
  ): void {
    if (run.state !== 'active') return
    run.sdkSessionId = this.sessions.sdkSessionIdFor(run.sessionId) ?? run.sdkSessionId
    run.stepsUsed++
    run.tokensUsed += turnTokens
    for (const file of changedFiles) {
      if (!run.filesChanged.includes(file)) run.filesChanged.push(file)
    }
    const task = this.tasks.get(run.taskId)
    if (!task) return
    this.createProposedTasks(run, assistantText)
    if (run.stepsUsed > task.stepBudget) {
      this.exceedStepBudget(run, task)
      return
    }

    const report = parseStatusBlock(assistantText)
    const rt = this.runtimeFor(run.id)
    if (!report) {
      if (!rt.awaitingReprompt) {
        rt.awaitingReprompt = true
        this.sessions.sendToSession(run.sessionId, STATUS_REPROMPT)
        this.commit(run)
      } else {
        rt.awaitingReprompt = false
        this.recover(
          run,
          task,
          'The agent stopped reporting its status (no apt-status block after a re-prompt)'
        )
      }
      return
    }
    rt.awaitingReprompt = false
    this.handleReport(run, task, report)
  }

  /**
   * Create backlog drafts from the turn's apt-task blocks (see
   * Project.agentTaskCreation). The toggle is consulted here, at consumption
   * time, so turning it off silences an already-briefed agent immediately.
   * Proposals whose title matches an existing unarchived task in the project
   * are skipped, so an agent repeating its blocks cannot flood the backlog.
   */
  private createProposedTasks(run: RunRecord, assistantText: string): void {
    if (!this.allowAgentTasks(run.projectId)) return
    let created = false
    for (const proposal of parseTaskBlocks(assistantText)) {
      const duplicate = this.tasks
        .listTasks(run.projectId)
        .some((t) => !t.archived && t.title.toLowerCase() === proposal.title.toLowerCase())
      if (duplicate) continue
      this.tasks.create(run.projectId, {
        title: proposal.title,
        purpose: proposal.purpose,
        acceptanceCriteria: proposal.acceptanceCriteria
      })
      this.pushEvent(run, 'task-created', `Added draft task "${proposal.title}" to the backlog`)
      created = true
    }
    if (created) this.commit(run)
  }

  private handleReport(run: RunRecord, task: TaskDefinition, report: RunStatusReport): void {
    switch (report.state) {
      case 'working':
        run.progressNote = report.note || run.progressNote
        this.pushEvent(run, 'status', report.note)
        this.commit(run)
        break
      case 'question':
        // Decision points skip recovery and go straight to the user (design D4).
        this.escalate(run, task, 'question', report.note || 'The agent asked for direction')
        break
      case 'blocked':
        this.recover(run, task, report.note || 'The agent reported it is blocked')
        break
      case 'complete':
        if (report.gatePassed === true) {
          this.complete(run, task, report)
        } else {
          this.recover(
            run,
            task,
            `Completion was claimed without a passing quality gate (gatePassed: ${String(report.gatePassed)}). ` +
              'Run the full quality gate, fix what fails, and only report complete when it passes.'
          )
        }
        break
    }
  }

  private onStateChanged(run: RunRecord, state: SessionState): void {
    // The user answered the session directly (Sessions tab or answerRun): the
    // escalation is resolved by the underlying state change, so the run resumes.
    if (state === 'running' && run.state === 'needs-input') {
      run.state = 'active'
      run.escalation = null
      const task = this.tasks.get(run.taskId)
      if (task && task.state === 'needs-input') this.tasks.setState(task.id, 'running')
      this.commit(run)
    }
  }

  private onSessionClosed(run: RunRecord, error: string | null): void {
    if (run.state !== 'active' || this.runtimeFor(run.id).stopping) return
    run.state = 'interrupted'
    run.escalation = {
      kind: 'interrupted',
      message: error ? `The session ended with an error: ${error}` : 'The session ended unexpectedly',
      history: this.failureHistory(run),
      at: new Date().toISOString()
    }
    this.pushEvent(run, 'interrupted', error ?? 'Session ended unexpectedly')
    const task = this.tasks.get(run.taskId)
    if (task && task.state === 'running') this.tasks.setState(task.id, 'needs-input')
    this.commit(run)
  }

  // ---------- Recovery and escalation ----------

  /** Bounded auto-recovery (design D4): nudge the same session until the budget runs out. */
  private recover(run: RunRecord, task: TaskDefinition, context: string): void {
    if (run.nudgesUsed >= task.recoveryBudget) {
      this.escalate(run, task, 'recovery-exhausted', context)
      return
    }
    run.nudgesUsed++
    this.pushEvent(run, 'nudge', context)
    this.sessions.sendToSession(run.sessionId, buildNudge(context))
    this.commit(run)
  }

  private exceedStepBudget(run: RunRecord, task: TaskDefinition): void {
    this.escalate(
      run,
      task,
      'step-budget',
      `The run used ${run.stepsUsed} agent turns, exceeding its budget of ${task.stepBudget}`
    )
    if (this.sessions.isSessionAlive(run.sessionId)) {
      void this.sessions.interruptSession(run.projectId, run.sessionId)
    }
  }

  private escalate(run: RunRecord, task: TaskDefinition, kind: RunEscalationKind, message: string): void {
    run.state = 'needs-input'
    run.escalation = { kind, message, history: this.failureHistory(run), at: new Date().toISOString() }
    this.pushEvent(run, 'escalated', message)
    this.tasks.setState(task.id, 'needs-input')
    this.commit(run)
  }

  private complete(run: RunRecord, task: TaskDefinition, report: RunStatusReport): void {
    run.state = 'review'
    run.progressNote = report.note || run.progressNote
    run.completion = {
      summary: report.note,
      gatePassed: true,
      gateSummary: report.gateSummary,
      debugUrl: report.debugUrl,
      changesUrl: report.changesUrl,
      at: new Date().toISOString()
    }
    this.pushEvent(run, 'completed', report.note)
    this.tasks.setState(task.id, 'review')
    this.commit(run)
    // Auto-approve tasks skip the user's sign-off: a clean completion (the gate
    // passed, which is the only way we reach here) is accepted straight away.
    if (task.autoApprove) this.finishAccepted(run, task, 'Auto-approved on completion')
    this.pump()
  }

  private endRun(run: RunRecord, state: 'done' | 'failed', kind: RunEvent['kind'], detail: string): void {
    run.state = state
    run.escalation = null
    run.endedAt = new Date().toISOString()
    this.pushEvent(run, kind, detail)
    this.commit(run)
  }

  // ---------- Internals ----------

  private requireRun(taskId: string): RunRecord {
    const run = this.latestRun(taskId)
    if (!run) throw new Error('Task has no run')
    return run
  }

  private runtimeFor(runId: string): RunRuntime {
    let rt = this.runtime.get(runId)
    if (!rt) {
      rt = { awaitingReprompt: false, stopping: false }
      this.runtime.set(runId, rt)
    }
    return rt
  }

  /** Failure context accumulated so far, reconstructed from nudge events. */
  private failureHistory(run: RunRecord): string[] {
    return run.events.filter((e) => e.kind === 'nudge').map((e) => e.detail)
  }

  private pushEvent(run: RunRecord, kind: RunEvent['kind'], detail: string): void {
    run.events.push({ kind, detail, at: new Date().toISOString() })
  }

  private commit(run: RunRecord): void {
    this.save()
    this.sink.runUpdated(run)
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      this.runs = []
      return
    }
    const parsed = JSON.parse(raw) as RunsFile
    // tokensUsed, filesChanged, and the completion links were added after the
    // first release; default them for older records.
    this.runs = (Array.isArray(parsed.runs) ? parsed.runs : []).map((run) => ({
      ...run,
      tokensUsed: run.tokensUsed ?? 0,
      filesChanged: run.filesChanged ?? [],
      completion: run.completion
        ? {
            ...run.completion,
            debugUrl: run.completion.debugUrl ?? null,
            changesUrl: run.completion.changesUrl ?? null
          }
        : null
    }))
  }

  private save(): void {
    const file: RunsFile = { version: 1, runs: this.runs }
    const tmpPath = this.filePath + '.tmp'
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmpPath, this.filePath)
  }
}

function queuedAt(task: TaskDefinition): string {
  for (let i = task.transitions.length - 1; i >= 0; i--) {
    if (task.transitions[i].state === 'queued') return task.transitions[i].at
  }
  return task.updatedAt
}
