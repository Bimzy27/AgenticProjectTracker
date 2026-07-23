import { useCallback, useEffect, useState } from 'react'
import type { Project, ProjectStatusSummary } from '@shared/domain'
import { tracker, useTrackerEvent } from '../tracker'
import { AddProjectDialog } from '../components/AddProjectDialog'
import { StatusBadge } from '../components/StatusBadge'
import type { ProjectTab } from './ProjectView'

interface Props {
  projects: Project[] | null
  onOpenProject: (projectId: string, tab: ProjectTab) => void
}

export function Dashboard({ projects, onOpenProject }: Props): React.JSX.Element {
  const [statuses, setStatuses] = useState<Record<string, ProjectStatusSummary>>({})
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    for (const project of projects ?? []) {
      tracker
        .invoke('getProjectStatus', project.id)
        .then((status) => setStatuses((prev) => ({ ...prev, [project.id]: status })))
        .catch(console.error)
    }
  }, [projects])

  useTrackerEvent(
    'project-status-changed',
    useCallback((status: ProjectStatusSummary) => {
      setStatuses((prev) => ({ ...prev, [status.projectId]: status }))
    }, [])
  )

  if (projects === null) return <div className="empty-state">Loading projects…</div>

  const allTags = [...new Set(projects.flatMap((p) => p.tags))].sort()
  const visible = tagFilter ? projects.filter((p) => p.tags.includes(tagFilter)) : projects

  return (
    <div className="dashboard">
      <header className="view-header">
        <h1>Dashboard</h1>
        <button className="primary" onClick={() => setAdding(true)}>
          + Add project
        </button>
      </header>

      {allTags.length > 0 && (
        <div className="tag-filter">
          <button className={`chip ${tagFilter === null ? 'active' : ''}`} onClick={() => setTagFilter(null)}>
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`chip ${tagFilter === tag ? 'active' : ''}`}
              onClick={() => setTagFilter(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="empty-state">
          {projects.length === 0
            ? 'No projects yet. Add a local git repository to start tracking it.'
            : 'No projects match this category.'}
        </div>
      ) : (
        <div className="project-grid">
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              status={statuses[project.id] ?? null}
              onOpen={(tab) => onOpenProject(project.id, tab)}
            />
          ))}
        </div>
      )}

      {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
    </div>
  )
}

function ProjectCard({
  project,
  status,
  onOpen
}: {
  project: Project
  status: ProjectStatusSummary | null
  onOpen: (tab: ProjectTab) => void
}): React.JSX.Element {
  if (status?.state === 'missing') {
    return (
      <div className="project-card error">
        <h2>{project.name}</h2>
        <p className="error-text">Directory not found: {project.path}</p>
        <div className="card-actions">
          <button onClick={() => void relocate(project.id)}>Relocate…</button>
          <button className="danger" onClick={() => void tracker.invoke('removeProject', project.id)}>
            Remove
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="project-card" onClick={() => onOpen('diffs')} role="button" tabIndex={0}>
      <div className="card-title-row">
        <h2>{project.name}</h2>
        {status?.pipeline && <StatusBadge status={status.pipeline.overall} />}
      </div>
      <p className="muted">
        {project.github ? `${project.github.owner}/${project.github.repo}` : 'no GitHub repo'}
      </p>
      {status?.pipeline && status.pipeline.failureRatePercent !== null && (
        <p
          className={`stat build-stability ${status.pipeline.failureRatePercent > 0 ? 'warn' : ''}`}
          title={`Failure rate over the last ${status.pipeline.failureRateSampleSize} completed pipeline runs`}
        >
          ⚠ {status.pipeline.failureRatePercent}% failed (last {status.pipeline.failureRateSampleSize})
        </p>
      )}
      <div className="card-stats">
        <span className="stat" title="Current branch">
          ⎇ {status?.branch ?? '…'}
        </span>
        <span className={`stat ${status?.dirty ? 'warn' : ''}`} title="Uncommitted changes">
          {status ? (status.dirty ? `● ${status.changedFileCount} changed` : '○ clean') : '…'}
        </span>
        <button
          className={`stat linkish ${status && status.sessionsNeedingAttention > 0 ? 'attention' : ''}`}
          title="Agent sessions"
          onClick={(e) => {
            e.stopPropagation()
            onOpen('sessions')
          }}
        >
          ◆ {status?.sessionCount ?? '…'} session{status?.sessionCount === 1 ? '' : 's'}
          {status && status.sessionsNeedingAttention > 0
            ? ` (${status.sessionsNeedingAttention} waiting)`
            : ''}
        </button>
      </div>
      {status && <DelegationLine status={status} onOpen={onOpen} />}
      {project.tags.length > 0 && (
        <div className="card-tags">
          {project.tags.map((tag) => (
            <span key={tag} className="chip small">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function DelegationLine({
  status,
  onOpen
}: {
  status: ProjectStatusSummary
  onOpen: (tab: ProjectTab) => void
}): React.JSX.Element | null {
  const { delegation } = status
  const parts: string[] = []
  if (delegation.running > 0) parts.push(`${delegation.running} running`)
  if (delegation.queued > 0) parts.push(`${delegation.queued} queued`)
  if (delegation.needsInput > 0) parts.push(`${delegation.needsInput} needs input`)
  if (delegation.review > 0) parts.push(`${delegation.review} in review`)
  if (delegation.paused > 0) parts.push(`${delegation.paused} paused`)
  if (parts.length === 0) return null
  return (
    <button
      className={`delegation-line linkish ${delegation.needsInput > 0 ? 'attention' : ''}`}
      title="Delegated tasks"
      onClick={(e) => {
        e.stopPropagation()
        onOpen('tasks')
      }}
    >
      <span>⚑ {parts.join(' · ')}</span>
      {delegation.activeTaskTitle && (
        <span className="delegation-progress muted">
          {delegation.activeTaskTitle}
          {delegation.activeProgressNote ? `: ${delegation.activeProgressNote}` : ''}
        </span>
      )}
    </button>
  )
}

async function relocate(projectId: string): Promise<void> {
  const path = await tracker.invoke('pickProjectDirectory')
  if (!path) return
  try {
    await tracker.invoke('updateProject', projectId, { path })
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
}
