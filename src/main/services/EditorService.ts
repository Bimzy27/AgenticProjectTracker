import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { EditorLaunchResult } from '@shared/domain'

/** How to start an editor process. `shell` is true for cmd scripts (.cmd/.bat), which Windows cannot spawn directly. */
export interface LaunchSpec {
  command: string
  shell: boolean
}

/** Start a program detached from the app; rejects when the process cannot start. */
export type LaunchFn = (command: string, args: string[], useShell: boolean) => Promise<void>

export interface EditorServiceDeps {
  /**
   * Native "VS Code is missing, choose another program" prompt, injected by
   * the composition root (dialogs are Electron-only). Returns the chosen
   * executable path, or null when the user dismisses the prompt.
   */
  pickFallbackProgram: (repoRoot: string) => Promise<string | null>
  /** Treat this executable as VS Code instead of detecting one (APT_TEST_EDITOR_CMD seam). */
  vsCodeCommand?: string
  /** Seams for tests; every one defaults to the real environment. */
  launch?: LaunchFn
  fileExists?: (path: string) => boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/**
 * Opens a project directory in VS Code, falling back to a user-picked program
 * when VS Code is not installed. Detection checks the platform's conventional
 * install locations first, then scans PATH.
 */
export class EditorService {
  private readonly pickFallbackProgram: (repoRoot: string) => Promise<string | null>
  private readonly vsCodeCommand: string | undefined
  private readonly launch: LaunchFn
  private readonly fileExists: (path: string) => boolean
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform

  constructor(deps: EditorServiceDeps) {
    this.pickFallbackProgram = deps.pickFallbackProgram
    this.vsCodeCommand = deps.vsCodeCommand
    this.launch = deps.launch ?? spawnDetached
    this.fileExists = deps.fileExists ?? existsSync
    this.env = deps.env ?? process.env
    this.platform = deps.platform ?? process.platform
  }

  /** Path semantics matching the (injectable) platform, so tests behave the same on any host OS. */
  private get path(): typeof win32 {
    return this.platform === 'win32' ? win32 : posix
  }

  /** Open `repoRoot` in VS Code, or via the fallback prompt when VS Code is unavailable. */
  async openProject(repoRoot: string): Promise<EditorLaunchResult> {
    const vscode = this.findVsCode()
    if (vscode) {
      try {
        await this.launch(vscode.command, [repoRoot], vscode.shell)
        return 'vscode'
      } catch {
        // Found on disk but failed to start (corrupt install, permissions);
        // treat it the same as not installed and offer the fallback picker.
      }
    }
    const program = await this.pickFallbackProgram(repoRoot)
    if (!program) return 'cancelled'
    await this.launch(program, [repoRoot], isCmdScript(program))
    return 'other'
  }

  /** Locate a VS Code executable, or null when none is installed. */
  private findVsCode(): LaunchSpec | null {
    if (this.vsCodeCommand) {
      return { command: this.vsCodeCommand, shell: isCmdScript(this.vsCodeCommand) }
    }
    for (const candidate of this.installCandidates()) {
      if (this.fileExists(candidate)) return { command: candidate, shell: false }
    }
    return this.findVsCodeOnPath()
  }

  /** Conventional per-platform install locations, checked before PATH. */
  private installCandidates(): string[] {
    if (this.platform === 'win32') {
      const roots = [this.env.LOCALAPPDATA && this.path.join(this.env.LOCALAPPDATA, 'Programs')]
      for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
        const value = this.env[key]
        if (value) roots.push(value)
      }
      return roots
        .filter((root): root is string => Boolean(root))
        .map((root) => this.path.join(root, 'Microsoft VS Code', 'Code.exe'))
    }
    if (this.platform === 'darwin') {
      return [
        '/usr/local/bin/code',
        '/opt/homebrew/bin/code',
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
      ]
    }
    return ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code']
  }

  private findVsCodeOnPath(): LaunchSpec | null {
    const names = this.platform === 'win32' ? ['code.cmd', 'code.exe'] : ['code']
    const dirs = (this.env.PATH ?? '').split(this.path.delimiter).filter(Boolean)
    for (const dir of dirs) {
      for (const name of names) {
        const found = this.path.join(dir, name)
        if (!this.fileExists(found)) continue
        // <install>\bin\code.cmd sits under <install>\Code.exe; prefer the
        // exe because a .cmd needs a shell (and its quoting pitfalls) to run.
        if (isCmdScript(found)) {
          const exe = this.path.join(found, '..', '..', 'Code.exe')
          if (this.fileExists(exe)) return { command: exe, shell: false }
        }
        return { command: found, shell: isCmdScript(found) }
      }
    }
    return null
  }
}

function isCmdScript(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command)
}

/**
 * Production LaunchFn: start the program detached so it outlives the tracker.
 * cmd scripts run through the shell as a single pre-quoted line because
 * Node refuses to spawn .cmd/.bat directly and does not quote shell args.
 */
export const spawnDetached: LaunchFn = (command, args, useShell) =>
  new Promise((resolve, reject) => {
    const child = useShell
      ? spawn([command, ...args].map((part) => `"${part}"`).join(' '), {
          shell: true,
          detached: true,
          stdio: 'ignore'
        })
      : spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
