import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DebouncedWriter } from '../src/main/services/DebouncedWriter'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
    expect(existsSync(filePath)).toBe(false)

    await wait(100)

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ value: 1 })
  })

  it('coalesces rapid writes to the same path into the last value', async () => {
    const writer = new DebouncedWriter(60)
    const filePath = join(dir, 'a.json')

    writer.write(filePath, { value: 1 })
    await wait(20)
    writer.write(filePath, { value: 2 })
    await wait(20)
    // The first write's timer was cancelled by the second; only 20ms have
    // passed since the second write (window is 60ms), so nothing has landed yet.
    expect(existsSync(filePath)).toBe(false)

    await wait(100)
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ value: 2 })
  })

  it('debounces writes to different paths independently', async () => {
    const writer = new DebouncedWriter(30)
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')

    // Writing to b must not cancel or delay a's already-scheduled write.
    writer.write(a, { value: 'a' })
    writer.write(b, { value: 'b' })
    await wait(150)

    expect(JSON.parse(readFileSync(a, 'utf8'))).toEqual({ value: 'a' })
    expect(JSON.parse(readFileSync(b, 'utf8'))).toEqual({ value: 'b' })
  })

  it('flushAll lands every pending write immediately, without waiting for the debounce window', async () => {
    const writer = new DebouncedWriter(10_000)
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    writer.write(a, { value: 'a' })
    writer.write(b, { value: 'b' })

    await writer.flushAll()

    expect(JSON.parse(readFileSync(a, 'utf8'))).toEqual({ value: 'a' })
    expect(JSON.parse(readFileSync(b, 'utf8'))).toEqual({ value: 'b' })
  })

  it('creates the destination directory if it does not exist yet', async () => {
    const writer = new DebouncedWriter(10)
    const filePath = join(dir, 'nested', 'deep', 'a.json')
    writer.write(filePath, { value: 1 })

    await wait(60)

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ value: 1 })
  })

  it('drops a failed write instead of throwing or rejecting flushAll', async () => {
    // A regular file where a directory is expected makes mkdir fail.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const filePath = join(blocker, 'a.json')
    const writer = new DebouncedWriter(10_000)

    writer.write(filePath, { value: 1 })

    await expect(writer.flushAll()).resolves.toBeUndefined()
    expect(existsSync(filePath)).toBe(false)
  })
})
