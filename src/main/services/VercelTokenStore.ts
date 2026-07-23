import type { VercelAuthState } from '@shared/domain'
import type { SecretCipher } from './SecretFileStore'
import { SecretFileStore } from './SecretFileStore'

/**
 * Stores the Vercel access token used to poll deployment pipelines and fetch
 * their build logs, encrypted with the OS credential vault (mirrors
 * TokenStore for GitHub). Unlike GitHub, Vercel has no CLI-import path, so
 * the auth state is just configured/not.
 */
export class VercelTokenStore {
  private readonly secret: SecretFileStore

  constructor(userDataDir: string, cipher: SecretCipher) {
    this.secret = new SecretFileStore(userDataDir, 'vercel-token.bin', cipher)
  }

  getAuthState(): VercelAuthState {
    return { configured: this.getToken() !== null }
  }

  getToken(): string | null {
    return this.secret.get()
  }

  setToken(token: string): void {
    this.secret.set(token)
  }

  clearToken(): void {
    this.secret.clear()
  }
}
