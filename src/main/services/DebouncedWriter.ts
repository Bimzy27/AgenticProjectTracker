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
 */
export class DebouncedWriter {
  private readonly pending = new Map<string, PendingWrite>()

  constructor(private readonly debounceMs: number) {}

  /**
   * Schedule `data` to be written as JSON to `filePath`, replacing any pending
   * write to the same path. A write that fails (e.g. disk full) is dropped
   * silently rather than surfaced - see flushNow.
   */
  write(filePath: string, data: unknown): void {
    const existing = this.pending.get(filePath)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.pending.delete(filePath)
      void this.flushNow(filePath, data)
    }, this.debounceMs)
    // A pending debounce must never keep the app alive on its own; flushAll()
    // (called before quit) is what guarantees the write actually lands.
    timer.unref?.()
    this.pending.set(filePath, { data, timer })
  }

  /**
   * Land every pending write immediately, in path order. Call before the app
   * quits. Never rejects - a failed write is dropped silently (see flushNow),
   * so a broken filesystem cannot block shutdown here.
   */
  async flushAll(): Promise<void> {
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [filePath, { timer, data }] of entries) {
      clearTimeout(timer)
      await this.flushNow(filePath, data)
    }
  }

  private async flushNow(filePath: string, data: unknown): Promise<void> {
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
