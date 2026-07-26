import { useState } from 'react'
import type { Project } from '@shared/domain'
import { tracker } from '../tracker'
import { InfoTip } from '../components/InfoTip'
import { ProjectLinksDialog } from '../components/ProjectLinksDialog'
import { ProjectVercelDialog } from '../components/ProjectVercelDialog'
import { AnalyticsTab } from './AnalyticsTab'
import { DiffsTab } from './DiffsTab'
import { PipelinesTab } from './PipelinesTab'
import { ReleaseTab } from './ReleaseTab'
import { SessionsTab } from './SessionsTab'
import { SkillsTab } from './SkillsTab'
import { TasksTab } from './TasksTab'
import { TerminalsTab } from './TerminalsTab'

export type ProjectTab =
  'tasks' | 'diffs' | 'sessions' | 'terminals' | 'pipelines' | 'release' | 'analytics' | 'skills'

const TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'diffs', label: 'Diffs' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'terminals', label: 'Terminals' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'release', label: 'Release' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'skills', label: 'Skills' }
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
  const [editingLinks, setEditingLinks] = useState(false)
  const [editingVercel, setEditingVercel] = useState(false)
  // Once a tab is visited it stays mounted for this ProjectView's lifetime
  // (ADR 0005): switching tabs hides via CSS instead of unmounting, so a
  // revisited tab doesn't re-fire its mount-time IPC calls or flash a loading
  // state. Bounded to at most TABS.length entries; ProjectView itself fully
  // remounts per project via the `key` prop in App.tsx, so nothing leaks
  // across projects. Adjusted during render (not an effect) per React's
  // "adjusting state when a prop changes" pattern.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<ProjectTab>>(() => new Set([tab]))
  const [prevTab, setPrevTab] = useState(tab)
  if (tab !== prevTab) {
    setPrevTab(tab)
    if (!visitedTabs.has(tab)) setVisitedTabs(new Set(visitedTabs).add(tab))
  }

  return (
    <div className="project-view">
      <header className="view-header">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">
            {project.path}
            {project.github ? ` · ${project.github.owner}/${project.github.repo}` : ''}
          </p>
          <div className="project-links">
            {project.links.map((link) => (
              <a
                key={`${link.label}\n${link.url}`}
                className="chip project-link"
                href={link.url}
                target="_blank"
                rel="noreferrer"
                title={link.url}
              >
                {link.label} ↗
              </a>
            ))}
            <button
              className="project-links-edit"
              title="Configure important links for this project"
              onClick={() => setEditingLinks(true)}
            >
              {project.links.length > 0 ? '✎ Edit links' : '+ Add links'}
            </button>
            <button
              className="project-links-edit"
              title="Link a Vercel project to see its deployments on the Pipelines tab"
              onClick={() => setEditingVercel(true)}
            >
              {project.vercel ? `✎ Vercel: ${project.vercel.projectId}` : '+ Link Vercel project'}
            </button>
          </div>
        </div>
        <div className="view-header-actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={project.looping}
              onChange={(e) =>
                void tracker
                  .invoke('updateProject', project.id, { looping: e.target.checked })
                  .catch(console.error)
              }
            />
            Looping
          </label>
          <InfoTip text="Looping mode keeps agents working through this project's backlog: when a task's run completes it is approved automatically (skipping your review, including tasks already waiting in review), and the next backlog task is delegated on its own. Delegated runs' permission requests are also auto-approved so the loop runs unattended. Questions and failures still come to you. Off by default." />
          <label className="toggle">
            <input
              type="checkbox"
              checked={project.agentTaskCreation}
              onChange={(e) =>
                void tracker
                  .invoke('updateProject', project.id, { agentTaskCreation: e.target.checked })
                  .catch(console.error)
              }
            />
            Agent tasks
          </label>
          <InfoTip text="Agent tasks lets agents working in this project add tasks to the backlog themselves, e.g. to report a defect they noticed, promote a release, or propose a functionality or code-quality improvement. Proposed tasks land as drafts for your review; nothing runs without you delegating it (unless looping picks it up). Off by default." />
          <button
            title="Open the repository root in VS Code"
            onClick={() => void tracker.invoke('openProjectInEditor', project.id).catch(console.error)}
          >
            VSCode
          </button>
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
      {visitedTabs.has('tasks') && (
        <div className={tabPanelClass(tab === 'tasks')}>
          <TasksTab project={project} initialSelectedId={focusTaskId} onOpenTranscript={onFocusSession} />
        </div>
      )}
      {visitedTabs.has('diffs') && (
        <div className={tabPanelClass(tab === 'diffs')}>
          <DiffsTab project={project} />
        </div>
      )}
      {visitedTabs.has('sessions') && (
        <div className={tabPanelClass(tab === 'sessions')}>
          <SessionsTab project={project} initialSelectedId={focusSessionId} onOpenTask={onFocusTask} />
        </div>
      )}
      {visitedTabs.has('terminals') && (
        <div className={tabPanelClass(tab === 'terminals')}>
          <TerminalsTab project={project} />
        </div>
      )}
      {visitedTabs.has('pipelines') && (
        <div className={tabPanelClass(tab === 'pipelines')}>
          <PipelinesTab project={project} />
        </div>
      )}
      {visitedTabs.has('release') && (
        <div className={tabPanelClass(tab === 'release')}>
          <ReleaseTab project={project} onOpenTask={onFocusTask} />
        </div>
      )}
      {visitedTabs.has('analytics') && (
        <div className={tabPanelClass(tab === 'analytics')}>
          <AnalyticsTab key={project.id} project={project} />
        </div>
      )}
      {visitedTabs.has('skills') && (
        <div className={tabPanelClass(tab === 'skills')}>
          <SkillsTab project={project} />
        </div>
      )}
      {editingLinks && <ProjectLinksDialog project={project} onClose={() => setEditingLinks(false)} />}
      {editingVercel && <ProjectVercelDialog project={project} onClose={() => setEditingVercel(false)} />}
    </div>
  )
}

function tabPanelClass(active: boolean): string {
  return active ? 'tab-panel' : 'tab-panel tab-panel-hidden'
}
