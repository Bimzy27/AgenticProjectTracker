import type {
  PipelineKind,
  PipelineLogLine,
  PipelineLogs,
  PipelineRun,
  Project,
  RunStatus
} from '@shared/domain'
import type { GithubClient } from './GithubClient'
import type { PipelinePoll, PipelineProvider } from './PipelineProvider'

interface GithubWorkflowRun {
  id: number
  name: string | null
  head_branch: string | null
  head_sha: string
  display_title: string
  status: string | null
  conclusion: string | null
  run_started_at: string | null
  updated_at: string
  html_url: string
}

/** The subset of the "list jobs for a workflow run" response this provider reads. */
interface GithubJob {
  id: number
  name: string
}

/** GitHub Actions annotates its own error/warning commands inline; everything else is plain stdout. */
const ANNOTATION_STDERR = /##\[error]|::error::/

/** Raw job logs prefix every line with an RFC3339 timestamp, e.g. "2026-07-01T10:00:00.1234567Z message". */
const TIMESTAMPED_LINE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s(.*)$/

/**
 * PipelineProvider backed by the GitHub Actions "list workflow runs" API,
 * with ETag conditional polling (D5). Logs are stitched together from the
 * per-job plain-text log endpoint (`GET .../jobs/{job_id}/logs`), since the
 * run-level endpoint only offers a zip archive; this mirrors the annotated,
 * per-job output GitHub's own UI shows for a run.
 */
export class GithubActionsPipelineProvider implements PipelineProvider {
  readonly kind: PipelineKind = 'github-actions'

  constructor(private readonly github: GithubClient) {}

  isConfigured(project: Project): boolean {
    return project.github !== null
  }

  async poll(project: Project, prevEtag: string | null): Promise<PipelinePoll> {
    const { owner, repo } = project.github!
    const response = await this.github.conditionalGet<{ workflow_runs: GithubWorkflowRun[] }>(
      '/repos/{owner}/{repo}/actions/runs',
      { owner, repo, per_page: 20 },
      prevEtag
    )
    if (response.notModified || !response.data) {
      return { runs: [], etag: response.etag ?? prevEtag, notModified: true }
    }
    return { runs: response.data.workflow_runs.map(mapRun), etag: response.etag, notModified: false }
  }

  async fetchLogs(project: Project, runId: string): Promise<PipelineLogs> {
    const { owner, repo } = project.github!
    const externalUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`
    const { jobs } = await this.github.get<{ jobs: GithubJob[] }>(
      '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
      { owner, repo, run_id: Number(runId) }
    )
    const lines: PipelineLogLine[] = []
    for (const job of jobs) {
      // Header line separates jobs when a run has more than one, mirroring the GitHub UI's per-job grouping.
      if (jobs.length > 1) lines.push({ at: null, stream: 'system', text: `== ${job.name} ==` })
      const text = await this.github.get<string>('/repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
        owner,
        repo,
        job_id: job.id
      })
      lines.push(...parseJobLog(text))
    }
    return { lines, externalUrl }
  }
}

/** Split one job's raw log text into normalized log lines, dropping blank lines. */
function parseJobLog(raw: string): PipelineLogLine[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '')
    .map(parseLogLine)
}

function parseLogLine(line: string): PipelineLogLine {
  const match = TIMESTAMPED_LINE.exec(line)
  const at = match ? match[1] : null
  const text = match ? match[2] : line
  return { at, stream: ANNOTATION_STDERR.test(text) ? 'stderr' : 'stdout', text }
}

/** Map one GitHub Actions workflow run to the generic PipelineRun shape. */
export function mapRun(run: GithubWorkflowRun): PipelineRun {
  return {
    id: String(run.id),
    pipeline: 'github-actions',
    name: run.name ?? 'workflow',
    branch: run.head_branch ?? '',
    commitSha: run.head_sha,
    commitMessage: run.display_title,
    status: mapStatus(run.status, run.conclusion),
    startedAt: run.run_started_at,
    durationSeconds:
      run.run_started_at && run.status === 'completed'
        ? Math.max(0, Math.round((Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 1000))
        : null,
    url: run.html_url,
    logsAvailable: true
  }
}

function mapStatus(status: string | null, conclusion: string | null): RunStatus {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success':
        return 'success'
      case 'failure':
      case 'timed_out':
      case 'startup_failure':
        return 'failure'
      case 'cancelled':
        return 'cancelled'
      case 'action_required':
        return 'action_required'
      case 'neutral':
      case 'skipped':
        return 'neutral'
      default:
        return 'unknown'
    }
  }
  if (status === 'queued' || status === 'pending') return 'queued'
  if (status === 'in_progress') return 'in_progress'
  if (status === 'waiting' || status === 'action_required') return 'action_required'
  return 'unknown'
}
