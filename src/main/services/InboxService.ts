import type { InboxItem, Project, RunRecord, SessionSummary, TaskDefinition } from '@shared/domain'

/** The live state the inbox is derived from (design D7: never stored separately). */
export interface InboxDeps {
  projects: { list(): Project[] }
  tasks: { get(taskId: string): TaskDefinition | undefined }
  runs: { list(): RunRecord[] }
  sessions: {
    listManagedSessions(): SessionSummary[]
    pendingPermissionTool(sessionId: string): string | null
  }
}

/**
 * Computes the cross-project attention inbox from current task, run, and
 * session state. Resolving an item happens on the underlying object, so items
 * disappear because the state they summarize changed.
 */
export class InboxService {
  constructor(private readonly deps: InboxDeps) {}

  list(): InboxItem[] {
    const projectNames = new Map(this.deps.projects.list().map((p) => [p.id, p.name]))
    const items: InboxItem[] = []

    for (const run of this.deps.runs.list()) {
      const item = this.runItem(run, projectNames)
      if (item) items.push(item)
    }

    for (const session of this.deps.sessions.listManagedSessions()) {
      if (session.state !== 'permission-prompt' || !session.taskId) continue
      const tool = this.deps.sessions.pendingPermissionTool(session.id)
      items.push({
        id: `permission:${session.id}`,
        kind: 'permission',
        projectId: session.projectId,
        projectName: projectNames.get(session.projectId) ?? session.projectId,
        taskId: session.taskId,
        taskTitle: session.taskTitle,
        taskModel: this.deps.tasks.get(session.taskId)?.model ?? null,
        runId: null,
        sessionId: session.id,
        message: tool ? `The agent wants to use: ${tool}` : 'The agent is waiting for tool permission',
        debugUrl: null,
        changesUrl: null,
        at: session.lastActivityAt ?? new Date().toISOString()
      })
    }

    // Oldest first: the inbox is a queue, and the longest-waiting item comes up first.
    return items.sort((a, b) => a.at.localeCompare(b.at))
  }

  private runItem(run: RunRecord, projectNames: Map<string, string>): InboxItem | null {
    const task = this.deps.tasks.get(run.taskId)
    // Paused tasks park deliberately (see TaskState): their run can still look
    // like an unresolved escalation (interrupted, or needs-input mid-pause),
    // but the point of pausing is to get it out of the way until the user
    // requeues it, so it must not resurface here.
    if (task?.state === 'paused') return null
    const base = {
      projectId: run.projectId,
      projectName: projectNames.get(run.projectId) ?? run.projectId,
      taskId: run.taskId,
      taskTitle: task?.title ?? null,
      taskModel: task?.model ?? null,
      runId: run.id,
      sessionId: run.sessionId || null
    }
    if ((run.state === 'needs-input' || run.state === 'interrupted') && run.escalation) {
      const { escalation } = run
      const history = escalation.history.length > 0 ? `${escalation.history.join('\n')}\n` : ''
      return {
        ...base,
        id: `run:${run.id}`,
        kind: escalation.kind,
        message: escalation.kind === 'question' ? escalation.message : history + escalation.message,
        debugUrl: null,
        changesUrl: null,
        at: escalation.at
      }
    }
    if (run.state === 'review' && run.completion) {
      return {
        ...base,
        id: `run:${run.id}`,
        kind: 'review',
        message: run.completion.summary,
        debugUrl: run.completion.debugUrl,
        changesUrl: run.completion.changesUrl,
        at: run.completion.at
      }
    }
    return null
  }
}
