import type { GithubRepoRef, Project, WidgetData, WidgetKindDescriptor } from '@shared/domain'
import type { WidgetFetchContext, WidgetProvider } from './AnalyticsService'
import type { GithubClient } from './GithubClient'

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

interface GithubRepo {
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  subscribers_count: number
}

/** The project's linked repo; providers behind requiresGithub never see null. */
function requireRepo(project: Project): GithubRepoRef {
  if (!project.github) throw new Error('Project has no linked GitHub repo')
  return project.github
}

/**
 * Daily repository views or clones from GitHub's traffic API as a timeseries
 * widget. GitHub only retains 14 days; a token without push access gets an
 * in-band 'unavailable' instead of an error.
 */
export class GithubTrafficProvider implements WidgetProvider {
  readonly descriptor: WidgetKindDescriptor

  constructor(
    private readonly github: GithubClient,
    private readonly metric: 'views' | 'clones'
  ) {
    this.descriptor = {
      kind: `github-traffic-${metric}`,
      label: metric === 'views' ? 'GitHub views' : 'GitHub clones',
      description:
        metric === 'views'
          ? "Daily views of the project's GitHub repo over the last 14 days (GitHub retains no more). Requires a token with push access to the repo."
          : "Daily clones of the project's GitHub repo over the last 14 days, including clones made by CI systems. Requires a token with push access to the repo.",
      requiresGithub: true,
      configFields: []
    }
  }

  async fetch(ctx: WidgetFetchContext): Promise<WidgetData> {
    const { owner, repo } = requireRepo(ctx.project)
    let data: GithubTraffic
    try {
      data = await this.github.get<GithubTraffic>(`/repos/{owner}/{repo}/traffic/${this.metric}`, {
        owner,
        repo
      })
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 403 || status === 404) {
        return {
          shape: 'unavailable',
          reason: 'Traffic data is unavailable; the token needs push access to this repo.'
        }
      }
      throw err
    }
    const points = (this.metric === 'views' ? data.views : data.clones) ?? []
    return {
      shape: 'timeseries',
      unit: this.metric,
      points: points.map((p) => ({
        date: p.timestamp,
        value: p.count,
        details: [`${p.uniques} unique`]
      }))
    }
  }
}

/** Published GitHub releases with per-asset download counts, newest first. */
export class GithubReleasesProvider implements WidgetProvider {
  readonly descriptor: WidgetKindDescriptor = {
    kind: 'github-releases',
    label: 'GitHub releases',
    description:
      'Published GitHub releases for this repo, newest first. Download counts are lifetime totals per asset - a rough proxy for how many people installed each version.',
    requiresGithub: true,
    configFields: []
  }

  constructor(private readonly github: GithubClient) {}

  async fetch(ctx: WidgetFetchContext): Promise<WidgetData> {
    const { owner, repo } = requireRepo(ctx.project)
    const releases = await this.github.get<GithubRelease[]>('/repos/{owner}/{repo}/releases', {
      owner,
      repo,
      per_page: 50
    })
    return {
      shape: 'releases',
      releases: releases.map((r) => ({
        tag: r.tag_name,
        name: r.name,
        publishedAt: r.published_at,
        notes: r.body,
        url: r.html_url,
        assets: r.assets.map((a) => ({
          name: a.name,
          downloadCount: a.download_count,
          sizeBytes: a.size
        }))
      }))
    }
  }
}

/** Repo popularity counters (stars, forks, watchers, open issues) as stat tiles. */
export class GithubRepoStatsProvider implements WidgetProvider {
  readonly descriptor: WidgetKindDescriptor = {
    kind: 'github-repo-stats',
    label: 'GitHub repo stats',
    description:
      "The repo's current stars, forks, watchers, and open issues (open pull requests count as issues on GitHub).",
    requiresGithub: true,
    configFields: []
  }

  constructor(private readonly github: GithubClient) {}

  async fetch(ctx: WidgetFetchContext): Promise<WidgetData> {
    const { owner, repo } = requireRepo(ctx.project)
    const data = await this.github.get<GithubRepo>('/repos/{owner}/{repo}', { owner, repo })
    return {
      shape: 'stat',
      stats: [
        { label: 'Stars', value: compactCount(data.stargazers_count) },
        { label: 'Forks', value: compactCount(data.forks_count) },
        { label: 'Watchers', value: compactCount(data.subscribers_count) },
        { label: 'Open issues', value: compactCount(data.open_issues_count) }
      ]
    }
  }
}

/** Compact counters for stat tiles: 950, 12.4k, 1.2M. */
export function compactCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
