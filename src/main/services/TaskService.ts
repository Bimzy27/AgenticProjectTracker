import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TaskDefinition, TaskInput, TaskPatch, TaskState } from '@shared/domain'

const DEFAULT_STEP_BUDGET = 30
const DEFAULT_RECOVERY_BUDGET = 3

/** States in which a run session is live, so the definition must not shift under it. */
const ACTIVE_STATES: ReadonlySet<TaskState> = new Set(['running', 'needs-input'])

/** Settled states from which a task may be archived; delegated work must finish or be stopped first. */
const ARCHIVABLE_STATES: ReadonlySet<TaskState> = new Set(['draft', 'done', 'failed'])

interface TasksFile {
  version: 1
  tasks: TaskDefinition[]
}

export interface TaskEventSink {
  tasksChanged(projectId: string, tasks: TaskDefinition[]): void
}

/**
 * Per-project task backlog with JSON-file persistence.
 * Follows the ProjectStore pattern: loaded on construction, every mutation
 * written atomically via temp file + rename.
 */
export class TaskService {
  private readonly filePath: string
  private tasks: TaskDefinition[] = []

  constructor(
    userDataDir: string,
    private readonly sink: TaskEventSink
  ) {
    this.filePath = join(userDataDir, 'tasks.json')
    this.load()
  }

  /** Tasks for one project in backlog order. */
  listTasks(projectId: string): TaskDefinition[] {
    return this.tasks.filter((t) => t.projectId === projectId).sort((a, b) => a.order - b.order)
  }

  /** All tasks across projects; used by the orchestrator's scheduler. */
  listAll(): TaskDefinition[] {
    return [...this.tasks]
  }

  get(taskId: string): TaskDefinition | undefined {
    return this.tasks.find((t) => t.id === taskId)
  }

  getOrThrow(taskId: string): TaskDefinition {
    const task = this.get(taskId)
    if (!task) throw new Error(`Unknown task: ${taskId}`)
    return task
  }

  create(projectId: string, input: TaskInput): TaskDefinition {
    const title = input.title.trim()
    if (!title) throw new Error('Task title is required')
    if (!input.purpose.trim()) throw new Error('Task purpose is required')
    const now = new Date().toISOString()
    const siblings = this.listTasks(projectId)
    const task: TaskDefinition = {
      id: randomUUID(),
      projectId,
      title,
      purpose: input.purpose,
      acceptanceCriteria: input.acceptanceCriteria.map((c) => c.trim()).filter(Boolean),
      state: 'draft',
      order: siblings.length > 0 ? siblings[siblings.length - 1].order + 1 : 0,
      mode: input.mode ?? 'acceptEdits',
      model: normalizeModel(input.model),
      stepBudget: input.stepBudget ?? DEFAULT_STEP_BUDGET,
      recoveryBudget: input.recoveryBudget ?? DEFAULT_RECOVERY_BUDGET,
      autoApprove: input.autoApprove ?? false,
      reviewFeedback: null,
      archived: false,
      loopEnabled: input.loopEnabled ?? true,
      createdAt: now,
      updatedAt: now,
      transitions: [{ state: 'draft', at: now }]
    }
    this.tasks.push(task)
    this.commit(projectId)
    return task
  }

  update(taskId: string, patch: TaskPatch): TaskDefinition {
    const task = this.getOrThrow(taskId)
    this.assertNotActive(task, 'edited')
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) throw new Error('Task title is required')
      task.title = title
    }
    if (patch.purpose !== undefined) {
      if (!patch.purpose.trim()) throw new Error('Task purpose is required')
      task.purpose = patch.purpose
    }
    if (patch.acceptanceCriteria !== undefined) {
      task.acceptanceCriteria = patch.acceptanceCriteria.map((c) => c.trim()).filter(Boolean)
    }
    if (patch.mode !== undefined) task.mode = patch.mode
    if (patch.model !== undefined) task.model = normalizeModel(patch.model)
    if (patch.stepBudget !== undefined) task.stepBudget = requirePositive(patch.stepBudget, 'Step budget')
    if (patch.recoveryBudget !== undefined) {
      task.recoveryBudget = requireNonNegative(patch.recoveryBudget, 'Recovery budget')
    }
    if (patch.autoApprove !== undefined) task.autoApprove = patch.autoApprove
    if (patch.loopEnabled !== undefined) task.loopEnabled = patch.loopEnabled
    task.updatedAt = new Date().toISOString()
    this.commit(task.projectId)
    return task
  }

  delete(taskId: string): void {
    const task = this.getOrThrow(taskId)
    this.assertNotActive(task, 'deleted')
    this.tasks = this.tasks.filter((t) => t.id !== taskId)
    this.commit(task.projectId)
  }

  /** Move a task directly before another task in its project, or to the end when beforeTaskId is null. */
  reorder(taskId: string, beforeTaskId: string | null): TaskDefinition[] {
    const task = this.getOrThrow(taskId)
    const siblings = this.listTasks(task.projectId).filter((t) => t.id !== taskId)
    let insertAt = siblings.length
    if (beforeTaskId !== null) {
      insertAt = siblings.findIndex((t) => t.id === beforeTaskId)
      if (insertAt === -1) throw new Error(`Unknown task: ${beforeTaskId}`)
    }
    siblings.splice(insertAt, 0, task)
    siblings.forEach((t, i) => {
      t.order = i
    })
    this.commit(task.projectId)
    return this.listTasks(task.projectId)
  }

  /** Record a lifecycle transition with its timestamp. Completed tasks are archived automatically. */
  setState(taskId: string, state: TaskState): TaskDefinition {
    const task = this.getOrThrow(taskId)
    if (task.state === state) return task
    const now = new Date().toISOString()
    task.state = state
    if (state === 'done') task.archived = true
    task.updatedAt = now
    task.transitions.push({ state, at: now })
    this.commit(task.projectId)
    return task
  }

  /** Hide a settled task (draft, done, or failed) in the project's archive. */
  archive(taskId: string): TaskDefinition {
    const task = this.getOrThrow(taskId)
    if (!ARCHIVABLE_STATES.has(task.state)) {
      throw new Error(`Task cannot be archived from state '${task.state}'`)
    }
    if (task.archived) return task
    task.archived = true
    task.updatedAt = new Date().toISOString()
    this.commit(task.projectId)
    return task
  }

  /**
   * Bring an archived task back to the backlog. A completed task loses its
   * done state and returns to draft so it can be delegated again.
   */
  revive(taskId: string): TaskDefinition {
    const task = this.getOrThrow(taskId)
    if (!task.archived) throw new Error('Task is not archived')
    const now = new Date().toISOString()
    task.archived = false
    if (task.state === 'done') {
      task.state = 'draft'
      task.transitions.push({ state: 'draft', at: now })
    }
    task.updatedAt = now
    this.commit(task.projectId)
    return task
  }

  setReviewFeedback(taskId: string, feedback: string | null): TaskDefinition {
    const task = this.getOrThrow(taskId)
    task.reviewFeedback = feedback
    task.updatedAt = new Date().toISOString()
    this.commit(task.projectId)
    return task
  }

  private assertNotActive(task: TaskDefinition, verb: string): void {
    if (ACTIVE_STATES.has(task.state)) {
      throw new Error(`Task cannot be ${verb} while its run is active; stop the run first`)
    }
  }

  private commit(projectId: string): void {
    this.save()
    this.sink.tasksChanged(projectId, this.listTasks(projectId))
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      this.tasks = []
      return
    }
    const parsed = JSON.parse(raw) as {
      tasks?: Array<
        Omit<TaskDefinition, 'archived' | 'model' | 'autoApprove' | 'loopEnabled'> & {
          archived?: boolean
          model?: string | null
          autoApprove?: boolean
          loopEnabled?: boolean
        }
      >
    }
    const stored = Array.isArray(parsed.tasks) ? parsed.tasks : []
    // Migrations: files written before archiving existed lack the flag (done
    // tasks are swept into the archive to match the auto-archive-on-completion
    // rule), files written before model selection default to the CLI model,
    // files written before auto-approve default to requiring manual review, and
    // files written before loop participation default to being picked up.
    this.tasks = stored.map((t) => ({
      ...t,
      archived: t.archived ?? t.state === 'done',
      model: t.model ?? null,
      autoApprove: t.autoApprove ?? false,
      loopEnabled: t.loopEnabled ?? true
    }))
  }

  private save(): void {
    const file: TasksFile = { version: 1, tasks: this.tasks }
    const tmpPath = this.filePath + '.tmp'
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmpPath, this.filePath)
  }
}

/** Blank or missing model selections collapse to null (the CLI's default model). */
function normalizeModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim()
  return trimmed ? trimmed : null
}

function requirePositive(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}

function requireNonNegative(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be zero or a positive integer`)
  return value
}
