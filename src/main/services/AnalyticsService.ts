import type { GithubRepoRef, ReleaseInfo, TrafficMetrics } from '@shared/domain'
import type { GithubClient } from './GithubClient'

/**
 * Metrics come through a provider interface (D7) so future sources
 * (product analytics, crash reporting) can plug in without UI changes.
 */
export interface MetricsProvider {
  getReleases(repo: GithubRepoRef): Promise<ReleaseInfo[]>
  getTraffic(repo: GithubRepoRef): Promise<TrafficMetrics>
}

interface GithubRelease {
  tag_name: string
  name: string | null
  published_at: string | null
  body: string | null
  html_url: string
  assets: Array<{ name: string; download_count: number; size: number }>
}

interface GithubTraffic {
  views?: Array<{ timestamp: string; count: number; uniques: number }>
  clones?: Array<{ timestamp: string; count: number; uniques: number }>
}

/** The initial and only provider in this change: GitHub releases and traffic. */
export class GithubMetricsProvider implements MetricsProvider {
  constructor(private readonly github: GithubClient) {}

  async getReleases({ owner, repo }: GithubRepoRef): Promise<ReleaseInfo[]> {
    const releases = await this.github.get<GithubRelease[]>('/repos/{owner}/{repo}/releases', {
      owner,
      repo,
      per_page: 50
    })
    return releases.map((r) => ({
      tag: r.tag_name,
      name: r.name,
      publishedAt: r.published_at,
      notes: r.body,
      url: r.html_url,
      assets: r.assets.map((a) => ({ name: a.name, downloadCount: a.download_count, sizeBytes: a.size }))
    }))
  }

  async getTraffic(repoRef: GithubRepoRef): Promise<TrafficMetrics> {
    const [views, clones] = await Promise.all([
      this.trafficEndpoint(repoRef, 'views'),
      this.trafficEndpoint(repoRef, 'clones')
    ])
    if (views === null && clones === null) return { available: false, views: [], clones: [] }
    return { available: true, views: views ?? [], clones: clones ?? [] }
  }

  /** Returns null when the token lacks push access to the repo (403/404). */
  private async trafficEndpoint(
    { owner, repo }: GithubRepoRef,
    kind: 'views' | 'clones'
  ): Promise<TrafficMetrics['views'] | null> {
    try {
      const data = await this.github.get<GithubTraffic>(`/repos/{owner}/{repo}/traffic/${kind}`, {
        owner,
        repo
      })
      const points = (kind === 'views' ? data.views : data.clones) ?? []
      return points.map((p) => ({ date: p.timestamp, count: p.count, uniques: p.uniques }))
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 403 || status === 404) return null
      throw err
    }
  }
}

export class AnalyticsService {
  constructor(private readonly provider: MetricsProvider) {}

  async getReleases(repo: GithubRepoRef): Promise<ReleaseInfo[]> {
    return this.provider.getReleases(repo)
  }

  async getTraffic(repo: GithubRepoRef): Promise<TrafficMetrics> {
    return this.provider.getTraffic(repo)
  }
}
