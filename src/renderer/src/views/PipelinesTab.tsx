import { useCallback, useEffect, useState } from 'react'
import type {
  GithubAuthState,
  PipelineStatusSummary,
  Project,
  RateLimitState,
  WorkflowRun
} from '@shared/domain'
import { formatDuration, formatRelativeTime, tracker, useTrackerEvent } from '../tracker'
import { StatusBadge } from '../components/StatusBadge'

export function PipelinesTab({ project }: { project: Project }): React.JSX.Element {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [auth, setAuth] = useState<GithubAuthState | null>(null)
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null)

  useEffect(() => {
    tracker.invoke('getGithubAuthState').then(setAuth).catch(console.error)
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
      (payload: { projectId: string; summary: PipelineStatusSummary; runs: WorkflowRun[] }) => {
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

  if (!project.github) {
    return <div className="empty-state">Link a GitHub repo to this project to see pipeline runs.</div>
  }
  if (auth && !auth.configured) {
    return (
      <div className="empty-state">
        Pipelines need a GitHub token. Configure one in Settings; local features keep working without it.
      </div>
    )
  }

  return (
    <div className="pipelines-tab">
      {pollError && (
        <div className="info-banner">
          Last GitHub poll failed: {pollError}. Retrying with backoff; check the network or token if this
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
          {runs === null ? 'Waiting for the first poll…' : 'No workflow runs found for this repo.'}
        </div>
      ) : (
        <table className="runs-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Workflow</th>
              <th>Branch</th>
              <th>Commit</th>
              <th>Started</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <StatusBadge status={run.status} />
                </td>
                <td>{run.workflowName}</td>
                <td>
                  <code>{run.branch}</code>
                </td>
                <td title={run.commitMessage}>
                  <code>{run.commitSha.slice(0, 7)}</code> {truncate(run.commitMessage, 60)}
                </td>
                <td>{formatRelativeTime(run.startedAt)}</td>
                <td>{formatDuration(run.durationSeconds)}</td>
                <td>
                  <a href={run.url} target="_blank" rel="noreferrer">
                    View on GitHub ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
