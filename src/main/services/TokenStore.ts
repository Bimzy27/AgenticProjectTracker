import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { GithubAuthState } from '@shared/domain'

const execFileAsync = promisify(execFile)

/**
 * Abstraction over Electron's safeStorage so this service stays testable and
 * Electron-free (D2). The composition root injects the real implementation.
 */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plainText: string): Buffer
  decrypt(encrypted: Buffer): string
}

/**
 * Stores the GitHub PAT encrypted with the OS credential vault (D5).
 * The token never touches disk in plain text.
 */
export class TokenStore {
  private readonly tokenPath: string
  private source: GithubAuthState['source'] = null

  constructor(
    userDataDir: string,
    private readonly cipher: SecretCipher
  ) {
    this.tokenPath = join(userDataDir, 'github-token.bin')
    if (existsSync(this.tokenPath)) this.source = 'vault'
  }

  getAuthState(): GithubAuthState {
    return { configured: this.getToken() !== null, source: this.source }
  }

  getToken(): string | null {
    if (!existsSync(this.tokenPath)) return null
    try {
      return this.cipher.decrypt(readFileSync(this.tokenPath))
    } catch {
      return null
    }
  }

  setToken(token: string, source: Exclude<GithubAuthState['source'], null> = 'vault'): void {
    const trimmed = token.trim()
    if (!trimmed) throw new Error('Token is empty')
    if (!this.cipher.isAvailable()) {
      throw new Error('OS credential encryption is unavailable; refusing to store the token')
    }
    mkdirSync(dirname(this.tokenPath), { recursive: true })
    writeFileSync(this.tokenPath, this.cipher.encrypt(trimmed))
    this.source = source
  }

  clearToken(): void {
    rmSync(this.tokenPath, { force: true })
    this.source = null
  }

  /** Import the token the gh CLI already has, if gh is installed and logged in. */
  async importFromGhCli(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000, shell: true })
      const token = stdout.trim()
      if (!token) return false
      this.setToken(token, 'gh-cli')
      return true
    } catch {
      return false
    }
  }
}
