import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'
import { PipelineNotConfiguredError } from '../src/main/services/PipelineProvider'
import { VercelPipelineProvider } from '../src/main/services/VercelPipelineProvider'
import type { FetchFn } from '../src/main/services/VercelPipelineProvider'
import type { VercelTokenStore } from '../src/main/services/VercelTokenStore'

function project(vercel: Project['vercel']): Project {
  return {
    id: 'p1',
    name: 'Demo',
    path: 'C:/demo',
    tags: [],
    github: null,
    vercel,
    links: [],
    looping: false,
    agentTaskCreation: false,
    createdAt: '2026-07-01T00:00:00Z'
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function tokenStore(token: string | null): VercelTokenStore {
  return { getToken: () => token } as unknown as VercelTokenStore
}

describe('VercelPipelineProvider.isConfigured', () => {
  it('depends only on the project link, not the token', () => {
    const provider = new VercelPipelineProvider(tokenStore(null))
    expect(provider.isConfigured(project({ projectId: 'prj_1', teamId: null }))).toBe(true)
    expect(provider.isConfigured(project(null))).toBe(false)
  })
})

describe('VercelPipelineProvider.poll', () => {
  it('throws PipelineNotConfiguredError when no token is stored', async () => {
    const provider = new VercelPipelineProvider(tokenStore(null))
    await expect(provider.poll(project({ projectId: 'prj_1', teamId: null }), null)).rejects.toThrow(
      PipelineNotConfiguredError
    )
  })

  it('requests deployments for the linked project and team with a bearer token', async () => {
    const fetchFn: FetchFn = vi.fn().mockResolvedValue(jsonResponse({ deployments: [] }))
    const provider = new VercelPipelineProvider(tokenStore('vercel-token'), {
      fetchFn,
      apiBase: 'http://127.0.0.1:9'
    })
    await provider.poll(project({ projectId: 'prj_1', teamId: 'team_x' }), null)
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:9/v6/deployments?projectId=prj_1&limit=20&teamId=team_x',
      { headers: { accept: 'application/json', authorization: 'Bearer vercel-token' } }
    )
  })

  it('maps a ready production deployment to a successful PipelineRun with duration and commit info', async () => {
    const fetchFn: FetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        deployments: [
          {
            uid: 'dpl_1',
            name: 'my-app',
            url: 'my-app-abc123.vercel.app',
            inspectorUrl: 'https://vercel.com/me/my-app/dpl_1',
            created: 1_700_000_000_000,
            buildingAt: 1_700_000_000_000,
            ready: 1_700_000_060_000,
            readyState: 'READY',
            target: 'production',
            meta: {
              githubCommitSha: 'abc123',
              githubCommitMessage: 'feat: ship it',
              githubCommitRef: 'main'
            }
          }
        ]
      })
    )
    const provider = new VercelPipelineProvider(tokenStore('t'), { fetchFn })
    const result = await provider.poll(project({ projectId: 'prj_1', teamId: null }), null)
    expect(result.runs).toEqual([
      {
        id: 'dpl_1',
        pipeline: 'vercel',
        name: 'Production',
        branch: 'main',
        commitSha: 'abc123',
        commitMessage: 'feat: ship it',
        status: 'success',
        startedAt: new Date(1_700_000_000_000).toISOString(),
        durationSeconds: 60,
        url: 'https://vercel.com/me/my-app/dpl_1',
        logsAvailable: true
      }
    ])
  })

  it('maps every Vercel readyState to the corresponding RunStatus', async () => {
    const cases: Array<[string, string]> = [
      ['READY', 'success'],
      ['ERROR', 'failure'],
      ['CANCELED', 'cancelled'],
      ['QUEUED', 'queued'],
      ['BUILDING', 'in_progress'],
      ['INITIALIZING', 'in_progress'],
      ['BLOCKED', 'action_required'],
      ['DELETED', 'neutral'],
      ['SOMETHING_NEW', 'unknown']
    ]
    for (const [readyState, status] of cases) {
      const fetchFn: FetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          deployments: [
            { uid: 'd1', name: 'app', url: 'app.vercel.app', created: 1_700_000_000_000, readyState }
          ]
        })
      )
      const provider = new VercelPipelineProvider(tokenStore('t'), { fetchFn })
      const result = await provider.poll(project({ projectId: 'prj_1', teamId: null }), null)
      expect(result.runs[0].status).toBe(status)
    }
  })

  it('falls back to the deployment url when no inspectorUrl is given, and Preview when untargeted', async () => {
    const fetchFn: FetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        deployments: [
          {
            uid: 'd1',
            name: 'app',
            url: 'app-preview.vercel.app',
            created: 1_700_000_000_000,
            readyState: 'READY'
          }
        ]
      })
    )
    const provider = new VercelPipelineProvider(tokenStore('t'), { fetchFn })
    const result = await provider.poll(project({ projectId: 'prj_1', teamId: null }), null)
    expect(result.runs[0].url).toBe('https://app-preview.vercel.app')
    expect(result.runs[0].name).toBe('Preview')
  })

  it('rejects when Vercel answers with a non-OK status', async () => {
    const fetchFn: FetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500))
    const provider = new VercelPipelineProvider(tokenStore('t'), { fetchFn })
    await expect(provider.poll(project({ projectId: 'prj_1', teamId: null }), null)).rejects.toThrow(
      /HTTP 500/
    )
  })
})

describe('VercelPipelineProvider.fetchLogs', () => {
  it('throws PipelineNotConfiguredError when no token is stored', async () => {
    const provider = new VercelPipelineProvider(tokenStore(null))
    await expect(provider.fetchLogs(project({ projectId: 'prj_1', teamId: null }), 'dpl_1')).rejects.toThrow(
      PipelineNotConfiguredError
    )
  })

  it('maps stdout/stderr events to log lines and skips events without text, tolerantly', async () => {
    const fetchFn: FetchFn = vi.fn().mockResolvedValue(
      jsonResponse([
        { type: 'command', created: 1_700_000_000_000, date: 1_700_000_000_000, text: '$ npm run build' },
        { type: 'stdout', created: 1_700_000_001_000, date: 1_700_000_001_000, text: 'Building...' },
        { type: 'stderr', created: 1_700_000_002_000, date: 1_700_000_002_000, text: 'a warning' },
        { type: 'metric', created: 1_700_000_003_000 },
        { type: 'alias-assigned', deploymentId: 'dpl_1' }
      ])
    )
    const provider = new VercelPipelineProvider(tokenStore('t'), { fetchFn })
    const logs = await provider.fetchLogs(project({ projectId: 'prj_1', teamId: 'team_x' }), 'dpl_1')
    expect(logs.externalUrl).toBe('https://vercel.com/deployments/dpl_1')
    expect(logs.lines).toEqual([
      { at: new Date(1_700_000_000_000).toISOString(), stream: 'system', text: '$ npm run build' },
      { at: new Date(1_700_000_001_000).toISOString(), stream: 'stdout', text: 'Building...' },
      { at: new Date(1_700_000_002_000).toISOString(), stream: 'stderr', text: 'a warning' }
    ])
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/v3/deployments/dpl_1/events?builds=1&teamId=team_x'),
      { headers: { accept: 'application/json', authorization: 'Bearer t' } }
    )
  })
})
