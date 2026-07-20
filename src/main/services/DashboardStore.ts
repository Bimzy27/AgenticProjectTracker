import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AnalyticsWidget, AnalyticsWidgetInput } from '@shared/domain'
import type { SecretCipher } from './TokenStore'

interface StoredWidget {
  id: string
  kind: string
  title: string | null
  config: Record<string, string>
  /** Secret config values, encrypted with the OS vault and base64-encoded. */
  secrets: Record<string, string>
}

interface DashboardsFile {
  version: 1
  /** Widget layout per project id; a missing entry means "never customized". */
  projects: Record<string, StoredWidget[]>
}

/**
 * JSON-file store for per-project analytics dashboards (the user's widget
 * layout). Loaded into memory on construction; every mutation is written
 * atomically (temp file + rename), like ProjectStore. A missing or corrupt
 * file falls back to "no customizations" so bad data can never block startup.
 *
 * Secret config values (API tokens for widget sources) are encrypted with the
 * injected SecretCipher (Electron safeStorage in production) before touching
 * disk; plaintext secrets are only ever held in memory.
 */
export class DashboardStore {
  private readonly filePath: string
  private projects: Record<string, StoredWidget[]> = {}

  constructor(
    userDataDir: string,
    private readonly cipher: SecretCipher
  ) {
    this.filePath = join(userDataDir, 'dashboards.json')
    this.load()
  }

  /** The project's stored layout, or null when it was never customized. */
  getWidgets(projectId: string): AnalyticsWidget[] | null {
    const stored = this.projects[projectId]
    return stored ? stored.map(toPublic) : null
  }

  /**
   * Replace the project's layout (full-list semantics). Widgets that carry the
   * id of an existing widget keep its stored secrets; each input's `secrets`
   * map then overrides per key (empty string clears, absent key keeps).
   * Storing a new secret requires the OS cipher to be available.
   */
  setWidgets(projectId: string, inputs: AnalyticsWidgetInput[]): AnalyticsWidget[] {
    const existing = new Map((this.projects[projectId] ?? []).map((w) => [w.id, w]))
    const next = inputs.map((input): StoredWidget => {
      const previous = input.id !== undefined ? existing.get(input.id) : undefined
      const secrets = { ...(previous?.secrets ?? {}) }
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        if (value === '') {
          delete secrets[key]
          continue
        }
        if (!this.cipher.isAvailable()) {
          throw new Error('OS credential encryption is unavailable; refusing to store the secret')
        }
        secrets[key] = this.cipher.encrypt(value).toString('base64')
      }
      return {
        id: input.id ?? randomUUID(),
        kind: input.kind,
        title: input.title,
        config: { ...input.config },
        secrets
      }
    })
    this.projects[projectId] = next
    this.save()
    return next.map(toPublic)
  }

  /**
   * Decrypted secret values of one widget, for provider fetches. A value that
   * no longer decrypts (e.g. the OS vault key changed) is skipped so one stale
   * secret cannot break the whole dashboard; the widget then behaves as if the
   * secret was never set.
   */
  getSecrets(projectId: string, widgetId: string): Record<string, string> {
    const widget = (this.projects[projectId] ?? []).find((w) => w.id === widgetId)
    if (!widget) return {}
    const decrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(widget.secrets)) {
      try {
        decrypted[key] = this.cipher.decrypt(Buffer.from(value, 'base64'))
      } catch {
        // Stale/undecryptable secret: treat as unset (see doc comment).
      }
    }
    return decrypted
  }

  /** Drop a removed project's layout so the file does not accumulate orphans. */
  deleteProject(projectId: string): void {
    if (!(projectId in this.projects)) return
    delete this.projects[projectId]
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
    const projects = (parsed as Partial<DashboardsFile> | null)?.projects
    if (typeof projects !== 'object' || projects === null) return
    for (const [projectId, widgets] of Object.entries(projects)) {
      if (Array.isArray(widgets)) this.projects[projectId] = widgets.filter(isStoredWidget)
    }
  }

  private save(): void {
    const file: DashboardsFile = { version: 1, projects: this.projects }
    const tmpPath = this.filePath + '.tmp'
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmpPath, this.filePath)
  }
}

function toPublic(widget: StoredWidget): AnalyticsWidget {
  return {
    id: widget.id,
    kind: widget.kind,
    title: widget.title,
    config: { ...widget.config },
    secretsSet: Object.keys(widget.secrets)
  }
}

/** Tolerant shape check so one malformed entry cannot break the whole file. */
function isStoredWidget(value: unknown): value is StoredWidget {
  const w = value as Partial<StoredWidget> | null
  return (
    typeof w === 'object' &&
    w !== null &&
    typeof w.id === 'string' &&
    typeof w.kind === 'string' &&
    (w.title === null || typeof w.title === 'string') &&
    typeof w.config === 'object' &&
    w.config !== null &&
    typeof w.secrets === 'object' &&
    w.secrets !== null
  )
}
