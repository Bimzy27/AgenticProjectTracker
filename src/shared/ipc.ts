// Typed contract between the UI and the service layer (D2).
// Electron IPC implements it today; an HTTP/WebSocket adapter can implement
// the same interface for a future web deployment.

import type {
  AboutInfo,
  AddProjectInput,
  DirectoryInspection,
  EditorLaunchResult,
  GithubAuthState,
  InboxItem,
  PipelineStatusSummary,
  Project,
  ProjectPatch,
  ProjectStatusSummary,
  RateLimitState,
  RefDiff,
  ReleaseInfo,
  RepoRefs,
  RunRecord,
  SessionCurationPatch,
  SessionPermissionMode,
  SessionSummary,
  TaskDefinition,
  TaskInput,
  TaskPatch,
  TrafficMetrics,
  TranscriptItem,
  WorkflowRun,
  WorkingTreeDiff
} from './domain'

/** Request/response surface. Every method returns a Promise. */
export interface TrackerApi {
  // Projects
  listProjects(): Promise<Project[]>
  addProject(input: AddProjectInput): Promise<Project>
  updateProject(id: string, patch: ProjectPatch): Promise<Project>
  removeProject(id: string): Promise<void>
  getProjectStatus(id: string): Promise<ProjectStatusSummary>
  /** Desktop-only helper; returns null when the user cancels the picker. */
  pickProjectDirectory(): Promise<string | null>
  inspectDirectory(path: string): Promise<DirectoryInspection>
  /**
   * Open the project's git repository root in VS Code; when VS Code is not
   * installed, prompt the user to pick another program instead.
   */
  openProjectInEditor(projectId: string): Promise<EditorLaunchResult>

  // Git diffs
  getWorkingTreeDiff(projectId: string): Promise<WorkingTreeDiff>
  getRefDiff(projectId: string, base: string, head: string): Promise<RefDiff>
  listRefs(projectId: string): Promise<RepoRefs>

  // Agent sessions
  listSessions(projectId: string): Promise<SessionSummary[]>
  getTranscript(projectId: string, sessionId: string): Promise<TranscriptItem[]>
  startSession(projectId: string, prompt: string, mode: SessionPermissionMode): Promise<SessionSummary>
  respondToSession(projectId: string, sessionId: string, message: string): Promise<void>
  setSessionMode(projectId: string, sessionId: string, mode: SessionPermissionMode): Promise<void>
  /** Answer a pending permission prompt on a managed session. */
  respondToPermission(projectId: string, sessionId: string, allow: boolean): Promise<void>
  interruptSession(projectId: string, sessionId: string): Promise<void>
  curateSession(projectId: string, sessionId: string, patch: SessionCurationPatch): Promise<void>

  // Task backlog
  listTasks(projectId: string): Promise<TaskDefinition[]>
  createTask(projectId: string, input: TaskInput): Promise<TaskDefinition>
  updateTask(projectId: string, taskId: string, patch: TaskPatch): Promise<TaskDefinition>
  deleteTask(projectId: string, taskId: string): Promise<void>
  /** Move a task directly before another queued task, or to the end when beforeTaskId is null. */
  reorderTask(projectId: string, taskId: string, beforeTaskId: string | null): Promise<TaskDefinition[]>

  // Agent run loop
  delegateTask(projectId: string, taskId: string): Promise<TaskDefinition>
  /** Latest run for the task; null when it has never been delegated. */
  getTaskRun(projectId: string, taskId: string): Promise<RunRecord | null>
  /** Deliver the user's answer to an escalated run and resume it. */
  answerRun(projectId: string, taskId: string, answer: string): Promise<void>
  /** Interrupt an active run and move the task to failed. */
  stopRun(projectId: string, taskId: string): Promise<void>
  /** Reattach an interrupted run to its session and continue. */
  resumeRun(projectId: string, taskId: string): Promise<void>
  /** Accept a reviewed task as done. */
  acceptTask(projectId: string, taskId: string): Promise<void>
  /** Re-queue a reviewed task with feedback for the next briefing. */
  sendBackTask(projectId: string, taskId: string, feedback: string): Promise<void>

  // Attention inbox
  listInbox(): Promise<InboxItem[]>

  // Pipelines
  getPipelineRuns(projectId: string): Promise<WorkflowRun[]>
  getRateLimit(): Promise<RateLimitState>

  // Release analytics
  getReleases(projectId: string): Promise<ReleaseInfo[]>
  getTraffic(projectId: string): Promise<TrafficMetrics>

  // Settings / GitHub auth
  getGithubAuthState(): Promise<GithubAuthState>
  setGithubToken(token: string): Promise<void>
  clearGithubToken(): Promise<void>
  /** Returns true when a token was found and imported from the gh CLI. */
  importGhCliToken(): Promise<boolean>

  // About
  /**
   * App version plus the Claude usage budget of the account the Claude CLI is
   * logged in with. Never rejects for usage problems: failures are reported
   * in-band via `AboutInfo.usage.status`.
   */
  getAboutInfo(): Promise<AboutInfo>
}

/** Push events flowing from services to the UI. */
export interface TrackerEvents {
  'project-status-changed': ProjectStatusSummary
  'projects-changed': Project[]
  'diff-changed': { projectId: string }
  'session-updated': SessionSummary
  'transcript-appended': { projectId: string; sessionId: string; items: TranscriptItem[] }
  'pipeline-updated': { projectId: string; summary: PipelineStatusSummary; runs: WorkflowRun[] }
  'rate-limit-changed': RateLimitState
  'tasks-changed': { projectId: string; tasks: TaskDefinition[] }
  'run-updated': RunRecord
  'inbox-changed': InboxItem[]
  /** Emitted when the user clicks a desktop notification; the UI should navigate. */
  navigate: {
    projectId: string
    view: 'dashboard' | 'diffs' | 'sessions' | 'pipelines' | 'analytics' | 'tasks'
  }
}

export type TrackerEventName = keyof TrackerEvents

export type TrackerMethodName = keyof TrackerApi

/** Shape exposed on window.tracker by the preload bridge. */
export interface TrackerBridge {
  invoke<M extends TrackerMethodName>(
    method: M,
    ...args: Parameters<TrackerApi[M]>
  ): ReturnType<TrackerApi[M]>
  on<E extends TrackerEventName>(event: E, listener: (payload: TrackerEvents[E]) => void): () => void
}

export const INVOKE_CHANNEL = 'tracker:invoke'
export const EVENT_CHANNEL = 'tracker:event'
