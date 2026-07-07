import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  AddProjectInput,
  DirectoryInspection,
  Project,
  ProjectPatch,
  ProjectStatusSummary
} from '@shared/domain'
import type { GitService } from './GitService'
import type { PipelineService } from './PipelineService'
import type { SessionService } from './SessionService'

/** Orchestrates registration validation and per-project status summaries. */
export class ProjectService {
  constructor(
    private readonly store: {
      list(): Project[]
      getOrThrow(id: string): Project
      add(input: AddProjectInput): Project
      update(id: string, patch: ProjectPatch): Project
      remove(id: string): void
    },
    private readonly git: GitService,
    private readonly sessions: Pick<SessionService, 'attentionCounts'>,
    private readonly pipelines: Pick<PipelineService, 'getSummary'>
  ) {}

  list(): Project[] {
    return this.store.list()
  }

  async inspectDirectory(path: string): Promise<DirectoryInspection> {
    const isDirectory = existsSync(path) && statSync(path).isDirectory()
    const isGitRepo = isDirectory && (await this.git.isGitRepo(path))
    return {
      path,
      isDirectory,
      isGitRepo,
      detectedGithub: isGitRepo ? await this.git.detectGithubRemote(path) : null,
      suggestedName: basename(path)
    }
  }

  async add(input: AddProjectInput): Promise<Project> {
    const inspection = await this.inspectDirectory(input.path)
    if (!inspection.isDirectory) throw new Error(`Not a directory: ${input.path}`)
    if (!inspection.isGitRepo) throw new Error(`Not a git repository: ${input.path}`)
    return this.store.add(input)
  }

  async update(id: string, patch: ProjectPatch): Promise<Project> {
    if (patch.path !== undefined) {
      const inspection = await this.inspectDirectory(patch.path)
      if (!inspection.isGitRepo) throw new Error(`Not a git repository: ${patch.path}`)
    }
    return this.store.update(id, patch)
  }

  remove(id: string): void {
    this.store.remove(id)
  }

  async getStatus(id: string): Promise<ProjectStatusSummary> {
    const project = this.store.getOrThrow(id)
    if (!existsSync(project.path)) {
      return {
        projectId: id,
        state: 'missing',
        branch: null,
        dirty: false,
        changedFileCount: 0,
        sessionCount: 0,
        sessionsNeedingAttention: 0,
        pipeline: null
      }
    }
    const [repo, counts] = await Promise.all([
      this.git.status(project.path),
      Promise.resolve(safeCounts(this.sessions, id))
    ])
    return {
      projectId: id,
      state: 'ok',
      branch: repo.branch,
      dirty: repo.dirty,
      changedFileCount: repo.changedFileCount,
      sessionCount: counts.total,
      sessionsNeedingAttention: counts.needingAttention,
      pipeline: this.pipelines.getSummary(id)
    }
  }
}

function safeCounts(
  sessions: Pick<SessionService, 'attentionCounts'>,
  projectId: string
): { total: number; needingAttention: number } {
  try {
    return sessions.attentionCounts(projectId)
  } catch {
    return { total: 0, needingAttention: 0 }
  }
}
