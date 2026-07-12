import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageService } from '../src/main/services/UsageService'

const dirs: string[] = []

function makeClaudeHome(credentials?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'apt-usage-'))
  dirs.push(dir)
  if (credentials !== undefined) {
    const content = typeof credentials === 'string' ? credentials : JSON.stringify(credentials)
    writeFileSync(join(dir, '.credentials.json'), content)
  }
  return dir
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const validCredentials = {
  claudeAiOauth: { accessToken: 'test-access-token', subscriptionType: 'pro' }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('UsageService', () => {
  it('reports not-logged-in when the credentials file is missing', async () => {
    const service = new UsageService({ claudeHome: makeClaudeHome(), fetchFn: vi.fn() })
    const usage = await service.getUsage()
    expect(usage.status).toBe('not-logged-in')
    expect(usage.windows).toEqual([])
  })

  it('reports not-logged-in when the credentials file is malformed', async () => {
    const service = new UsageService({
      claudeHome: makeClaudeHome('{not json'),
      fetchFn: vi.fn()
    })
    expect((await service.getUsage()).status).toBe('not-logged-in')
  })

  it('fetches usage with the stored bearer token and parses the limit windows', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, {
        limits: [
          {
            kind: 'session',
            percent: 14,
            severity: 'normal',
            resets_at: '2026-07-12T10:00:00Z',
            scope: null
          },
          {
            kind: 'weekly_scoped',
            percent: 61,
            severity: 'warning',
            resets_at: '2026-07-12T12:00:00Z',
            scope: { model: { id: null, display_name: 'Fable' } }
          },
          { bogus: true },
          'not-an-object'
        ]
      })
    )
    const service = new UsageService({
      claudeHome: makeClaudeHome(validCredentials),
      endpoint: 'https://usage.example/api',
      fetchFn: fetchFn as unknown as typeof fetch
    })

    const usage = await service.getUsage()

    expect(fetchFn).toHaveBeenCalledWith(
      'https://usage.example/api',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' })
      })
    )
    expect(usage.status).toBe('ok')
    expect(usage.subscription).toBe('pro')
    expect(usage.windows).toEqual([
      {
        kind: 'session',
        percent: 14,
        severity: 'normal',
        resetsAt: '2026-07-12T10:00:00Z',
        scope: null
      },
      {
        kind: 'weekly_scoped',
        percent: 61,
        severity: 'warning',
        resetsAt: '2026-07-12T12:00:00Z',
        scope: 'Fable'
      }
    ])
  })

  it('reports an error for a non-200 response without leaking the token', async () => {
    const service = new UsageService({
      claudeHome: makeClaudeHome(validCredentials),
      fetchFn: (async () => jsonResponse(401, {})) as typeof fetch
    })
    const usage = await service.getUsage()
    expect(usage.status).toBe('error')
    expect(usage.error).toBe('Usage API responded with HTTP 401')
    expect(usage.error).not.toContain('test-access-token')
  })

  it('reports an error when the request itself fails', async () => {
    const service = new UsageService({
      claudeHome: makeClaudeHome(validCredentials),
      fetchFn: (async () => {
        throw new Error('offline')
      }) as typeof fetch
    })
    const usage = await service.getUsage()
    expect(usage.status).toBe('error')
    expect(usage.error).toBe('offline')
  })

  it('returns no windows when the response carries no limits array', async () => {
    const service = new UsageService({
      claudeHome: makeClaudeHome(validCredentials),
      fetchFn: (async () => jsonResponse(200, { five_hour: { utilization: 14 } })) as typeof fetch
    })
    const usage = await service.getUsage()
    expect(usage.status).toBe('ok')
    expect(usage.windows).toEqual([])
  })
})
