import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface PendingWrite {
  data: unknown
  timer: ReturnType<typeof setTimeout>
}

/**
 * Coalesces rapid JSON writes to the same file into one, off the caller's
 * synchronous path. Debounced per file path: a burst of writes to the same
 * path within the window collapses into just the last value written; writes
 * to different paths never interfere with each other (see ADR 0004).
 *
 * Writes are atomic (temp file + rename), so a reader never observes a
 * half-written file no matter when the process dies.
 */
export class DebouncedWriter {
  /** Scheduled but not yet started. */
  private readonly pending = new Map<string, PendingWrite>()
  /** Started asynchronously and not yet settled; retained so flush() can still land them. */
  private readonly inFlight = new Map<string, unknown>()

  constructor(private readonly debounceMs: number) {}

  /**
   * Schedule `data` to be written as JSON to `filePath`, replacing any pending
   * write to the same path. A write that fails (e.g. disk full) is dropped
   * silently rather than surfaced - see writeAtomic.
   */
  write(filePath: string, data: unknown): void {
    const existing = this.pending.get(filePath)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.pending.delete(filePath)
      this.inFlight.set(filePath, data)
      void this.writeAsync(filePath, data).finally(() => {
        if (this.inFlight.get(filePath) === data) this.inFlight.delete(filePath)
      })
    }, this.debounceMs)
    // A pending debounce must never keep the app alive on its own; flush()
    // (called before quit) is what guarantees the write actually lands.
    timer.unref?.()
    this.pending.set(filePath, { data, timer })
  }

  /**
   * Land every outstanding write immediately and synchronously, then return.
   *
   * Deliberately synchronous: this is the shutdown path, where blocking the
   * event loop for a few milliseconds costs nothing and awaiting async I/O
   * costs everything - a quit that depends on a promise settling can lose the
   * write if the process is killed first (Electron's quit, the OS, or a test
   * harness closing the app). Covers in-flight writes too, so the narrow
   * window between a debounce firing and its async write settling is durable
   * as well; re-writing the same bytes is harmless because writes are atomic.
   */
  flush(): void {
    // Pending data is newer than in-flight data for the same path, so it wins.
    const finalData = new Map<string, unknown>(this.inFlight)
    for (const [filePath, { timer, data }] of this.pending) {
      clearTimeout(timer)
      finalData.set(filePath, data)
    }
    this.pending.clear()
    this.inFlight.clear()
    for (const [filePath, data] of finalData) {
      try {
        const tmpPath = `${filePath}.tmp`
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
        renameSync(tmpPath, filePath)
      } catch {
        // Nothing useful to do while quitting; see writeAsync for the rationale.
      }
    }
  }

  private async writeAsync(filePath: string, data: unknown): Promise<void> {
    try {
      const tmpPath = `${filePath}.tmp`
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
      await rename(tmpPath, filePath)
    } catch {
      // Swallowed deliberately: a debounced write has no synchronous caller
      // left to propagate to (the pre-ADR-0004 synchronous writes threw
      // straight up to their IPC caller instead). The in-memory state this
      // write was persisting is unaffected, and the next scheduled write for
      // this path will retry - losing one snapshot is not fatal.
    }
  }
}
