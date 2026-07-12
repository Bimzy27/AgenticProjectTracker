import { describe, expect, it, vi } from 'vitest'
import { EditorService } from '../src/main/services/EditorService'
import type { EditorServiceDeps } from '../src/main/services/EditorService'

interface Launched {
  command: string
  args: string[]
  shell: boolean
}

function makeService(overrides: Partial<EditorServiceDeps> & { existing?: string[] }): {
  service: EditorService
  launched: Launched[]
  pickFallbackProgram: ReturnType<typeof vi.fn>
} {
  const launched: Launched[] = []
  const existing = new Set(overrides.existing ?? [])
  const pickFallbackProgram = vi.fn(overrides.pickFallbackProgram ?? (async () => null))
  const service = new EditorService({
    pickFallbackProgram,
    vsCodeCommand: overrides.vsCodeCommand,
    launch:
      overrides.launch ??
      (async (command, args, shell) => {
        launched.push({ command, args, shell })
      }),
    fileExists: overrides.fileExists ?? ((path) => existing.has(path)),
    env: overrides.env ?? {},
    platform: overrides.platform ?? 'win32'
  })
  return { service, launched, pickFallbackProgram }
}

describe('EditorService', () => {
  it('opens the repo root with the injected VS Code command (test seam)', async () => {
    const { service, launched, pickFallbackProgram } = makeService({
      vsCodeCommand: 'C:\\tools\\fake-code.exe'
    })
    const result = await service.openProject('C:\\repos\\demo')
    expect(result).toBe('vscode')
    expect(launched).toEqual([
      { command: 'C:\\tools\\fake-code.exe', args: ['C:\\repos\\demo'], shell: false }
    ])
    expect(pickFallbackProgram).not.toHaveBeenCalled()
  })

  it('runs an injected .cmd command through the shell', async () => {
    const { service, launched } = makeService({ vsCodeCommand: 'C:\\tools\\editor.cmd' })
    await service.openProject('C:\\repos\\demo')
    expect(launched[0]).toMatchObject({ command: 'C:\\tools\\editor.cmd', shell: true })
  })

  it('finds Code.exe in the conventional Windows install location', async () => {
    const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    const { service, launched } = makeService({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      existing: [exe]
    })
    expect(await service.openProject('C:\\repos\\demo')).toBe('vscode')
    expect(launched).toEqual([{ command: exe, args: ['C:\\repos\\demo'], shell: false }])
  })

  it('resolves a PATH hit on bin\\code.cmd to the sibling Code.exe', async () => {
    const cmd = 'C:\\VSCode\\bin\\code.cmd'
    const exe = 'C:\\VSCode\\Code.exe'
    const { service, launched } = makeService({
      platform: 'win32',
      env: { PATH: 'C:\\VSCode\\bin' },
      existing: [cmd, exe]
    })
    expect(await service.openProject('C:\\repos\\demo')).toBe('vscode')
    expect(launched).toEqual([{ command: exe, args: ['C:\\repos\\demo'], shell: false }])
  })

  it('finds code on PATH on linux', async () => {
    const code = '/usr/local/other-bin/code'
    const { service, launched } = makeService({
      platform: 'linux',
      env: { PATH: '/usr/local/other-bin' },
      existing: [code]
    })
    expect(await service.openProject('/repos/demo')).toBe('vscode')
    expect(launched).toEqual([{ command: code, args: ['/repos/demo'], shell: false }])
  })

  it('prompts for another program when VS Code is missing and launches the pick', async () => {
    const { service, launched, pickFallbackProgram } = makeService({
      pickFallbackProgram: async () => 'C:\\tools\\notepad++.exe'
    })
    const result = await service.openProject('C:\\repos\\demo')
    expect(result).toBe('other')
    expect(pickFallbackProgram).toHaveBeenCalledWith('C:\\repos\\demo')
    expect(launched).toEqual([
      { command: 'C:\\tools\\notepad++.exe', args: ['C:\\repos\\demo'], shell: false }
    ])
  })

  it('returns cancelled and launches nothing when the fallback prompt is dismissed', async () => {
    const { service, launched } = makeService({})
    expect(await service.openProject('C:\\repos\\demo')).toBe('cancelled')
    expect(launched).toEqual([])
  })

  it('falls back to the prompt when the detected VS Code fails to start', async () => {
    const pickFallbackProgram = vi.fn(async () => 'C:\\tools\\other.exe')
    const launched: Launched[] = []
    const service = new EditorService({
      pickFallbackProgram,
      vsCodeCommand: 'C:\\broken\\Code.exe',
      launch: async (command, args, shell) => {
        if (command === 'C:\\broken\\Code.exe') throw new Error('spawn EACCES')
        launched.push({ command, args, shell })
      },
      fileExists: () => false,
      env: {},
      platform: 'win32'
    })
    expect(await service.openProject('C:\\repos\\demo')).toBe('other')
    expect(pickFallbackProgram).toHaveBeenCalledOnce()
    expect(launched).toEqual([{ command: 'C:\\tools\\other.exe', args: ['C:\\repos\\demo'], shell: false }])
  })
})
