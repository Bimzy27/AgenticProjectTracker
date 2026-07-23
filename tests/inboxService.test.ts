import { describe, expect, it } from 'vitest'
import type { Project, RunRecord, TaskDefinition, TaskState } from '@shared/domain'
import { InboxService } from '../src/main/services/InboxService'

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `C:/repos/${id}`,
    tags: [],
    github: null,
    vercel: null,
    links: [],
    looping: false,
    agentTaskCreation: false,
    createdAt: '2026-07-01T00:00:00Z'
  }
}

function task(id: string, projectId: string, state: TaskState): TaskDefinition {
  return {
    id,
    projectId,
    title: `Task ${id}`,
    purpose: 'purpose',
    acceptanceCriteria: [],
    state,
    order: 0,
    mode: 'acceptEdits',
    model: null,
    stepBudget: 30,
    recoveryBudget: 3,
    autoApprove: false,
    reviewFeedback: null,
    archived: false,
    loopEnabled: true,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    transitions: []
  }
}

function interruptedRun(taskId: string, projectId: string, message: string): RunRecord {
  return {
    id: `run-${taskId}`,
    taskId,
    projectId,
    sessionId: 's1',
    sdkSessionId: null,
    state: 'interrupted',
    progressNote: null,
    escalation: { kind: 'interrupted', message, history: [], at: '2026-07-01T00:00:00Z' },
    nudgesUsed: 0,
    stepsUsed: 1,
    tokensUsed: 0,
    filesChanged: [],
    completion: null,
    workflowVerified: true,
    events: [],
    startedAt: '2026-07-01T00:00:00Z',
    endedAt: null
  }
}

function inbox(projects: Project[], tasks: TaskDefinition[], runs: RunRecord[]): InboxService {
  return new InboxService({
    projects: { list: () => projects },
    tasks: { get: (taskId) => tasks.find((t) => t.id === taskId) },
    runs: { list: () => runs },
    sessions: { listManagedSessions: () => [], pendingPermissionTool: () => null }
  })
}

describe('InboxService', () => {
  it('surfaces an interrupted run needing attention', () => {
    const tasks = [task('t1', 'p1', 'needs-input')]
    const runs = [interruptedRun('t1', 'p1', 'The session ended unexpectedly')]
    const items = inbox([project('p1', 'One')], tasks, runs).list()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'interrupted', taskId: 't1' })
  })

  it('excludes a run belonging to a paused task, even though the run itself still looks interrupted', () => {
    // Pausing a live run parks it as interrupted (see RunOrchestrator.pause) so
    // scheduling frees the project, but the whole point of pausing is to get
    // the task out of the user's face until they requeue it themselves.
    const tasks = [task('t1', 'p1', 'paused')]
    const runs = [interruptedRun('t1', 'p1', 'Paused by the user')]
    const items = inbox([project('p1', 'One')], tasks, runs).list()
    expect(items).toEqual([])
  })
})
