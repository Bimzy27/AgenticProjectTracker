import { describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { TerminalService } from '../src/main/services/TerminalService'
import type {
  SpawnPty,
  TerminalEventSink,
  TerminalServiceOptions
} from '../src/main/services/TerminalService'

class FakePty {
  written: string[] = []
  resized: Array<{ cols: number; rows: number }> = []
  killed = 0
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(e: { exitCode: number }) => void> = []

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }
  ) {}

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.push(listener)
    return { dispose: () => {} }
  }

  onExit(listener: (e: { exitCode: number }) => void): { dispose: () => void } {
    this.exitListeners.push(listener)
    return { dispose: () => {} }
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows })
  }

  kill(): void {
    this.killed++
  }

  emitData(chunk: string): void {
    this.dataListeners.forEach((l) => l(chunk))
  }

  emitExit(exitCode: number): void {
    this.exitListeners.forEach((l) => l({ exitCode }))
  }
}

function makeService(options: TerminalServiceOptions = {}): {
  service: TerminalService
  sink: TerminalEventSink
  ptys: FakePty[]
} {
  const ptys: FakePty[] = []
  const spawnPty: SpawnPty = (file, args, opts) => {
    const pty = new FakePty(file, args, opts)
    ptys.push(pty)
    return pty as unknown as IPty
  }
  const sink: TerminalEventSink = { terminalData: vi.fn(), terminalExit: vi.fn() }
  const service = new TerminalService(sink, {
    spawnPty,
    env: { PATH: '' },
    platform: 'win32',
    fileExists: () => false,
    ...options
  })
  return { service, sink, ptys }
}

describe('TerminalService', () => {
  it('spawns a shell in the given cwd/size and returns a live snapshot', () => {
    const { service, ptys } = makeService()
    const snapshot = service.create('proj-1', 'C:\\repos\\demo', 80, 24)
    expect(ptys).toHaveLength(1)
    expect(ptys[0].options).toEqual({ cwd: 'C:\\repos\\demo', cols: 80, rows: 24, env: { PATH: '' } })
    expect(snapshot).toMatchObject({
      projectId: 'proj-1',
      title: 'Terminal 1',
      alive: true,
      exitCode: null,
      buffer: ''
    })
  })

  it('auto-numbers titles per project, restarting for a different project', () => {
    const { service } = makeService()
    expect(service.create('proj-1', 'C:\\a', 80, 24).title).toBe('Terminal 1')
    expect(service.create('proj-1', 'C:\\a', 80, 24).title).toBe('Terminal 2')
    expect(service.create('proj-2', 'C:\\b', 80, 24).title).toBe('Terminal 1')
  })

  it('falls back to the fully-qualified Windows PowerShell path when pwsh.exe is not on PATH', () => {
    const { service, ptys } = makeService({ env: { PATH: 'C:\\nowhere' }, fileExists: () => false })
    service.create('proj-1', 'C:\\a', 80, 24)
    expect(ptys[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('prefers pwsh.exe when found on PATH', () => {
    const { service, ptys } = makeService({
      env: { PATH: 'C:\\tools' },
      fileExists: (p) => p === 'C:\\tools\\pwsh.exe'
    })
    service.create('proj-1', 'C:\\a', 80, 24)
    expect(ptys[0].file).toBe('C:\\tools\\pwsh.exe')
  })

  it('uses the login shell on non-Windows platforms', () => {
    const { service, ptys } = makeService({ platform: 'linux', env: { SHELL: '/bin/zsh' } })
    service.create('proj-1', 'C:\\a', 80, 24)
    expect(ptys[0].file).toBe('/bin/zsh')
  })

  it('spawns the APT_TEST_SHELL script through a real node.exe instead of detecting a shell', () => {
    const { service, ptys } = makeService({
      testShellScript: 'C:\\fixtures\\fakeShell.mjs',
      env: { PATH: 'C:\\nodejs' },
      fileExists: (p) => p === 'C:\\nodejs\\node.exe'
    })
    service.create('proj-1', 'C:\\a', 80, 24)
    expect(ptys[0].file).toBe('C:\\nodejs\\node.exe')
    expect(ptys[0].args).toEqual(['C:\\fixtures\\fakeShell.mjs'])
  })

  it('throws if the APT_TEST_SHELL seam is set but no node.exe is found on PATH', () => {
    const { service } = makeService({
      testShellScript: 'C:\\fixtures\\fakeShell.mjs',
      fileExists: () => false
    })
    expect(() => service.create('proj-1', 'C:\\a', 80, 24)).toThrow(/node.exe/)
  })

  it('streams pty output into the sink and the buffered snapshot', () => {
    const { service, sink, ptys } = makeService()
    const snapshot = service.create('proj-1', 'C:\\a', 80, 24)
    ptys[0].emitData('hello ')
    ptys[0].emitData('world')
    // Each chunk carries the running emitted-character count, which a pane uses
    // to drop chunks its replayed buffer already covered.
    expect(sink.terminalData).toHaveBeenNthCalledWith(1, snapshot.id, 'hello ', 6)
    expect(sink.terminalData).toHaveBeenNthCalledWith(2, snapshot.id, 'world', 11)
    expect(service.list('proj-1')[0].buffer).toBe('hello world')
    expect(service.list('proj-1')[0].bufferEndOffset).toBe(11)
  })

  it('keeps the emitted-character count monotonic when scrollback is trimmed', () => {
    const { service, ptys } = makeService()
    service.create('proj-1', 'C:\\a', 80, 24)
    // Well past the 200k cap, so the buffer is trimmed from the front.
    ptys[0].emitData('x'.repeat(250_000))
    const [snapshot] = service.list('proj-1')
    // The buffer is capped, but the offset still counts everything ever emitted;
    // otherwise a pane would replay and then re-apply chunks it already had.
    expect(snapshot.buffer.length).toBeLessThan(250_000)
    expect(snapshot.bufferEndOffset).toBe(250_000)
  })

  it('exposes one terminal with its current buffer, and null once closed', () => {
    const { service, ptys } = makeService()
    const snapshot = service.create('proj-1', 'C:\\a', 80, 24)
    ptys[0].emitData('later output')

    // A pane attaching after the fact must see output produced meanwhile,
    // which the snapshot it was handed at list time would not contain.
    expect(service.get(snapshot.id)?.buffer).toBe('later output')

    service.close(snapshot.id)
    expect(service.get(snapshot.id)).toBeNull()
  })

  it('caps the buffered scrollback so it does not grow without bound', () => {
    const { service, ptys } = makeService()
    const snapshot = service.create('proj-1', 'C:\\a', 80, 24)
    ptys[0].emitData('a'.repeat(150_000))
    ptys[0].emitData('b'.repeat(150_000))
    const buffer = service.list('proj-1').find((t) => t.id === snapshot.id)!.buffer
    expect(buffer.length).toBeLessThanOrEqual(200_000)
    expect(buffer.endsWith('b')).toBe(true)
  })

  it('forwards writes and resizes to the live pty', () => {
    const { service, ptys } = makeService()
    const snapshot = service.create('proj-1', 'C:\\a', 80, 24)
    service.write(snapshot.id, 'ls\r')
    service.resize(snapshot.id, 100, 40)
    expect(ptys[0].written).toEqual(['ls\r'])
    expect(ptys[0].resized).toEqual([{ cols: 100, rows: 40 }])
  })

  it('marks the terminal exited, notifies the sink, and drops further input', () => {
    const { service, sink, ptys } = makeService()
    const snapshot = service.create('proj-1', 'C:\\a', 80, 24)
    ptys[0].emitExit(1)
    expect(sink.terminalExit).toHaveBeenCalledWith(snapshot.id, 1)
    expect(service.list('proj-1')[0]).toMatchObject({ alive: false, exitCode: 1 })

    service.write(snapshot.id, 'ignored')
    service.resize(snapshot.id, 10, 10)
    expect(ptys[0].written).toEqual([])
    expect(ptys[0].resized).toEqual([])
  })

  it('kills a live terminal on close and forgets it', () => {
    const { service, ptys } = makeService()
    const snapshot = service.create('proj-1', 'C:\\a', 80, 24)
    service.close(snapshot.id)
    expect(ptys[0].killed).toBe(1)
    expect(service.list('proj-1')).toEqual([])
  })

  it('does not re-kill an already-exited terminal on close', () => {
    const { service, ptys } = makeService()
    const snapshot = service.create('proj-1', 'C:\\a', 80, 24)
    ptys[0].emitExit(0)
    service.close(snapshot.id)
    expect(ptys[0].killed).toBe(0)
    expect(service.list('proj-1')).toEqual([])
  })

  it('closing an unknown id is a harmless no-op', () => {
    const { service } = makeService()
    expect(() => service.close('does-not-exist')).not.toThrow()
  })

  it("closeAllForProject only kills and forgets that project's terminals", () => {
    const { service, ptys } = makeService()
    const a = service.create('proj-a', 'C:\\a', 80, 24)
    service.create('proj-b', 'C:\\b', 80, 24)
    service.closeAllForProject('proj-a')
    expect(ptys[0].killed).toBe(1)
    expect(ptys[1].killed).toBe(0)
    expect(service.list('proj-a')).toEqual([])
    expect(service.list('proj-b')).toHaveLength(1)
    expect(a.projectId).toBe('proj-a')
  })

  it('closeAll kills and forgets every terminal across every project', () => {
    const { service, ptys } = makeService()
    service.create('proj-a', 'C:\\a', 80, 24)
    service.create('proj-b', 'C:\\b', 80, 24)
    service.closeAll()
    expect(ptys.every((p) => p.killed === 1)).toBe(true)
    expect(service.list('proj-a')).toEqual([])
    expect(service.list('proj-b')).toEqual([])
  })
})
