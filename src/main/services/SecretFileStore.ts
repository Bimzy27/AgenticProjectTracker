import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Abstraction over Electron's safeStorage so callers stay testable and
 * Electron-free (D2). The composition root injects the real implementation.
 */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plainText: string): Buffer
  decrypt(encrypted: Buffer): string
}

/**
 * Stores a single secret (e.g. an API token) encrypted with the OS
 * credential vault at `<userDataDir>/<fileName>`; the secret never touches
 * disk in plain text. Shared by TokenStore (GitHub) and VercelTokenStore so
 * every credential-storing service gets the same encrypted-file behaviour.
 */
export class SecretFileStore {
  private readonly path: string

  constructor(
    userDataDir: string,
    fileName: string,
    private readonly cipher: SecretCipher
  ) {
    this.path = join(userDataDir, fileName)
  }

  has(): boolean {
    return existsSync(this.path)
  }

  get(): string | null {
    if (!existsSync(this.path)) return null
    try {
      return this.cipher.decrypt(readFileSync(this.path))
    } catch {
      // A corrupted file or a cipher that can no longer decrypt it (e.g. a
      // different OS user account) must not crash the caller; treat it as absent.
      return null
    }
  }

  set(value: string): void {
    const trimmed = value.trim()
    if (!trimmed) throw new Error('Token is empty')
    if (!this.cipher.isAvailable()) {
      throw new Error('OS credential encryption is unavailable; refusing to store the token')
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, this.cipher.encrypt(trimmed))
  }

  clear(): void {
    rmSync(this.path, { force: true })
  }
}
