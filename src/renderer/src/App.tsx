import { useCallback, useEffect, useState } from 'react'
import type { InboxItem, Project } from '@shared/domain'
import { tracker, useTrackerEvent } from './tracker'
import { AboutView } from './views/AboutView'
import { Dashboard } from './views/Dashboard'
import { InboxView } from './views/InboxView'
import { ProjectView } from './views/ProjectView'
import type { ProjectTab } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'

export type Route =
  | { view: 'dashboard' }
  | { view: 'settings' }
  | { view: 'about' }
  | { view: 'inbox' }
  | {
      view: 'project'
      projectId: string
      tab: ProjectTab
      /** Pre-select a task or session when arriving from the inbox or a notification. */
      focusTaskId?: string
      focusSessionId?: string
    }

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ view: 'dashboard' })
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [inboxCount, setInboxCount] = useState(0)

  const reload = useCallback(() => {
    tracker.invoke('listProjects').then(setProjects).catch(console.error)
  }, [])

  useEffect(reload, [reload])
  useEffect(() => {
    tracker
      .invoke('listInbox')
      .then((items) => setInboxCount(items.length))
      .catch(console.error)
  }, [])
  useTrackerEvent('projects-changed', setProjects)
  useTrackerEvent(
    'inbox-changed',
    useCallback((items: InboxItem[]) => setInboxCount(items.length), [])
  )
  useTrackerEvent(
    'navigate',
    useCallback((payload: { projectId: string; view: string }) => {
      if (payload.view === 'dashboard') setRoute({ view: 'dashboard' })
      else
        setRoute({
          view: 'project',
          projectId: payload.projectId,
          tab: payload.view as ProjectTab
        })
    }, [])
  )

  const activeProject =
    route.view === 'project' ? (projects?.find((p) => p.id === route.projectId) ?? null) : null

  return (
    <div className="app">
      <nav className="sidebar">
        <button
          className={`nav-item ${route.view === 'dashboard' ? 'active' : ''}`}
          onClick={() => setRoute({ view: 'dashboard' })}
        >
          ⌂ Dashboard
        </button>
        <button
          className={`nav-item ${route.view === 'inbox' ? 'active' : ''}`}
          onClick={() => setRoute({ view: 'inbox' })}
        >
          <span className="nav-item-label">
            ⚑ Inbox
            {inboxCount > 0 && <span className="attention-count">{inboxCount}</span>}
          </span>
        </button>
        <div className="sidebar-projects">
          {(projects ?? []).map((project) => (
            <button
              key={project.id}
              className={`nav-item ${route.view === 'project' && route.projectId === project.id ? 'active' : ''}`}
              onClick={() => setRoute({ view: 'project', projectId: project.id, tab: 'tasks' })}
              title={project.path}
            >
              {project.name}
            </button>
          ))}
        </div>
        <button
          className={`nav-item ${route.view === 'settings' ? 'active' : ''}`}
          onClick={() => setRoute({ view: 'settings' })}
        >
          ⚙ Settings
        </button>
        <button
          className={`nav-item ${route.view === 'about' ? 'active' : ''}`}
          onClick={() => setRoute({ view: 'about' })}
        >
          ⓘ About
        </button>
      </nav>
      <main className="content">
        {route.view === 'dashboard' && (
          <Dashboard
            projects={projects}
            onOpenProject={(projectId, tab) => setRoute({ view: 'project', projectId, tab })}
          />
        )}
        {route.view === 'inbox' && (
          <InboxView
            onOpen={(projectId, target, focusId) =>
              setRoute({
                view: 'project',
                projectId,
                tab: target,
                focusTaskId: target === 'tasks' ? focusId : undefined,
                focusSessionId: target === 'sessions' ? focusId : undefined
              })
            }
          />
        )}
        {route.view === 'settings' && <SettingsView />}
        {route.view === 'about' && <AboutView />}
        {route.view === 'project' &&
          (activeProject ? (
            <ProjectView
              key={activeProject.id}
              project={activeProject}
              tab={route.tab}
              focusTaskId={route.focusTaskId}
              focusSessionId={route.focusSessionId}
              onTabChange={(tab) =>
                setRoute({ ...route, tab, focusTaskId: undefined, focusSessionId: undefined })
              }
              onFocusTask={(taskId) =>
                setRoute({ ...route, tab: 'tasks', focusTaskId: taskId, focusSessionId: undefined })
              }
              onFocusSession={(sessionId) =>
                setRoute({ ...route, tab: 'sessions', focusSessionId: sessionId, focusTaskId: undefined })
              }
            />
          ) : (
            <div className="empty-state">Project not found. It may have been removed.</div>
          ))}
      </main>
    </div>
  )
}
