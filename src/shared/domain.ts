// Domain model shared between main-process services and the renderer UI.
// This file must stay free of Node and Electron imports (D2: web reuse).

// ---------- Projects ----------

export interface GithubRepoRef {
  owner: string
  repo: string
}

/**
 * A user-configured quick link shown on the project view, e.g. a Vercel
 * dashboard or the hosted URL of the project's website.
 */
export interface ProjectLink {
  label: string
  /** Absolute http(s) URL; opened in the system browser. */
  url: string
}

export interface Project {
  id: string
  name: string
  /** Absolute path of the local git working copy. */
  path: string
  tags: string[]
  github: GithubRepoRef | null
  /** Important links configured by the user, shown on the project view. */
  links: ProjectLink[]
  /**
   * Looping mode (off by default): while enabled, completed runs in this
   * project are approved automatically instead of waiting for the user's
   * review, and when the project's agent is free the next draft task in the
   * backlog is delegated automatically. So the loop can run unattended, a
   * delegated run's bash-command permission prompts are also auto-approved
   * (only bash, only the loop's own sessions). Questions and failures still
   * escalate to the user.
   */
  looping: boolean
  /**
   * Agent task creation (off by default): while enabled, agents running
   * delegated work in this project may add tasks to the backlog by emitting
   * fenced apt-task blocks, e.g. to report a defect they noticed, promote a
   * release, or propose a functionality or code-quality improvement.
   * Proposed tasks always land as drafts for the user to review.
   */
  agentTaskCreation: boolean
  createdAt: string
}

export interface AddProjectInput {
  path: string
  name: string
  tags: string[]
  github: GithubRepoRef | null
}

export interface ProjectPatch {
  name?: string
  tags?: string[]
  github?: GithubRepoRef | null
  /** Replace the project's important links (full-list semantics). */
  links?: ProjectLink[]
  /** Relocate the project to a new directory. */
  path?: string
  /** Turn looping mode on or off (see Project.looping). */
  looping?: boolean
  /** Turn agent task creation on or off (see Project.agentTaskCreation). */
  agentTaskCreation?: boolean
}

/**
 * Outcome of an open-in-editor request: opened in VS Code, opened in a
 * user-picked fallback program, or dismissed without opening anything.
 */
export type EditorLaunchResult = 'vscode' | 'other' | 'cancelled'

/** Result of validating a directory chosen during registration. */
export interface DirectoryInspection {
  path: string
  isDirectory: boolean
  isGitRepo: boolean
  detectedGithub: GithubRepoRef | null
  suggestedName: string
}

export interface ProjectStatusSummary {
  projectId: string
  /** 'missing' when the project directory no longer exists. */
  state: 'ok' | 'missing'
  branch: string | null
  dirty: boolean
  changedFileCount: number
  sessionCount: number
  sessionsNeedingAttention: number
  pipeline: PipelineStatusSummary | null
  delegation: DelegationSummary
}

/** Per-project rollup of the task backlog and active run, shown on dashboard cards. */
export interface DelegationSummary {
  queued: number
  running: number
  needsInput: number
  review: number
  /** Title of the currently running task, when one exists. */
  activeTaskTitle: string | null
  /** Latest progress note reported by the active run. */
  activeProgressNote: string | null
}

// ---------- Git diffs ----------

export type FileChangeType = 'added' | 'modified' | 'deleted' | 'renamed'

/** Which part of the working tree a file change belongs to; null for ref-to-ref diffs. */
export type WorkingTreeArea = 'staged' | 'unstaged' | 'untracked'

export interface DiffLine {
  kind: 'context' | 'add' | 'del'
  oldLineNo: number | null
  newLineNo: number | null
  text: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  /** New path (or old path for deletions). */
  path: string
  /** Previous path when renamed. */
  oldPath: string | null
  changeType: FileChangeType
  binary: boolean
  area: WorkingTreeArea | null
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

export interface WorkingTreeDiff {
  projectId: string
  files: DiffFile[]
}

export interface RefDiff {
  projectId: string
  base: string
  head: string
  files: DiffFile[]
}

export interface RepoRefs {
  currentBranch: string | null
  defaultBranch: string | null
  branches: string[]
  tags: string[]
}

// ---------- Agent sessions ----------

/** Claude Code permission modes surfaced in the UI. 'auto' maps to bypassPermissions. */
export type SessionPermissionMode = 'plan' | 'acceptEdits' | 'auto'

export type SessionState = 'idle' | 'running' | 'awaiting-input' | 'permission-prompt'

export interface SessionSummary {
  id: string
  projectId: string
  /** Custom curated title; falls back to derived summary in the UI. */
  title: string | null
  /** Derived from the first or latest exchange. */
  summary: string | null
  startedAt: string | null
  lastActivityAt: string | null
  /** 'managed' sessions run inside the app via the Agent SDK; 'discovered' come from session storage. */
  origin: 'managed' | 'discovered'
  /** True when the session appears attached to an external process (view-only). */
  liveExternal: boolean
  state: SessionState
  mode: SessionPermissionMode | null
  pinned: boolean
  archived: boolean
  messageCount: number
  /** Set when the session was started by the agent run loop for a task. */
  taskId: string | null
  taskTitle: string | null
}

export type TranscriptItem =
  | { kind: 'user'; text: string; at: string | null }
  | { kind: 'assistant'; text: string; at: string | null }
  | { kind: 'tool'; name: string; input: string; output: string | null; at: string | null }
  | { kind: 'system'; text: string; at: string | null }

export interface SessionCurationPatch {
  pinned?: boolean
  title?: string | null
  archived?: boolean
}

// ---------- Task backlog ----------

/**
 * A preset LLM model choice offered when configuring a task. `id` is what the
 * Agent SDK receives: a stable alias ('opus', 'sonnet', 'haiku') that always
 * resolves to the current generation of that tier, or null to inherit the
 * Claude CLI's configured default model.
 */
export interface AgentModelPreset {
  id: string | null
  label: string
  hint: string
}

export const AGENT_MODEL_PRESETS: readonly AgentModelPreset[] = [
  { id: null, label: 'Default', hint: "Uses the Claude CLI's configured model" },
  { id: 'opus', label: 'Opus', hint: 'Most capable; best for hard or long-running tasks' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Balanced speed, cost, and capability' },
  { id: 'haiku', label: 'Haiku', hint: 'Fastest and cheapest; for simple tasks' }
]

/** Display label for a task's model: preset label, raw custom id, or 'Default'. */
export function agentModelLabel(model: string | null): string {
  const preset = AGENT_MODEL_PRESETS.find((p) => p.id === model)
  return preset ? preset.label : (model ?? 'Default')
}

export type TaskState = 'draft' | 'queued' | 'running' | 'needs-input' | 'review' | 'done' | 'failed'

export interface TaskTransition {
  state: TaskState
  at: string
}

export interface TaskDefinition {
  id: string
  projectId: string
  title: string
  /** What the agent should build; the core of the run briefing. */
  purpose: string
  acceptanceCriteria: string[]
  state: TaskState
  /** Backlog position within the project; lower starts first. */
  order: number
  /** Permission mode for the run session; delegated work defaults to acceptEdits. */
  mode: SessionPermissionMode
  /**
   * LLM model for the run session: an alias ('opus', 'sonnet', 'haiku') or a
   * full model id (e.g. 'claude-opus-4-8'); null inherits the CLI default.
   */
  model: string | null
  /** Maximum agent turns before the run is interrupted and escalated. */
  stepBudget: number
  /** Maximum corrective follow-ups before a failing run escalates. */
  recoveryBudget: number
  /**
   * When true, a run that completes with a passing quality gate is accepted
   * automatically instead of waiting in review for the user's feedback. Runs
   * that escalate a question, exhaust recovery, or blow the step budget still
   * reach the user; auto-approve only skips the final sign-off.
   */
  autoApprove: boolean
  /** Feedback from the last send-back review, included in the next briefing. */
  reviewFeedback: string | null
  /**
   * Archived tasks are hidden from the default backlog view. Completing a
   * task (accepting its review into done) archives it automatically; reviving
   * an archived task returns it to the backlog, resetting done back to draft.
   */
  archived: boolean
  createdAt: string
  updatedAt: string
  transitions: TaskTransition[]
}

export interface TaskInput {
  title: string
  purpose: string
  acceptanceCriteria: string[]
  mode?: SessionPermissionMode
  model?: string | null
  stepBudget?: number
  recoveryBudget?: number
  autoApprove?: boolean
}

export interface TaskPatch {
  title?: string
  purpose?: string
  acceptanceCriteria?: string[]
  mode?: SessionPermissionMode
  model?: string | null
  stepBudget?: number
  recoveryBudget?: number
  autoApprove?: boolean
}

// ---------- Agent run loop ----------

/** Parsed from the agent's fenced apt-status block; never inferred from prose. */
export interface RunStatusReport {
  state: 'working' | 'question' | 'blocked' | 'complete'
  /** Progress note, question text, blocked reason, or completion summary. */
  note: string
  /** For complete reports: whether the agent says the quality gate passed. */
  gatePassed: boolean | null
  /** For complete reports: how the gate result was obtained (e.g. patrol output). */
  gateSummary: string | null
  /** For complete reports: http(s) link to test the changes in a debug environment, when the agent could provide one. */
  debugUrl: string | null
  /** For complete reports: http(s) link to the branch or pull request holding the changes, when the agent delivered to one. */
  changesUrl: string | null
}

/**
 * A backlog task proposed by an agent through a fenced apt-task block
 * (see Project.agentTaskCreation); parsed like RunStatusReport, never
 * inferred from prose.
 */
export interface AgentTaskProposal {
  title: string
  purpose: string
  acceptanceCriteria: string[]
}

export type RunState = 'active' | 'needs-input' | 'review' | 'done' | 'failed' | 'interrupted'

export type RunEscalationKind = 'question' | 'recovery-exhausted' | 'step-budget' | 'interrupted'

export interface RunEscalation {
  kind: RunEscalationKind
  message: string
  /** Accumulated failure context from earlier recovery attempts. */
  history: string[]
  at: string
}

export interface RunCompletion {
  summary: string
  gatePassed: boolean
  gateSummary: string | null
  /** Link to test the changes in a debug environment; null when the agent had nothing to link. */
  debugUrl: string | null
  /** Link to the branch or pull request holding the changes; null when the agent had nothing to link. */
  changesUrl: string | null
  at: string
}

export interface RunEvent {
  kind:
    | 'started'
    | 'status'
    | 'task-created'
    | 'nudge'
    | 'escalated'
    | 'answered'
    | 'completed'
    | 'accepted'
    | 'sent-back'
    | 'stopped'
    | 'interrupted'
    | 'resumed'
  detail: string
  at: string
}

export interface RunRecord {
  id: string
  taskId: string
  projectId: string
  /** Local id of the managed session currently driving this run. */
  sessionId: string
  /** CLI session id; enables resume after an app restart. */
  sdkSessionId: string | null
  state: RunState
  /** Latest progress note from the agent's status reports. */
  progressNote: string | null
  /** Pending escalation while the run is in needs-input or interrupted. */
  escalation: RunEscalation | null
  nudgesUsed: number
  stepsUsed: number
  /** Total tokens consumed across all turns (input + output + cache reads/writes). */
  tokensUsed: number
  /**
   * Distinct project-relative paths the run changed through file-editing tools
   * (Edit/Write/NotebookEdit). An approximation: changes made via shell
   * commands are not counted.
   */
  filesChanged: string[]
  completion: RunCompletion | null
  /** False when the workspace quality-gate skills were missing at delegation. */
  workflowVerified: boolean
  events: RunEvent[]
  startedAt: string
  endedAt: string | null
}

// ---------- Active tasks overview ----------

/** Task states shown in the cross-project active tasks view: delegated work that has not reached a terminal state. */
export const ACTIVE_TASK_STATES: readonly TaskState[] = ['queued', 'running', 'needs-input', 'review']

/** One active task enriched with live progress from the run driving it. */
export interface ActiveTaskEntry {
  task: TaskDefinition
  /**
   * Latest progress note reported by the task's current run; null before the
   * first report and for queued tasks (whose latest run belongs to an earlier attempt).
   */
  progressNote: string | null
  /** Steps consumed by the current run, or null when no run is attached (see progressNote). */
  stepsUsed: number | null
}

/** The active tasks of one project, for the per-project grouping of the active tasks view. */
export interface ActiveTasksGroup {
  projectId: string
  projectName: string
  /** Most urgent first: needs-input, running, review, then queued in backlog order. */
  tasks: ActiveTaskEntry[]
}

// ---------- Release publishing ----------

/** One commit that would ship in the next release. */
export interface ReleaseCommit {
  sha: string
  /** First line of the commit message. */
  subject: string
  author: string
  /** ISO author date of the commit. */
  at: string
}

/** A backlog task completed since the last release, credited to the next one. */
export interface ReleaseTaskSummary {
  taskId: string
  title: string
  /** ISO timestamp of the task's transition to done. */
  completedAt: string
}

/** Semver bump implied by the commits waiting to ship. */
export type ReleaseBump = 'major' | 'minor' | 'patch'

/** The publish task currently driving a release, when one is in flight. */
export interface ActivePublishTask {
  taskId: string
  title: string
  state: TaskState
}

/**
 * What the next release would contain, derived from local git history and the
 * task backlog. `nextVersion` is a suggestion computed from conventional-commit
 * subjects; the publishing agent makes the final call.
 */
export interface ReleasePreview {
  projectId: string
  /** Newest semver release tag (vX.Y.Z or X.Y.Z), or null before the first release. */
  lastTag: string | null
  /** ISO committer date of the commit `lastTag` points at; null before the first release. */
  lastTagAt: string | null
  /** Suggested tag for the next release, e.g. "v0.3.0". */
  nextVersion: string
  /** Bump kind behind the suggestion. */
  bump: ReleaseBump
  /** Commits since `lastTag` (entire history before the first release), newest first. */
  commits: ReleaseCommit[]
  /** Tasks completed after the last release was tagged, newest first. */
  completedTasks: ReleaseTaskSummary[]
  /** Publish task currently in flight for this project, or null. */
  activePublishTask: ActivePublishTask | null
}

// ---------- Attention inbox ----------

export type InboxItemKind =
  'question' | 'permission' | 'recovery-exhausted' | 'step-budget' | 'review' | 'interrupted'

/** A derived escalation entry; computed from live task/run/session state, never stored. */
export interface InboxItem {
  /** Stable id derived from the underlying object, e.g. `run:<id>` or `permission:<sessionId>`. */
  id: string
  kind: InboxItemKind
  projectId: string
  projectName: string
  taskId: string | null
  taskTitle: string | null
  runId: string | null
  sessionId: string | null
  /** Question text, failure history, or completion summary. */
  message: string
  /** For review items: link to test the changes in a debug environment, when the agent provided one. */
  debugUrl: string | null
  /** For review items: link to the branch or pull request holding the changes, when the agent provided one. */
  changesUrl: string | null
  at: string
}

// ---------- Pipelines ----------

export type RunStatus =
  'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled' | 'action_required' | 'neutral' | 'unknown'

export interface WorkflowRun {
  id: number
  workflowName: string
  branch: string
  commitSha: string
  commitMessage: string
  status: RunStatus
  startedAt: string | null
  durationSeconds: number | null
  url: string
}

export interface PipelineStatusSummary {
  overall: RunStatus
  failingRuns: number
  updatedAt: string | null
  /** Message from the most recent failed poll; null while polling succeeds. */
  error?: string | null
}

export interface RateLimitState {
  limit: number | null
  remaining: number | null
  resetAt: string | null
  /** True when polling has backed off because the limit is nearly exhausted. */
  low: boolean
}

export interface GithubAuthState {
  configured: boolean
  source: 'vault' | 'gh-cli' | null
}

// ---------- App settings ----------

/**
 * UI color theme preference: an explicit light or dark theme, or 'system' to
 * follow the operating system's preference, including live changes to it.
 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** All theme preferences, in the order the settings UI offers them. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system']

// ---------- Release analytics ----------

export interface ReleaseAsset {
  name: string
  downloadCount: number
  sizeBytes: number
}

export interface ReleaseInfo {
  tag: string
  name: string | null
  publishedAt: string | null
  notes: string | null
  url: string
  assets: ReleaseAsset[]
}

export interface TrafficPoint {
  date: string
  count: number
  uniques: number
}

export interface TrafficMetrics {
  /** False when the token lacks access to traffic data for the repo. */
  available: boolean
  views: TrafficPoint[]
  clones: TrafficPoint[]
}

// ---------- About ----------

/**
 * One usage-limit window of the Claude account's budget (e.g. the 5-hour
 * session window or a weekly window, possibly scoped to a model).
 */
export interface ClaudeUsageWindow {
  /** Window identifier as reported by the account API, e.g. "session", "weekly_all", "weekly_scoped". */
  kind: string
  /** Percent of the window's budget consumed, 0-100. */
  percent: number
  /** Severity as reported by the account API, e.g. "normal" or "warning". */
  severity: string
  /** ISO timestamp at which the window resets, or null when unknown. */
  resetsAt: string | null
  /** Display name of the model the window is scoped to, or null for account-wide windows. */
  scope: string | null
}

/**
 * Claude usage-budget metrics for the account configured on this machine.
 * `status` explains why `windows` may be empty: "not-logged-in" means no
 * Claude CLI credentials were found, "error" means the usage API call failed.
 */
export interface ClaudeUsage {
  status: 'ok' | 'not-logged-in' | 'error'
  /** Subscription tier from the stored credentials (e.g. "pro"), when known. */
  subscription: string | null
  windows: ClaudeUsageWindow[]
  /** Human-readable failure description when status is "error". */
  error: string | null
  /** ISO timestamp of when the usage data was read. */
  fetchedAt: string
}

/** Data shown on the About view. */
export interface AboutInfo {
  appVersion: string
  usage: ClaudeUsage
}
