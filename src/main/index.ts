import { join } from 'node:path'
import { BrowserWindow, Notification, app, dialog, safeStorage, shell } from 'electron'
import type { Project, WorkflowRun } from '@shared/domain'
import { createTrackerApi } from './api'
import { emitTrackerEvent, registerTrackerApi } from './ipc'
import { AnalyticsService, GithubMetricsProvider } from './services/AnalyticsService'
import { createFakeAgentQuery } from './services/FakeAgentQuery'
import { GithubClient } from './services/GithubClient'
import { GitService } from './services/GitService'
import { InboxService } from './services/InboxService'
import { PipelineService } from './services/PipelineService'
import { ProjectService } from './services/ProjectService'
import { ProjectStore } from './services/ProjectStore'
import { RunOrchestrator } from './services/RunOrchestrator'
import { SessionService } from './services/SessionService'
import { SessionStorage } from './services/SessionStorage'
import { TaskService } from './services/TaskService'
import { TokenStore } from './services/TokenStore'
import { Watchers } from './services/Watchers'

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Agentic Project Tracker',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function composeServices(): { pipelines: PipelineService; watchers: Watchers; store: ProjectStore } {
  const userDataDir = app.getPath('userData')

  const store = new ProjectStore(userDataDir)
  const git = new GitService()
  // APT_CLAUDE_HOME is a test seam; undefined falls back to ~/.claude
  const storage = new SessionStorage(process.env.APT_CLAUDE_HOME)

  // Declared before the session sink so its closure can recompute the inbox.
  let inbox: InboxService | null = null
  const pushInbox = (): void => {
    if (inbox) emitTrackerEvent('inbox-changed', inbox.list())
  }

  const sessions = new SessionService(
    storage,
    store,
    userDataDir,
    {
      sessionUpdated: (summary) => {
        emitTrackerEvent('session-updated', summary)
        // Permission prompts on run sessions surface as inbox items.
        if (summary.taskId) pushInbox()
      },
      transcriptAppended: (projectId, sessionId, items) =>
        emitTrackerEvent('transcript-appended', { projectId, sessionId, items })
    },
    // APT_FAKE_AGENT_SCRIPT is a test seam: a scripted agent instead of the real SDK.
    process.env.APT_FAKE_AGENT_SCRIPT ? createFakeAgentQuery(process.env.APT_FAKE_AGENT_SCRIPT) : undefined
  )

  const tasks = new TaskService(userDataDir, {
    tasksChanged: (projectId, projectTasks) => {
      emitTrackerEvent('tasks-changed', { projectId, tasks: projectTasks })
      void pushProjectStatus(projectId)
      pushInbox()
    }
  })

  const orchestrator = new RunOrchestrator(
    userDataDir,
    tasks,
    sessions,
    {
      runUpdated: (run) => {
        emitTrackerEvent('run-updated', run)
        pushInbox()
      }
    },
    { claudeHome: process.env.APT_CLAUDE_HOME }
  )
  sessions.setAttributionLookup((sdkSessionId) => orchestrator.attributionFor(sdkSessionId))
  inbox = new InboxService({ projects: store, tasks, runs: orchestrator, sessions })

  const tokens = new TokenStore(userDataDir, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf)
  })
  const github = new GithubClient(tokens, (state) => emitTrackerEvent('rate-limit-changed', state))

  const pipelines = new PipelineService(github, store, {
    pipelineUpdated: (projectId, summary, runs) => {
      emitTrackerEvent('pipeline-updated', { projectId, summary, runs })
      void pushProjectStatus(projectId)
    },
    notifyRun: (project: Project, run: WorkflowRun) => notifyPipelineRun(project, run)
  })

  const analytics = new AnalyticsService(new GithubMetricsProvider(github))
  const projects = new ProjectService(store, git, sessions, pipelines, orchestrator)

  const watchers = new Watchers(storage, {
    repoChanged: (projectId) => {
      emitTrackerEvent('diff-changed', { projectId })
      void pushProjectStatus(projectId)
    },
    sessionsChanged: (projectId) => {
      for (const summary of safeList(() => sessions.listSessions(projectId))) {
        emitTrackerEvent('session-updated', summary)
      }
      void pushProjectStatus(projectId)
    }
  })

  const api = createTrackerApi({
    store,
    projects,
    git,
    sessions,
    tasks,
    orchestrator,
    inbox,
    pipelines,
    analytics,
    github,
    tokens,
    pickDirectory: async () => {
      // Test seam: E2E tests cannot drive the native dialog.
      if (process.env.APT_TEST_PICK_DIR) return process.env.APT_TEST_PICK_DIR
      if (!mainWindow) return null
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    },
    onProjectsChanged: () => {
      emitTrackerEvent('projects-changed', store.list())
      watchers.sync(store.list())
    }
  })
  registerTrackerApi(api)

  // Reconcile persisted runs (active -> interrupted) and start queued tasks.
  orchestrator.restore()

  async function pushProjectStatus(projectId: string): Promise<void> {
    try {
      emitTrackerEvent('project-status-changed', await projects.getStatus(projectId))
    } catch {
      // project may have been removed between event and status read
    }
  }

  function notifyPipelineRun(project: Project, run: WorkflowRun): void {
    if (!Notification.isSupported()) return
    const label = run.status === 'failure' ? 'failed' : 'needs attention'
    const notification = new Notification({
      title: `${project.name}: ${run.workflowName} ${label}`,
      body: `Branch ${run.branch} · ${run.commitMessage}`
    })
    notification.on('click', () => {
      mainWindow?.show()
      mainWindow?.focus()
      emitTrackerEvent('navigate', { projectId: project.id, view: 'pipelines' })
    })
    notification.show()
  }

  return { pipelines, watchers, store }
}

function safeList<T>(fn: () => T[]): T[] {
  try {
    return fn()
  } catch {
    return []
  }
}

// Test seam: isolate all app state into a throwaway directory during E2E runs.
if (process.env.APT_USER_DATA_DIR) {
  app.setPath('userData', process.env.APT_USER_DATA_DIR)
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.branden.agentic-project-tracker')
  const { pipelines, watchers, store } = composeServices()

  mainWindow = createWindow()
  watchers.sync(store.list())
  pipelines.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  app.on('before-quit', () => {
    pipelines.stop()
    void watchers.close()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
