import type {
  AddProjectInput,
  ProjectPatch,
  SessionCurationPatch,
  SessionPermissionMode
} from '@shared/domain'
import type { TrackerApi } from '@shared/ipc'
import type { AnalyticsService } from './services/AnalyticsService'
import type { GithubClient } from './services/GithubClient'
import type { GitService } from './services/GitService'
import type { PipelineService } from './services/PipelineService'
import type { ProjectService } from './services/ProjectService'
import type { ProjectStore } from './services/ProjectStore'
import type { SessionService } from './services/SessionService'
import type { TokenStore } from './services/TokenStore'

export interface ApiDeps {
  store: ProjectStore
  projects: ProjectService
  git: GitService
  sessions: SessionService
  pipelines: PipelineService
  analytics: AnalyticsService
  github: GithubClient
  tokens: TokenStore
  /** Desktop directory picker, injected by the composition root. */
  pickDirectory: () => Promise<string | null>
  /** Called after any registry mutation so watchers and pollers resync. */
  onProjectsChanged: () => void
}

export function createTrackerApi(deps: ApiDeps): TrackerApi {
  const requireGithub = (projectId: string): { owner: string; repo: string } => {
    const project = deps.store.getOrThrow(projectId)
    if (!project.github) throw new Error('Project has no linked GitHub repo')
    return project.github
  }

  return {
    // Projects
    listProjects: async () => deps.store.list(),
    addProject: async (input: AddProjectInput) => {
      const project = await deps.projects.add(input)
      deps.onProjectsChanged()
      return project
    },
    updateProject: async (id: string, patch: ProjectPatch) => {
      const project = await deps.projects.update(id, patch)
      deps.onProjectsChanged()
      return project
    },
    removeProject: async (id: string) => {
      deps.projects.remove(id)
      deps.onProjectsChanged()
    },
    getProjectStatus: async (id: string) => deps.projects.getStatus(id),
    pickProjectDirectory: async () => deps.pickDirectory(),
    inspectDirectory: async (path: string) => deps.projects.inspectDirectory(path),

    // Git diffs
    getWorkingTreeDiff: async (projectId: string) => {
      const project = deps.store.getOrThrow(projectId)
      return { projectId, files: await deps.git.workingTreeDiff(project.path) }
    },
    getRefDiff: async (projectId: string, base: string, head: string) => {
      const project = deps.store.getOrThrow(projectId)
      return { projectId, base, head, files: await deps.git.refDiff(project.path, base, head) }
    },
    listRefs: async (projectId: string) => {
      const project = deps.store.getOrThrow(projectId)
      return deps.git.listRefs(project.path)
    },

    // Agent sessions
    listSessions: async (projectId: string) => deps.sessions.listSessions(projectId),
    getTranscript: async (projectId: string, sessionId: string) =>
      deps.sessions.getTranscript(projectId, sessionId),
    startSession: async (projectId: string, prompt: string, mode: SessionPermissionMode) =>
      deps.sessions.startSession(projectId, prompt, mode),
    respondToSession: async (projectId: string, sessionId: string, message: string) =>
      deps.sessions.respondToSession(projectId, sessionId, message),
    setSessionMode: async (projectId: string, sessionId: string, mode: SessionPermissionMode) =>
      deps.sessions.setSessionMode(projectId, sessionId, mode),
    respondToPermission: async (projectId: string, sessionId: string, allow: boolean) =>
      deps.sessions.respondToPermission(projectId, sessionId, allow),
    interruptSession: async (projectId: string, sessionId: string) =>
      deps.sessions.interruptSession(projectId, sessionId),
    curateSession: async (projectId: string, sessionId: string, patch: SessionCurationPatch) =>
      deps.sessions.curateSession(projectId, sessionId, patch),

    // Pipelines
    getPipelineRuns: async (projectId: string) => deps.pipelines.getRuns(projectId),
    getRateLimit: async () => deps.github.getRateLimit(),

    // Release analytics
    getReleases: async (projectId: string) => deps.analytics.getReleases(requireGithub(projectId)),
    getTraffic: async (projectId: string) => deps.analytics.getTraffic(requireGithub(projectId)),

    // Settings / GitHub auth
    getGithubAuthState: async () => deps.tokens.getAuthState(),
    setGithubToken: async (token: string) => deps.tokens.setToken(token),
    clearGithubToken: async () => deps.tokens.clearToken(),
    importGhCliToken: async () => deps.tokens.importFromGhCli()
  }
}
