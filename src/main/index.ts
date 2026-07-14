import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { BrowserWindow, Notification, app, dialog, safeStorage, shell } from 'electron'
import type { Project, WorkflowRun } from '@shared/domain'
import { createTrackerApi } from './api'
import { emitTrackerEvent, registerTrackerApi } from './ipc'
import { ActiveTasksService } from './services/ActiveTasksService'
import { AnalyticsService, GithubMetricsProvider } from './services/AnalyticsService'
import { EditorService } from './services/EditorService'
import { createFakeAgentQuery } from './services/FakeAgentQuery'
import { GithubClient } from './services/GithubClient'
import { GitService } from './services/GitService'
import { InboxService } from './services/InboxService'
import { PipelineService } from './services/PipelineService'
import { ProjectService } from './services/ProjectService'
import { ProjectStore } from './services/ProjectStore'
import { ReleaseService } from './services/ReleaseService'
import { RunOrchestrator } from './services/RunOrchestrator'
import { SessionService } from './services/SessionService'
import type { QueryFn } from './services/SessionService'
import { SessionStorage } from './services/SessionStorage'
import { TaskService } from './services/TaskService'
import { TokenStore } from './services/TokenStore'
import { UsageService } from './services/UsageService'
import { Watchers } from './services/Watchers'

let mainWindow: BrowserWindow | null = null

/**
 * In packaged builds the SDK resolves its native claude binary inside
 * app.asar, where it exists for fs but cannot be spawned as a process.
 * electron-builder ships the platform package unpacked (asarUnpack), so point
 * the SDK at the on-disk binary; in dev the SDK's own resolution is correct.
 */
function createPackagedQuery(): QueryFn | undefined {
  if (!app.isPackaged) return undefined
  const pathToClaudeCodeExecutable = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  )
  return (props) => query({ ...props, options: { ...props.options, pathToClaudeCodeExecutable } })
}

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
    process.env.APT_FAKE_AGENT_SCRIPT
      ? createFakeAgentQuery(process.env.APT_FAKE_AGENT_SCRIPT)
      : createPackagedQuery()
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
    {
      claudeHome: process.env.APT_CLAUDE_HOME,
      isProjectLooping: (projectId) => store.get(projectId)?.looping ?? false,
      allowAgentTasks: (projectId) => store.get(projectId)?.agentTaskCreation ?? false
    }
  )
  sessions.setAttributionLookup((sdkSessionId) => orchestrator.attributionFor(sdkSessionId))
  inbox = new InboxService({ projects: store, tasks, runs: orchestrator, sessions })
  const activeTasks = new ActiveTasksService({ projects: store, tasks, runs: orchestrator })
  const release = new ReleaseService(git, tasks)

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

  // APT_USAGE_ENDPOINT is a test seam; undefined falls back to the real API.
  const usage = new UsageService({
    claudeHome: process.env.APT_CLAUDE_HOME,
    endpoint: process.env.APT_USAGE_ENDPOINT
  })

  const editor = new EditorService({
    // APT_TEST_EDITOR_CMD is a test seam: treat this executable as VS Code
    // so E2E runs never depend on (or launch) a real install.
    vsCodeCommand: process.env.APT_TEST_EDITOR_CMD,
    pickFallbackProgram: async (repoRoot) => {
      if (!mainWindow) return null
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'VS Code not found',
        message: 'Visual Studio Code was not found on this machine.',
        detail: `Choose another program to open ${repoRoot} with.`,
        buttons: ['Choose program…', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      if (choice.response !== 0) return null
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a program to open the project with',
        properties: ['openFile'],
        filters:
          process.platform === 'win32'
            ? [
                { name: 'Programs', extensions: ['exe', 'cmd', 'bat'] },
                { name: 'All files', extensions: ['*'] }
              ]
            : []
      })
      return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
    }
  })

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
    release,
    inbox,
    activeTasks,
    pipelines,
    analytics,
    github,
    tokens,
    editor,
    usage,
    appVersion: app.getVersion(),
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
