import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@shared/domain'
import { tracker, useTrackerEvent } from './tracker'
import { Dashboard } from './views/Dashboard'
import { ProjectView } from './views/ProjectView'
import type { ProjectTab } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'

export type Route =
  { view: 'dashboard' } | { view: 'settings' } | { view: 'project'; projectId: string; tab: ProjectTab }

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ view: 'dashboard' })
  const [projects, setProjects] = useState<Project[] | null>(null)

  const reload = useCallback(() => {
    tracker.invoke('listProjects').then(setProjects).catch(console.error)
  }, [])

  useEffect(reload, [reload])
  useTrackerEvent('projects-changed', setProjects)
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
        <div className="sidebar-projects">
          {(projects ?? []).map((project) => (
            <button
              key={project.id}
              className={`nav-item ${route.view === 'project' && route.projectId === project.id ? 'active' : ''}`}
              onClick={() => setRoute({ view: 'project', projectId: project.id, tab: 'diffs' })}
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
      </nav>
      <main className="content">
        {route.view === 'dashboard' && (
          <Dashboard
            projects={projects}
            onOpenProject={(projectId, tab) => setRoute({ view: 'project', projectId, tab })}
          />
        )}
        {route.view === 'settings' && <SettingsView />}
        {route.view === 'project' &&
          (activeProject ? (
            <ProjectView
              key={activeProject.id}
              project={activeProject}
              tab={route.tab}
              onTabChange={(tab) => setRoute({ ...route, tab })}
            />
          ) : (
            <div className="empty-state">Project not found. It may have been removed.</div>
          ))}
      </main>
    </div>
  )
}
