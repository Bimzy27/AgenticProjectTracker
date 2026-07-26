import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DebouncedWriter } from '../src/main/services/DebouncedWriter'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits for a debounced write to land. These tests exercise real timers and
 * real disk, so they poll for the result instead of sleeping a fixed amount:
 * a loaded machine can delay a timer or an fs call well past any margin worth
 * hard-coding.
 */
async function readWhenWritten(filePath: string): Promise<unknown> {
  return vi.waitFor(() => JSON.parse(readFileSync(filePath, 'utf8')), { timeout: 5000, interval: 10 })
}

describe('DebouncedWriter', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apt-writer-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the file once the debounce window elapses', async () => {
    const writer = new DebouncedWriter(30)
    const filePath = join(dir, 'a.json')

    writer.write(filePath, { value: 1 })
    // Nothing is written on the caller's own turn; that is the whole point.
    expect(existsSync(filePath)).toBe(false)

    expect(await readWhenWritten(filePath)).toEqual({ value: 1 })
  })

  it('coalesces rapid writes to the same path into the last value', async () => {
    // A long window so the burst is unambiguously inside it, and flush() to
    // settle it, rather than racing a wall clock for the same conclusion.
    const writer = new DebouncedWriter(10_000)
    const filePath = join(dir, 'a.json')

    writer.write(filePath, { value: 1 })
    writer.write(filePath, { value: 2 })
    writer.write(filePath, { value: 3 })
    writer.flush()

    // One file holding only the last value: the earlier two never reached disk.
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ value: 3 })
  })

  it('debounces writes to different paths independently', async () => {
    const writer = new DebouncedWriter(30)
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')

    // Writing to b must not cancel or delay a's already-scheduled write.
    writer.write(a, { value: 'a' })
    writer.write(b, { value: 'b' })

    expect(await readWhenWritten(a)).toEqual({ value: 'a' })
    expect(await readWhenWritten(b)).toEqual({ value: 'b' })
  })

  it('flush lands every pending write synchronously, without waiting for the debounce window', () => {
    const writer = new DebouncedWriter(10_000)
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    writer.write(a, { value: 'a' })
    writer.write(b, { value: 'b' })

    writer.flush()

    // Synchronous by contract: readable on the very next line, with no await.
    expect(JSON.parse(readFileSync(a, 'utf8'))).toEqual({ value: 'a' })
    expect(JSON.parse(readFileSync(b, 'utf8'))).toEqual({ value: 'b' })
  })

  it('flush also lands a write already in flight when it is called', async () => {
    const writer = new DebouncedWriter(10)
    const filePath = join(dir, 'a.json')
    writer.write(filePath, { value: 'inflight' })

    // Let the debounce fire so the async write has started but may not have
    // settled, then flush as the quit path does.
    await wait(15)
    writer.flush()

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ value: 'inflight' })
  })

  it('creates the destination directory if it does not exist yet', async () => {
    const writer = new DebouncedWriter(10)
    const filePath = join(dir, 'nested', 'deep', 'a.json')
    writer.write(filePath, { value: 1 })

    expect(await readWhenWritten(filePath)).toEqual({ value: 1 })
  })

  it('drops a failed write instead of throwing out of flush', () => {
    // A regular file where a directory is expected makes mkdir fail.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const filePath = join(blocker, 'a.json')
    const writer = new DebouncedWriter(10_000)

    writer.write(filePath, { value: 1 })

    expect(() => writer.flush()).not.toThrow()
    expect(existsSync(filePath)).toBe(false)
  })
})
