import { existsSync, watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import type { Project } from '@shared/domain'
import type { SessionStorage } from './SessionStorage'

const DEBOUNCE_MS = 500

/**
 * Paths whose changes the repo watcher must not react to. .git internals churn
 * constantly (HEAD and index are enough to catch branch switches and staging)
 * and node_modules is never diff-relevant. Asar archives are ignored and, more
 * importantly, must never be stat'd by watcher internals: in a packaged app
 * Electron's patched fs opens any *.asar it stats and caches the handle for
 * the process lifetime, which locks the file and breaks builds running inside
 * a watched repo (e.g. electron-builder output). That is why watchRepo prefers
 * native recursive fs.watch, which never stats entries, over chokidar, whose
 * initial scan lstats every file before consulting its ignore filter.
 */
export function repoWatchIgnored(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  if (/\/node_modules(\/|$)/.test(normalized)) return true
  if (/\.asar$/i.test(normalized)) return true
  const gitIdx = normalized.indexOf('/.git/')
  if (gitIdx !== -1) {
    const inner = normalized.slice(gitIdx + 6)
    return inner !== 'HEAD' && inner !== 'index'
  }
  return false
}

export interface WatchEventSink {
  /** The working tree changed; diffs and status for this project are stale. */
  repoChanged(projectId: string): void
  /** Claude session storage for this project changed. */
  sessionsChanged(projectId: string): void
}

/** Common shape over native fs.FSWatcher and chokidar's FSWatcher. */
interface ClosableWatcher {
  close(): void | Promise<void>
}

/**
 * Watches each tracked project's working tree (debounced) and its Claude
 * session-storage directory so the UI stays current (tasks 3.4, 4.3).
 */
export class Watchers {
  private repoWatchers = new Map<string, ClosableWatcher>()
  private sessionWatchers = new Map<string, ClosableWatcher>()
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
    const onChange = (relPath: string | null): void => {
      // A null filename means the platform could not say what changed;
      // refresh rather than miss an update.
      if (relPath !== null && repoWatchIgnored(join(project.path, relPath))) return
      this.debounce(`repo:${project.id}`, () => this.sink.repoChanged(project.id))
    }
    this.repoWatchers.set(project.id, createRepoWatcher(project.path, onChange))
  }

  private watchSessions(project: Project): void {
    if (this.sessionWatchers.has(project.id)) return
    const dir = this.storage.sessionDirFor(project.path)
    if (!existsSync(dir)) return
    const watcher = chokidarWatch(dir, { ignoreInitial: true, depth: 1 })
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

/**
 * Watch a repo tree without ever stat'ing its files (see repoWatchIgnored):
 * native recursive fs.watch on platforms that support it (Windows, macOS),
 * chokidar elsewhere. Events are filtered by path string only.
 */
function createRepoWatcher(root: string, onChange: (relPath: string | null) => void): ClosableWatcher {
  try {
    const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      onChange(filename === null ? null : filename.toString())
    })
    // A dying native watcher (e.g. the directory was removed) must not crash
    // the process; sync() recreates watchers as projects change.
    watcher.on('error', () => watcher.close())
    return watcher
  } catch {
    // Recursive fs.watch is unsupported on this platform (Linux): fall back to
    // chokidar. Its scan stats every file, but POSIX open handles do not block
    // deletion, so the asar handle-caching hazard is Windows-only in practice.
    const watcher = chokidarWatch(root, { ignoreInitial: true, ignored: repoWatchIgnored })
    watcher.on('all', (_event, path) => onChange(path))
    return watcher
  }
}
