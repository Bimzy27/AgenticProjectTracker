import { Octokit } from 'octokit'
import type { RateLimitState } from '@shared/domain'
import type { TokenStore } from './TokenStore'

export interface ConditionalResponse<T> {
  /** null when the server answered 304 Not Modified. */
  data: T | null
  etag: string | null
  notModified: boolean
}

export class GithubNotConfiguredError extends Error {
  constructor() {
    super('No GitHub token configured')
  }
}

/**
 * Thin Octokit wrapper: injects the vault token, supports ETag conditional
 * requests (D5), and tracks rate-limit state from response headers.
 */
export class GithubClient {
  private octokit: Octokit | null = null
  private tokenInUse: string | null = null
  private rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null, low: false }

  constructor(
    private readonly tokens: TokenStore,
    private readonly onRateLimit?: (state: RateLimitState) => void
  ) {}

  isConfigured(): boolean {
    return this.tokens.getToken() !== null
  }

  getRateLimit(): RateLimitState {
    return this.rateLimit
  }

  /** GET with optional If-None-Match. Throws GithubNotConfiguredError without a token. */
  async conditionalGet<T>(
    route: string,
    params: Record<string, unknown>,
    etag: string | null
  ): Promise<ConditionalResponse<T>> {
    const octokit = this.require()
    const headers: Record<string, string> = {}
    if (etag) headers['if-none-match'] = etag
    try {
      const response = await octokit.request(`GET ${route}`, { ...params, headers })
      this.captureRateLimit(response.headers as Record<string, string | undefined>)
      return {
        data: response.data as T,
        etag: (response.headers as Record<string, string | undefined>).etag ?? null,
        notModified: false
      }
    } catch (err) {
      const status = (err as { status?: number }).status
      const responseHeaders = (err as { response?: { headers?: Record<string, string | undefined> } })
        .response?.headers
      if (responseHeaders) this.captureRateLimit(responseHeaders)
      if (status === 304) return { data: null, etag, notModified: true }
      throw err
    }
  }

  async get<T>(route: string, params: Record<string, unknown>): Promise<T> {
    const result = await this.conditionalGet<T>(route, params, null)
    return result.data as T
  }

  private require(): Octokit {
    const token = this.tokens.getToken()
    if (!token) throw new GithubNotConfiguredError()
    if (!this.octokit || this.tokenInUse !== token) {
      this.octokit = new Octokit({ auth: token })
      this.tokenInUse = token
    }
    return this.octokit
  }

  private captureRateLimit(headers: Record<string, string | undefined>): void {
    const limit = intOrNull(headers['x-ratelimit-limit'])
    const remaining = intOrNull(headers['x-ratelimit-remaining'])
    const reset = intOrNull(headers['x-ratelimit-reset'])
    if (remaining === null) return
    this.rateLimit = {
      limit,
      remaining,
      resetAt: reset !== null ? new Date(reset * 1000).toISOString() : null,
      low: remaining < 100
    }
    this.onRateLimit?.(this.rateLimit)
  }
}

function intOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}
