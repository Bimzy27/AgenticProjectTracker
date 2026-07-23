import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GithubAuthState } from '@shared/domain'
import type { SecretCipher } from './SecretFileStore'
import { SecretFileStore } from './SecretFileStore'

const execFileAsync = promisify(execFile)

export type { SecretCipher }

/**
 * Stores the GitHub PAT encrypted with the OS credential vault (D5).
 * The token never touches disk in plain text.
 */
export class TokenStore {
  private readonly secret: SecretFileStore
  private source: GithubAuthState['source'] = null

  constructor(userDataDir: string, cipher: SecretCipher) {
    this.secret = new SecretFileStore(userDataDir, 'github-token.bin', cipher)
    if (this.secret.has()) this.source = 'vault'
  }

  getAuthState(): GithubAuthState {
    return { configured: this.getToken() !== null, source: this.source }
  }

  getToken(): string | null {
    return this.secret.get()
  }

  setToken(token: string, source: Exclude<GithubAuthState['source'], null> = 'vault'): void {
    this.secret.set(token)
    this.source = source
  }

  clearToken(): void {
    this.secret.clear()
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
