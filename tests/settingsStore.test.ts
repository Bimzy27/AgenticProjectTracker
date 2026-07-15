import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThemePreference } from '../src/shared/domain'
import { SettingsStore } from '../src/main/services/SettingsStore'

describe('SettingsStore', () => {
  let dir: string
  let store: SettingsStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apt-settings-'))
    store = new SettingsStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults the theme to system on first run', () => {
    expect(store.getTheme()).toBe('system')
  })

  it('persists the theme across instances', () => {
    store.setTheme('dark')
    expect(new SettingsStore(dir).getTheme()).toBe('dark')
    store.setTheme('light')
    expect(new SettingsStore(dir).getTheme()).toBe('light')
  })

  it('writes a versioned settings file', () => {
    store.setTheme('dark')
    const file = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(file).toEqual({ version: 1, theme: 'dark' })
  })

  it('rejects unknown theme values (untrusted IPC input)', () => {
    expect(() => store.setTheme('neon' as ThemePreference)).toThrow(/Unknown theme preference/)
    expect(store.getTheme()).toBe('system')
  })

  it('falls back to defaults when the file is corrupt', () => {
    writeFileSync(join(dir, 'settings.json'), '{not json')
    expect(new SettingsStore(dir).getTheme()).toBe('system')
  })

  it('falls back to defaults when the stored theme is unrecognisable', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, theme: 'neon' }))
    expect(new SettingsStore(dir).getTheme()).toBe('system')
  })
})
