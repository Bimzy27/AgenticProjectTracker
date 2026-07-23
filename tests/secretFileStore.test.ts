import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretCipher } from '../src/main/services/SecretFileStore'
import { SecretFileStore } from '../src/main/services/SecretFileStore'
import { VercelTokenStore } from '../src/main/services/VercelTokenStore'

function cipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (text) => Buffer.from(`enc:${text}`),
    decrypt: (buf) => buf.toString().slice(4)
  }
}

describe('SecretFileStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apt-secret-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('has nothing stored initially, then round-trips a value through the cipher', () => {
    const store = new SecretFileStore(dir, 'secret.bin', cipher())
    expect(store.has()).toBe(false)
    expect(store.get()).toBeNull()
    store.set('my-token')
    expect(store.has()).toBe(true)
    expect(store.get()).toBe('my-token')
  })

  it('trims the value and rejects a blank one', () => {
    const store = new SecretFileStore(dir, 'secret.bin', cipher())
    store.set('  padded  ')
    expect(store.get()).toBe('padded')
    expect(() => store.set('   ')).toThrow(/empty/)
  })

  it('refuses to store when the OS cipher is unavailable', () => {
    const store = new SecretFileStore(dir, 'secret.bin', cipher(false))
    expect(() => store.set('token')).toThrow(/encryption is unavailable/)
    expect(store.has()).toBe(false)
  })

  it('clears the stored value', () => {
    const store = new SecretFileStore(dir, 'secret.bin', cipher())
    store.set('token')
    store.clear()
    expect(store.has()).toBe(false)
    expect(store.get()).toBeNull()
  })

  it('returns null for a corrupt file instead of throwing', () => {
    const store = new SecretFileStore(dir, 'secret.bin', cipher())
    store.set('token')
    const brokenCipher: SecretCipher = {
      isAvailable: () => true,
      encrypt: cipher().encrypt,
      decrypt: () => {
        throw new Error('bad ciphertext')
      }
    }
    const reopened = new SecretFileStore(dir, 'secret.bin', brokenCipher)
    expect(reopened.get()).toBeNull()
  })
})

describe('VercelTokenStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apt-vercel-token-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports not configured until a token is set, then configured', () => {
    const store = new VercelTokenStore(dir, cipher())
    expect(store.getAuthState()).toEqual({ configured: false })
    store.setToken('vercel-token')
    expect(store.getAuthState()).toEqual({ configured: true })
    expect(store.getToken()).toBe('vercel-token')
  })

  it('clears the token', () => {
    const store = new VercelTokenStore(dir, cipher())
    store.setToken('vercel-token')
    store.clearToken()
    expect(store.getAuthState()).toEqual({ configured: false })
    expect(store.getToken()).toBeNull()
  })
})
