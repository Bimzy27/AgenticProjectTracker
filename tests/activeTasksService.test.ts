import { describe, expect, it } from 'vitest'
import type { Project, RunRecord, TaskDefinition, TaskState } from '@shared/domain'
import { ActiveTasksService } from '../src/main/services/ActiveTasksService'

let taskCounter = 0

function project(id: string, name: string): Project {
  return { id, name, path: `C:/repos/${id}`, tags: [], github: null, createdAt: '2026-07-01T00:00:00Z' }
}

function task(
  projectId: string,
  state: TaskState,
  order = 0,
  title = `Task ${++taskCounter}`
): TaskDefinition {
  return {
    id: `task-${taskCounter}`,
    projectId,
    title,
    purpose: 'purpose',
    acceptanceCriteria: [],
    state,
    order,
    mode: 'acceptEdits',
    stepBudget: 30,
    recoveryBudget: 3,
    reviewFeedback: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    transitions: []
  }
}

function run(taskId: string, progressNote: string | null, stepsUsed: number): RunRecord {
  return {
    id: `run-${taskId}`,
    taskId,
    projectId: 'ignored',
    sessionId: 's1',
    sdkSessionId: null,
    state: 'active',
    progressNote,
    escalation: null,
    nudgesUsed: 0,
    stepsUsed,
    tokensUsed: 0,
    completion: null,
    workflowVerified: true,
    events: [],
    startedAt: '2026-07-01T00:00:00Z',
    endedAt: null
  }
}

function service(projects: Project[], tasks: TaskDefinition[], runs: RunRecord[] = []): ActiveTasksService {
  return new ActiveTasksService({
    projects: { list: () => projects },
    tasks: { listAll: () => tasks },
    runs: { latestRun: (taskId) => runs.find((r) => r.taskId === taskId) ?? null }
  })
}

describe('ActiveTasksService', () => {
  it('includes only non-terminal delegated states', () => {
    const tasks = (['draft', 'queued', 'running', 'needs-input', 'review', 'done', 'failed'] as const).map(
      (state, i) => task('p1', state, i)
    )
    const groups = service([project('p1', 'One')], tasks).list()
    expect(groups).toHaveLength(1)
    expect(groups[0].tasks.map((entry) => entry.task.state)).toEqual([
      'needs-input',
      'running',
      'review',
      'queued'
    ])
  })

  it('groups tasks per project in registry order and omits idle projects', () => {
    const projects = [project('p1', 'One'), project('p2', 'Two'), project('p3', 'Three')]
    const tasks = [task('p3', 'running'), task('p1', 'queued')]
    const groups = service(projects, tasks).list()
    expect(groups.map((g) => g.projectName)).toEqual(['One', 'Three'])
  })

  it('drops tasks whose project is no longer registered', () => {
    const groups = service([project('p1', 'One')], [task('gone', 'running')]).list()
    expect(groups).toEqual([])
  })

  it('orders tasks within a project by urgency, then backlog order', () => {
    const tasks = [
      task('p1', 'queued', 2, 'Queued B'),
      task('p1', 'queued', 1, 'Queued A'),
      task('p1', 'review', 0, 'Review'),
      task('p1', 'running', 3, 'Running'),
      task('p1', 'needs-input', 4, 'Blocked')
    ]
    const groups = service([project('p1', 'One')], tasks).list()
    expect(groups[0].tasks.map((entry) => entry.task.title)).toEqual([
      'Blocked',
      'Running',
      'Review',
      'Queued A',
      'Queued B'
    ])
  })

  it('enriches run-attached tasks with the latest progress note and steps used', () => {
    const running = task('p1', 'running')
    const groups = service([project('p1', 'One')], [running], [run(running.id, 'compiling', 7)]).list()
    expect(groups[0].tasks[0]).toMatchObject({ progressNote: 'compiling', stepsUsed: 7 })
  })

  it('does not attach an earlier attempt run to a re-queued task', () => {
    const queued = task('p1', 'queued')
    const groups = service([project('p1', 'One')], [queued], [run(queued.id, 'stale note', 12)]).list()
    expect(groups[0].tasks[0]).toMatchObject({ progressNote: null, stepsUsed: null })
  })

  it('reports null progress for a run that has not reported yet', () => {
    const running = task('p1', 'running')
    const groups = service([project('p1', 'One')], [running], [run(running.id, null, 0)]).list()
    expect(groups[0].tasks[0]).toMatchObject({ progressNote: null, stepsUsed: 0 })
  })
})
