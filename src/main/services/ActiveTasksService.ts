import type {
  ActiveTaskEntry,
  ActiveTasksGroup,
  Project,
  RunRecord,
  TaskDefinition,
  TaskState
} from '@shared/domain'
import { ACTIVE_TASK_STATES } from '@shared/domain'

/** The live state the overview is derived from; like the inbox it is computed, never stored. */
export interface ActiveTasksDeps {
  projects: { list(): Project[] }
  tasks: { listAll(): TaskDefinition[] }
  runs: { latestRun(taskId: string): RunRecord | null }
}

/** Within a project, the most urgent state sorts first; ties fall back to backlog order. */
const STATE_PRIORITY: Partial<Record<TaskState, number>> = {
  'needs-input': 0,
  running: 1,
  review: 2,
  queued: 3
}

/** States whose latest run drives the task right now; a queued task's latest run belongs to an earlier attempt. */
const RUN_ATTACHED_STATES: ReadonlySet<TaskState> = new Set(['running', 'needs-input', 'review'])

/**
 * Computes the cross-project overview of currently active tasks (queued,
 * running, needs-input, review), grouped per project in registry order.
 * Projects without active tasks are omitted, and tasks of unregistered
 * projects never appear.
 */
export class ActiveTasksService {
  constructor(private readonly deps: ActiveTasksDeps) {}

  list(): ActiveTasksGroup[] {
    const activeStates = new Set<TaskState>(ACTIVE_TASK_STATES)
    const byProject = new Map<string, TaskDefinition[]>()
    for (const task of this.deps.tasks.listAll()) {
      if (!activeStates.has(task.state)) continue
      const bucket = byProject.get(task.projectId)
      if (bucket) bucket.push(task)
      else byProject.set(task.projectId, [task])
    }

    const groups: ActiveTasksGroup[] = []
    for (const project of this.deps.projects.list()) {
      const tasks = byProject.get(project.id)
      if (!tasks) continue
      tasks.sort(
        (a, b) => (STATE_PRIORITY[a.state] ?? 9) - (STATE_PRIORITY[b.state] ?? 9) || a.order - b.order
      )
      groups.push({
        projectId: project.id,
        projectName: project.name,
        tasks: tasks.map((task) => this.entry(task))
      })
    }
    return groups
  }

  private entry(task: TaskDefinition): ActiveTaskEntry {
    const run = RUN_ATTACHED_STATES.has(task.state) ? this.deps.runs.latestRun(task.id) : null
    return {
      task,
      progressNote: run?.progressNote ?? null,
      stepsUsed: run?.stepsUsed ?? null
    }
  }
}
