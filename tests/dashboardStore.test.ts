import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DashboardStore } from '../src/main/services/DashboardStore'
import type { SecretCipher } from '../src/main/services/TokenStore'

/** Reversible fake cipher that makes ciphertext recognisable in the file. */
const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(`enc:${text}`),
  decrypt: (buf) => {
    const s = buf.toString()
    if (!s.startsWith('enc:')) throw new Error('not encrypted by this cipher')
    return s.slice(4)
  }
}

const unavailableCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('unavailable')
  },
  decrypt: () => {
    throw new Error('unavailable')
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apt-dashboards-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('DashboardStore', () => {
  it('returns null for a project that was never customized', () => {
    const store = new DashboardStore(dir, cipher)
    expect(store.getWidgets('p1')).toBeNull()
  })

  it('persists layouts across instances and assigns ids to new widgets', () => {
    const store = new DashboardStore(dir, cipher)
    const saved = store.setWidgets('p1', [
      { kind: 'json-metric', title: 'Visitors', config: { url: 'https://x.test' } }
    ])
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBeTruthy()
    expect(saved[0]).toMatchObject({
      kind: 'json-metric',
      title: 'Visitors',
      config: { url: 'https://x.test' },
      secretsSet: []
    })

    const reloaded = new DashboardStore(dir, cipher)
    expect(reloaded.getWidgets('p1')).toEqual(saved)
  })

  it('stores secrets encrypted at rest and reports them only as key names', () => {
    const store = new DashboardStore(dir, cipher)
    const [saved] = store.setWidgets('p1', [
      { kind: 'json-metric', title: null, config: {}, secrets: { token: 'hunter2' } }
    ])
    expect(saved.secretsSet).toEqual(['token'])
    expect(JSON.stringify(saved)).not.toContain('hunter2')

    const raw = readFileSync(join(dir, 'dashboards.json'), 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(store.getSecrets('p1', saved.id)).toEqual({ token: 'hunter2' })
  })

  it('keeps a stored secret when the key is omitted and clears it on empty string', () => {
    const store = new DashboardStore(dir, cipher)
    const [saved] = store.setWidgets('p1', [
      { kind: 'json-metric', title: null, config: {}, secrets: { token: 'hunter2' } }
    ])

    const [kept] = store.setWidgets('p1', [
      { id: saved.id, kind: 'json-metric', title: 'Renamed', config: {} }
    ])
    expect(kept.id).toBe(saved.id)
    expect(kept.secretsSet).toEqual(['token'])
    expect(store.getSecrets('p1', saved.id)).toEqual({ token: 'hunter2' })

    const [cleared] = store.setWidgets('p1', [
      { id: saved.id, kind: 'json-metric', title: null, config: {}, secrets: { token: '' } }
    ])
    expect(cleared.secretsSet).toEqual([])
    expect(store.getSecrets('p1', saved.id)).toEqual({})
  })

  it('refuses to store a secret when OS encryption is unavailable', () => {
    const store = new DashboardStore(dir, unavailableCipher)
    expect(() =>
      store.setWidgets('p1', [{ kind: 'json-metric', title: null, config: {}, secrets: { token: 'x' } }])
    ).toThrow(/encryption is unavailable/)
  })

  it('skips secrets that no longer decrypt instead of breaking the dashboard', () => {
    const store = new DashboardStore(dir, cipher)
    const [saved] = store.setWidgets('p1', [
      { kind: 'json-metric', title: null, config: {}, secrets: { token: 'hunter2' } }
    ])
    // Simulate an OS vault key change: same file, cipher that rejects old data.
    const rotated = new DashboardStore(dir, {
      isAvailable: () => true,
      encrypt: (text) => Buffer.from(`new:${text}`),
      decrypt: () => {
        throw new Error('key changed')
      }
    })
    expect(rotated.getSecrets('p1', saved.id)).toEqual({})
    expect(rotated.getWidgets('p1')).toHaveLength(1)
  })

  it('tolerates a corrupt file and malformed entries', () => {
    writeFileSync(join(dir, 'dashboards.json'), 'not json at all')
    expect(new DashboardStore(dir, cipher).getWidgets('p1')).toBeNull()

    writeFileSync(
      join(dir, 'dashboards.json'),
      JSON.stringify({
        version: 1,
        projects: {
          p1: [
            { id: 'ok', kind: 'json-metric', title: null, config: {}, secrets: {} },
            { id: 42, kind: 'broken' },
            'garbage'
          ]
        }
      })
    )
    const store = new DashboardStore(dir, cipher)
    expect(store.getWidgets('p1')).toHaveLength(1)
    expect(store.getWidgets('p1')?.[0].id).toBe('ok')
  })

  it('drops a removed project so the file does not accumulate orphans', () => {
    const store = new DashboardStore(dir, cipher)
    store.setWidgets('p1', [{ kind: 'json-metric', title: null, config: {} }])
    store.deleteProject('p1')
    expect(store.getWidgets('p1')).toBeNull()
    expect(new DashboardStore(dir, cipher).getWidgets('p1')).toBeNull()
  })
})
