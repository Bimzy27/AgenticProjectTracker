import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeUsage, ClaudeUsageWindow } from '@shared/domain'

/** Default endpoint the Claude CLI itself queries for account usage limits. */
const DEFAULT_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

interface UsageServiceOptions {
  /** Claude CLI home directory; defaults to ~/.claude. */
  claudeHome?: string
  /** Usage API endpoint override (APT_USAGE_ENDPOINT test seam). */
  endpoint?: string
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
}

/**
 * Reads the Claude usage budget for the account the Claude CLI is logged in
 * with: the OAuth token is taken from `<claudeHome>/.credentials.json` and the
 * usage limits are fetched from Anthropic's OAuth usage endpoint.
 *
 * Failure modes are reported in-band via `ClaudeUsage.status` instead of
 * throwing, so the About view can always render: missing or unreadable
 * credentials yield "not-logged-in", network/API failures yield "error".
 * The token itself never leaves this service (it is not part of any error).
 */
export class UsageService {
  private readonly claudeHome: string
  private readonly endpoint: string
  private readonly fetchFn: typeof fetch

  constructor(options: UsageServiceOptions = {}) {
    this.claudeHome = options.claudeHome ?? join(homedir(), '.claude')
    this.endpoint = options.endpoint ?? DEFAULT_USAGE_ENDPOINT
    this.fetchFn = options.fetchFn ?? fetch
  }

  async getUsage(): Promise<ClaudeUsage> {
    const fetchedAt = new Date().toISOString()
    const credentials = this.readCredentials()
    if (!credentials) {
      return { status: 'not-logged-in', subscription: null, windows: [], error: null, fetchedAt }
    }
    try {
      const response = await this.fetchFn(this.endpoint, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json'
        }
      })
      if (!response.ok) {
        return {
          status: 'error',
          subscription: credentials.subscription,
          windows: [],
          error: `Usage API responded with HTTP ${response.status}`,
          fetchedAt
        }
      }
      const body: unknown = await response.json()
      return {
        status: 'ok',
        subscription: credentials.subscription,
        windows: parseWindows(body),
        error: null,
        fetchedAt
      }
    } catch (err) {
      return {
        status: 'error',
        subscription: credentials.subscription,
        windows: [],
        error: err instanceof Error ? err.message : String(err),
        fetchedAt
      }
    }
  }

  /** Null when the CLI has no stored OAuth credentials (treated as logged out). */
  private readCredentials(): { accessToken: string; subscription: string | null } | null {
    try {
      const raw = readFileSync(join(this.claudeHome, '.credentials.json'), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
      if (typeof oauth !== 'object' || oauth === null) return null
      const { accessToken, subscriptionType } = oauth as {
        accessToken?: unknown
        subscriptionType?: unknown
      }
      if (typeof accessToken !== 'string' || accessToken.length === 0) return null
      return {
        accessToken,
        subscription: typeof subscriptionType === 'string' ? subscriptionType : null
      }
    } catch {
      // Missing or malformed credentials file simply means "not logged in".
      return null
    }
  }
}

/**
 * Extract the usage windows from the API response's `limits` array.
 * The format is undocumented, so parsing is tolerant: entries that do not
 * carry the expected fields are skipped rather than failing the whole call.
 */
function parseWindows(body: unknown): ClaudeUsageWindow[] {
  const limits = (body as { limits?: unknown }).limits
  if (!Array.isArray(limits)) return []
  const windows: ClaudeUsageWindow[] = []
  for (const entry of limits) {
    if (typeof entry !== 'object' || entry === null) continue
    const { kind, percent, severity, resets_at, scope } = entry as {
      kind?: unknown
      percent?: unknown
      severity?: unknown
      resets_at?: unknown
      scope?: unknown
    }
    if (typeof kind !== 'string' || typeof percent !== 'number') continue
    windows.push({
      kind,
      percent,
      severity: typeof severity === 'string' ? severity : 'normal',
      resetsAt: typeof resets_at === 'string' ? resets_at : null,
      scope: parseScopeName(scope)
    })
  }
  return windows
}

/** Model display name from a limit's scope object, or null for account-wide limits. */
function parseScopeName(scope: unknown): string | null {
  if (typeof scope !== 'object' || scope === null) return null
  const model = (scope as { model?: unknown }).model
  if (typeof model !== 'object' || model === null) return null
  const displayName = (model as { display_name?: unknown }).display_name
  return typeof displayName === 'string' ? displayName : null
}
