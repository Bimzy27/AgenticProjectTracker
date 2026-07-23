import { useCallback, useEffect, useState } from 'react'
import type {
  GithubAuthState,
  PipelineKind,
  PipelineRun,
  PipelineStatusSummary,
  Project,
  RateLimitState,
  VercelAuthState
} from '@shared/domain'
import { PIPELINE_KIND_LABELS } from '@shared/domain'
import { formatDuration, formatRelativeTime, tracker, useTrackerEvent } from '../tracker'
import { StatusBadge } from '../components/StatusBadge'
import { PipelineLogsDialog } from '../components/PipelineLogsDialog'

export function PipelinesTab({ project }: { project: Project }): React.JSX.Element {
  const [runs, setRuns] = useState<PipelineRun[] | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [githubAuth, setGithubAuth] = useState<GithubAuthState | null>(null)
  const [vercelAuth, setVercelAuth] = useState<VercelAuthState | null>(null)
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null)
  const [inspecting, setInspecting] = useState<{
    pipeline: PipelineKind
    runId: string
    title: string
  } | null>(null)

  useEffect(() => {
    tracker.invoke('getGithubAuthState').then(setGithubAuth).catch(console.error)
    tracker.invoke('getVercelAuthState').then(setVercelAuth).catch(console.error)
    tracker.invoke('getPipelineRuns', project.id).then(setRuns).catch(console.error)
    tracker.invoke('getRateLimit').then(setRateLimit).catch(console.error)
    tracker
      .invoke('getProjectStatus', project.id)
      .then((status) => setPollError(status.pipeline?.error ?? null))
      .catch(console.error)
  }, [project.id])

  useTrackerEvent(
    'pipeline-updated',
    useCallback(
      (payload: { projectId: string; summary: PipelineStatusSummary; runs: PipelineRun[] }) => {
        if (payload.projectId !== project.id) return
        setRuns(payload.runs)
        setPollError(payload.summary.error ?? null)
      },
      [project.id]
    )
  )
  useTrackerEvent(
    'rate-limit-changed',
    useCallback((state: RateLimitState) => setRateLimit(state), [])
  )

  if (!project.github && !project.vercel) {
    return (
      <div className="empty-state">
        Link a GitHub repo or a Vercel project to this project to see pipeline runs.
      </div>
    )
  }

  return (
    <div className="pipelines-tab">
      {project.github && githubAuth && !githubAuth.configured && (
        <div className="info-banner">
          GitHub Actions pipelines need a GitHub token. Configure one in Settings; local features keep working
          without it.
        </div>
      )}
      {project.vercel && vercelAuth && !vercelAuth.configured && (
        <div className="info-banner">
          Vercel deployments need a Vercel access token. Configure one in Settings.
        </div>
      )}
      {pollError && (
        <div className="info-banner">
          Last pipeline poll failed: {pollError}. Retrying with backoff; check the network or tokens if this
          persists.
        </div>
      )}
      {rateLimit?.low && (
        <div className="info-banner">
          GitHub API rate limit is low ({rateLimit.remaining} left, resets{' '}
          {formatRelativeTime(rateLimit.resetAt)}). Polling has backed off.
        </div>
      )}
      {runs === null || runs.length === 0 ? (
        <div className="empty-state">
          {runs === null ? 'Waiting for the first poll…' : 'No pipeline runs found yet.'}
        </div>
      ) : (
        <table className="runs-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Pipeline</th>
              <th>Name</th>
              <th>Branch</th>
              <th>Commit</th>
              <th>Started</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={`${run.pipeline}:${run.id}`}>
                <td>
                  <StatusBadge status={run.status} />
                </td>
                <td>{PIPELINE_KIND_LABELS[run.pipeline] ?? run.pipeline}</td>
                <td>{run.name}</td>
                <td>
                  <code>{run.branch}</code>
                </td>
                <td title={run.commitMessage}>
                  {run.commitSha && <code>{run.commitSha.slice(0, 7)}</code>}{' '}
                  {truncate(run.commitMessage, 60)}
                </td>
                <td>{formatRelativeTime(run.startedAt)}</td>
                <td>{formatDuration(run.durationSeconds)}</td>
                <td className="runs-table-actions">
                  {run.logsAvailable && (
                    <button
                      onClick={() =>
                        setInspecting({
                          pipeline: run.pipeline,
                          runId: run.id,
                          title: `${run.name} · ${run.branch}`
                        })
                      }
                    >
                      View logs
                    </button>
                  )}
                  <a href={run.url} target="_blank" rel="noreferrer">
                    View on {PIPELINE_KIND_LABELS[run.pipeline] ?? run.pipeline} ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {inspecting && (
        <PipelineLogsDialog
          projectId={project.id}
          pipeline={inspecting.pipeline}
          runId={inspecting.runId}
          title={inspecting.title}
          onClose={() => setInspecting(null)}
        />
      )}
    </div>
  )
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
