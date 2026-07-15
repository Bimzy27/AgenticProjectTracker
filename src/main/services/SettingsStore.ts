import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { THEME_PREFERENCES } from '@shared/domain'
import type { ThemePreference } from '@shared/domain'

interface SettingsFile {
  version: 1
  theme: ThemePreference
}

/**
 * JSON-file store for app-wide user settings (currently the theme
 * preference). Loaded into memory on construction; every mutation is written
 * atomically (write to a temp file, then rename), like ProjectStore.
 * A missing, corrupt, or unrecognisable file falls back to defaults so bad
 * settings can never block startup.
 */
export class SettingsStore {
  private readonly filePath: string
  private theme: ThemePreference = 'system'

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'settings.json')
    this.load()
  }

  /** The persisted theme preference; 'system' when never set. */
  getTheme(): ThemePreference {
    return this.theme
  }

  /**
   * Persist a new theme preference. Values outside ThemePreference are
   * rejected (the value crosses the IPC boundary, so it is untrusted input).
   */
  setTheme(pref: ThemePreference): void {
    if (!THEME_PREFERENCES.includes(pref)) {
      throw new Error(`Unknown theme preference: ${String(pref)}`)
    }
    this.theme = pref
    this.save()
  }

  private load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      // First run (no file yet) or corrupt content: keep the defaults.
      return
    }
    const theme = (parsed as Partial<SettingsFile> | null)?.theme
    if (theme !== undefined && THEME_PREFERENCES.includes(theme)) this.theme = theme
  }

  private save(): void {
    const file: SettingsFile = { version: 1, theme: this.theme }
    const tmpPath = this.filePath + '.tmp'
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmpPath, this.filePath)
  }
}
