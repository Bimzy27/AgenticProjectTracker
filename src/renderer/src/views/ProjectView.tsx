import type { Project } from '@shared/domain'
import { AnalyticsTab } from './AnalyticsTab'
import { DiffsTab } from './DiffsTab'
import { PipelinesTab } from './PipelinesTab'
import { SessionsTab } from './SessionsTab'
import { TasksTab } from './TasksTab'

export type ProjectTab = 'tasks' | 'diffs' | 'sessions' | 'pipelines' | 'analytics'

const TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'diffs', label: 'Diffs' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'analytics', label: 'Analytics' }
]

interface Props {
  project: Project
  tab: ProjectTab
  /** Pre-select a task/session in the corresponding tab (inbox or cross-tab navigation). */
  focusTaskId?: string
  focusSessionId?: string
  onTabChange: (tab: ProjectTab) => void
  onFocusTask: (taskId: string) => void
  onFocusSession: (sessionId: string) => void
}

export function ProjectView({
  project,
  tab,
  focusTaskId,
  focusSessionId,
  onTabChange,
  onFocusTask,
  onFocusSession
}: Props): React.JSX.Element {
  return (
    <div className="project-view">
      <header className="view-header">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">
            {project.path}
            {project.github ? ` · ${project.github.owner}/${project.github.repo}` : ''}
          </p>
        </div>
      </header>
      <div className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'tasks' && (
        <TasksTab project={project} initialSelectedId={focusTaskId} onOpenTranscript={onFocusSession} />
      )}
      {tab === 'diffs' && <DiffsTab project={project} />}
      {tab === 'sessions' && (
        <SessionsTab project={project} initialSelectedId={focusSessionId} onOpenTask={onFocusTask} />
      )}
      {tab === 'pipelines' && <PipelinesTab project={project} />}
      {tab === 'analytics' && <AnalyticsTab project={project} />}
    </div>
  )
}
