// Domain model shared between main-process services and the renderer UI.
// This file must stay free of Node and Electron imports (D2: web reuse).

// ---------- Projects ----------

export interface GithubRepoRef {
  owner: string
  repo: string
}

export interface Project {
  id: string
  name: string
  /** Absolute path of the local git working copy. */
  path: string
  tags: string[]
  github: GithubRepoRef | null
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
  /** Relocate the project to a new directory. */
  path?: string
}

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
