import { describe, expect, it, vi } from 'vitest'
import { GithubMetricsProvider } from '../src/main/services/AnalyticsService'

const REPO = { owner: 'me', repo: 'demo' }

function providerWith(get: ReturnType<typeof vi.fn>): GithubMetricsProvider {
  return new GithubMetricsProvider({ get } as never)
}

describe('GithubMetricsProvider', () => {
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
    const releases = await providerWith(get).getReleases(REPO)
    expect(releases).toHaveLength(1)
    expect(releases[0]).toMatchObject({
      tag: 'v1.0.0',
      name: 'First release',
      assets: [{ name: 'app.exe', downloadCount: 42, sizeBytes: 1024 }]
    })
  })

  it('returns traffic points when the token has access', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ views: [{ timestamp: '2026-07-01T00:00:00Z', count: 10, uniques: 3 }] })
      .mockResolvedValueOnce({ clones: [{ timestamp: '2026-07-01T00:00:00Z', count: 2, uniques: 1 }] })
    const traffic = await providerWith(get).getTraffic(REPO)
    expect(traffic.available).toBe(true)
    expect(traffic.views).toEqual([{ date: '2026-07-01T00:00:00Z', count: 10, uniques: 3 }])
    expect(traffic.clones[0].count).toBe(2)
  })

  it('marks traffic unavailable when both endpoints are permission-denied', async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    const traffic = await providerWith(get).getTraffic(REPO)
    expect(traffic).toEqual({ available: false, views: [], clones: [] })
  })

  it('keeps partial data when only one endpoint is denied', async () => {
    const get = vi
      .fn()
      .mockImplementation((route: string) =>
        route.includes('views')
          ? Promise.resolve({ views: [{ timestamp: '2026-07-01T00:00:00Z', count: 5, uniques: 2 }] })
          : Promise.reject(Object.assign(new Error('forbidden'), { status: 403 }))
      )
    const traffic = await providerWith(get).getTraffic(REPO)
    expect(traffic.available).toBe(true)
    expect(traffic.views).toHaveLength(1)
    expect(traffic.clones).toEqual([])
  })

  it('propagates unexpected errors', async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }))
    await expect(providerWith(get).getTraffic(REPO)).rejects.toThrow('server error')
  })
})
