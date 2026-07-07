import { existsSync } from 'node:fs'
import { watch } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { Project } from '@shared/domain'
import type { SessionStorage } from './SessionStorage'

const DEBOUNCE_MS = 500

export interface WatchEventSink {
  /** The working tree changed; diffs and status for this project are stale. */
  repoChanged(projectId: string): void
  /** Claude session storage for this project changed. */
  sessionsChanged(projectId: string): void
}

/**
 * Watches each tracked project's working tree (debounced) and its Claude
 * session-storage directory so the UI stays current (tasks 3.4, 4.3).
 */
export class Watchers {
  private repoWatchers = new Map<string, FSWatcher>()
  private sessionWatchers = new Map<string, FSWatcher>()
  private pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly storage: SessionStorage,
    private readonly sink: WatchEventSink
  ) {}

  sync(projects: Project[]): void {
    const keep = new Set(projects.map((p) => p.id))
    for (const [id, watcher] of this.repoWatchers) {
      if (!keep.has(id)) {
        void watcher.close()
        this.repoWatchers.delete(id)
      }
    }
    for (const [id, watcher] of this.sessionWatchers) {
      if (!keep.has(id)) {
        void watcher.close()
        this.sessionWatchers.delete(id)
      }
    }
    for (const project of projects) {
      this.watchRepo(project)
      this.watchSessions(project)
    }
  }

  async close(): Promise<void> {
    await Promise.all([
      ...[...this.repoWatchers.values()].map((w) => w.close()),
      ...[...this.sessionWatchers.values()].map((w) => w.close())
    ])
    this.repoWatchers.clear()
    this.sessionWatchers.clear()
  }

  private watchRepo(project: Project): void {
    if (this.repoWatchers.has(project.id) || !existsSync(project.path)) return
    const watcher = watch(project.path, {
      ignoreInitial: true,
      // .git internals churn constantly; HEAD and index are enough to catch
      // branch switches and staging. node_modules is never diff-relevant.
      ignored: (path: string) => {
        const normalized = path.replace(/\\/g, '/')
        if (/\/node_modules(\/|$)/.test(normalized)) return true
        const gitIdx = normalized.indexOf('/.git/')
        if (gitIdx !== -1) {
          const inner = normalized.slice(gitIdx + 6)
          return inner !== 'HEAD' && inner !== 'index'
        }
        return false
      }
    })
    watcher.on('all', () => this.debounce(`repo:${project.id}`, () => this.sink.repoChanged(project.id)))
    this.repoWatchers.set(project.id, watcher)
  }

  private watchSessions(project: Project): void {
    if (this.sessionWatchers.has(project.id)) return
    const dir = this.storage.sessionDirFor(project.path)
    if (!existsSync(dir)) return
    const watcher = watch(dir, { ignoreInitial: true, depth: 1 })
    watcher.on('all', () =>
      this.debounce(`sessions:${project.id}`, () => this.sink.sessionsChanged(project.id))
    )
    this.sessionWatchers.set(project.id, watcher)
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing)
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key)
        fn()
      }, DEBOUNCE_MS)
    )
  }
}
