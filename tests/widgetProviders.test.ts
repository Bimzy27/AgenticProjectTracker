import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'
import type { GithubClient } from '../src/main/services/GithubClient'
import {
  GithubReleasesProvider,
  GithubRepoStatsProvider,
  GithubTrafficProvider,
  compactCount
} from '../src/main/services/GithubWidgetProviders'
import { JsonMetricProvider } from '../src/main/services/JsonMetricProvider'
import type { FetchFn } from '../src/main/services/JsonMetricProvider'
import { VercelAnalyticsProvider } from '../src/main/services/VercelAnalyticsProvider'

const project: Project = {
  id: 'p1',
  name: 'Demo',
  path: 'C:/demo',
  tags: [],
  github: { owner: 'me', repo: 'demo' },
  links: [],
  looping: false,
  agentTaskCreation: false,
  createdAt: '2026-07-01T00:00:00Z'
}

function githubWith(get: ReturnType<typeof vi.fn>): GithubClient {
  return { get } as never
}

describe('GithubTrafficProvider', () => {
  it('maps traffic points to a timeseries with unique-visitor details', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ views: [{ timestamp: '2026-07-01T00:00:00Z', count: 10, uniques: 3 }] })
    const data = await new GithubTrafficProvider(githubWith(get), 'views').fetch({
      project,
      config: {}
    })
    expect(data).toEqual({
      shape: 'timeseries',
      unit: 'views',
      points: [{ date: '2026-07-01T00:00:00Z', value: 10, details: ['3 unique'] }]
    })
    expect(get).toHaveBeenCalledWith('/repos/{owner}/{repo}/traffic/views', {
      owner: 'me',
      repo: 'demo'
    })
  })

  it('reads the clones series for the clones widget', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ clones: [{ timestamp: '2026-07-01T00:00:00Z', count: 2, uniques: 1 }] })
    const data = await new GithubTrafficProvider(githubWith(get), 'clones').fetch({
      project,
      config: {}
    })
    expect(data).toMatchObject({ shape: 'timeseries', unit: 'clones' })
  })

  it('reports permission-denied traffic as unavailable in-band', async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    const data = await new GithubTrafficProvider(githubWith(get), 'views').fetch({
      project,
      config: {}
    })
    expect(data).toMatchObject({ shape: 'unavailable', reason: expect.stringContaining('push access') })
  })

  it('propagates unexpected errors', async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }))
    await expect(
      new GithubTrafficProvider(githubWith(get), 'views').fetch({ project, config: {} })
    ).rejects.toThrow('server error')
  })
})

describe('GithubReleasesProvider', () => {
  it('maps releases with assets and download counts', async () => {
    const get = vi.fn().mockResolvedValue([
      {
        tag_name: 'v1.0.0',
        name: 'First release',
        published_at: '2026-06-01T00:00:00Z',
        body: 'Notes here',
        html_url: 'https://github.com/me/demo/releases/v1.0.0',
        assets: [{ name: 'app.exe', download_count: 42, size: 1024 }]
      }
    ])
    const data = await new GithubReleasesProvider(githubWith(get)).fetch({ project, config: {} })
    expect(data).toMatchObject({
      shape: 'releases',
      releases: [
        {
          tag: 'v1.0.0',
          name: 'First release',
          assets: [{ name: 'app.exe', downloadCount: 42, sizeBytes: 1024 }]
        }
      ]
    })
  })
})

describe('GithubRepoStatsProvider', () => {
  it('maps repo counters to compact stat tiles', async () => {
    const get = vi.fn().mockResolvedValue({
      stargazers_count: 12_400,
      forks_count: 7,
      open_issues_count: 950,
      subscribers_count: 1_200_000
    })
    const data = await new GithubRepoStatsProvider(githubWith(get)).fetch({ project, config: {} })
    expect(data).toEqual({
      shape: 'stat',
      stats: [
        { label: 'Stars', value: '12.4k' },
        { label: 'Forks', value: '7' },
        { label: 'Watchers', value: '1.2M' },
        { label: 'Open issues', value: '950' }
      ]
    })
  })

  it('compactCount trims trailing zero decimals', () => {
    expect(compactCount(2000)).toBe('2k')
    expect(compactCount(999)).toBe('999')
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

describe('JsonMetricProvider', () => {
  it('renders a number at the configured path as a stat', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { visitors: 1234 } }))
    const provider = new JsonMetricProvider(fetchFn)
    const data = await provider.fetch({
      project,
      config: { url: 'https://api.example.com/stats', path: 'data.visitors', unit: 'visitors' }
    })
    expect(data).toEqual({ shape: 'stat', stats: [{ label: 'visitors', value: '1,234' }] })
  })

  it('renders an array of dated objects as a timeseries with custom field names', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        series: [{ day: '2026-07-01', total: 5 }, { day: '2026-07-02', total: '7' }, { odd: true }]
      })
    )
    const data = await new JsonMetricProvider(fetchFn).fetch({
      project,
      config: {
        url: 'https://api.example.com/series',
        path: 'series',
        unit: 'views',
        dateField: 'day',
        valueField: 'total'
      }
    })
    expect(data).toEqual({
      shape: 'timeseries',
      unit: 'views',
      points: [
        { date: '2026-07-01', value: 5, details: [] },
        { date: '2026-07-02', value: 7, details: [] }
      ]
    })
  })

  it('sends the configured bearer token as an Authorization header', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(42))
    await new JsonMetricProvider(fetchFn).fetch({
      project,
      config: { url: 'https://api.example.com/n', token: 'secret-token' }
    })
    expect(fetchFn).toHaveBeenCalledWith('https://api.example.com/n', {
      headers: { accept: 'application/json', authorization: 'Bearer secret-token' }
    })
  })

  it('reports auth rejections in-band and other HTTP failures as errors', async () => {
    const provider = new JsonMetricProvider(vi.fn().mockResolvedValue(jsonResponse({}, 401)))
    await expect(
      provider.fetch({ project, config: { url: 'https://api.example.com/x' } })
    ).resolves.toMatchObject({ shape: 'unavailable', reason: expect.stringContaining('401') })

    const failing = new JsonMetricProvider(vi.fn().mockResolvedValue(jsonResponse({}, 500)))
    await expect(failing.fetch({ project, config: { url: 'https://api.example.com/x' } })).rejects.toThrow(
      'HTTP 500'
    )
  })

  it('rejects non-http URLs and unusable paths or values', async () => {
    const provider = new JsonMetricProvider(vi.fn().mockResolvedValue(jsonResponse({ a: 'text' })))
    await expect(provider.fetch({ project, config: { url: 'file:///etc/passwd' } })).rejects.toThrow(
      /must start with http/
    )
    await expect(provider.fetch({ project, config: { url: 'https://x.test', path: 'a.b' } })).rejects.toThrow(
      /nothing at "a.b"/
    )
    await expect(provider.fetch({ project, config: { url: 'https://x.test', path: 'a' } })).rejects.toThrow(
      /not a number or an array/
    )
  })

  it('flags an array whose entries match neither field name', async () => {
    const provider = new JsonMetricProvider(
      vi.fn().mockResolvedValue(jsonResponse([{ when: '2026-07-01', hits: 3 }]))
    )
    await expect(provider.fetch({ project, config: { url: 'https://x.test' } })).rejects.toThrow(
      /check the date and value field names/
    )
  })
})

describe('VercelAnalyticsProvider', () => {
  const NOW = () => new Date('2026-07-20T12:00:00Z')

  function vercelProvider(fetchFn: FetchFn): VercelAnalyticsProvider {
    return new VercelAnalyticsProvider({ fetchFn, now: NOW })
  }

  it('asks the user only for a project and an encrypted token', () => {
    const fields = new VercelAnalyticsProvider().descriptor.configFields
    expect(fields.map((f) => f.key)).toEqual(['projectId', 'token'])
    expect(fields.every((f) => f.required)).toBe(true)
    expect(fields.find((f) => f.key === 'token')?.type).toBe('secret')
  })

  it('queries the visits aggregate endpoint with bearer auth and a 30-day daily window', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ version: 1, data: [] }))
    await vercelProvider(fetchFn).fetch({
      project,
      config: { projectId: 'prj_123', token: 'vercel-token' }
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.vercel.com/v1/query/web-analytics/visits/aggregate?projectId=prj_123&by=day&since=2026-06-21&until=2026-07-20',
      { headers: { accept: 'application/json', authorization: 'Bearer vercel-token' } }
    )
  })

  it('honors an overridden API base (the APT_VERCEL_API seam)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ version: 1, data: [] }))
    await new VercelAnalyticsProvider({ fetchFn, now: NOW, apiBase: 'http://127.0.0.1:9' }).fetch({
      project,
      config: { projectId: 'prj_123', token: 't' }
    })
    expect(fetchFn.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:9\/v1\/query/)
  })

  it('maps aggregate rows to a timeseries with unique-visitor details, skipping unusable rows', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        version: 1,
        data: [
          { timestamp: '2026-07-18T00:00:00.000Z', pageviews: 220, visitors: 180 },
          { timestamp: '2026-07-19T00:00:00.000Z', pageviews: 245 },
          { timestamp: '', pageviews: 9, visitors: 9 },
          { pageviews: 3 },
          { timestamp: '2026-07-20T00:00:00.000Z', pageviews: 'many' },
          'not-a-row'
        ]
      })
    )
    const data = await vercelProvider(fetchFn).fetch({
      project,
      config: { projectId: 'prj_123', token: 't' }
    })
    expect(data).toEqual({
      shape: 'timeseries',
      unit: 'views',
      points: [
        { date: '2026-07-18T00:00:00.000Z', value: 220, details: ['180 unique'] },
        { date: '2026-07-19T00:00:00.000Z', value: 245, details: [] }
      ]
    })
  })

  it('renders an empty chart when the response carries no data array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ version: 1 }))
    const data = await vercelProvider(fetchFn).fetch({
      project,
      config: { projectId: 'prj_123', token: 't' }
    })
    expect(data).toEqual({ shape: 'timeseries', unit: 'views', points: [] })
  })

  it('reports auth rejections in-band with team-scope guidance', async () => {
    for (const status of [401, 403]) {
      const provider = vercelProvider(vi.fn().mockResolvedValue(jsonResponse({}, status)))
      await expect(
        provider.fetch({ project, config: { projectId: 'prj_123', token: 'bad' } })
      ).resolves.toMatchObject({
        shape: 'unavailable',
        reason: expect.stringContaining(`HTTP ${status}`)
      })
    }
  })

  it('reports an unresolvable project in-band and other HTTP failures as errors', async () => {
    const badProject = vercelProvider(vi.fn().mockResolvedValue(jsonResponse({}, 400)))
    await expect(
      badProject.fetch({ project, config: { projectId: 'nope', token: 't' } })
    ).resolves.toMatchObject({ shape: 'unavailable', reason: expect.stringContaining('HTTP 400') })

    const failing = vercelProvider(vi.fn().mockResolvedValue(jsonResponse({}, 500)))
    await expect(failing.fetch({ project, config: { projectId: 'prj_123', token: 't' } })).rejects.toThrow(
      'HTTP 500'
    )
  })

  it('degrades in-band when a stored widget lost its project or token', async () => {
    const fetchFn = vi.fn()
    const data = await vercelProvider(fetchFn).fetch({ project, config: { projectId: '  ' } })
    expect(data).toMatchObject({ shape: 'unavailable', reason: expect.stringContaining('Configure') })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
