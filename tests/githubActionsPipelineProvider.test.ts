import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'
import type { GithubClient } from '../src/main/services/GithubClient'
import { GithubActionsPipelineProvider, mapRun } from '../src/main/services/GithubActionsPipelineProvider'

function project(): Project {
  return {
    id: 'p1',
    name: 'Demo',
    path: 'C:/demo',
    tags: [],
    github: { owner: 'me', repo: 'demo' },
    vercel: null,
    links: [],
    looping: false,
    agentTaskCreation: false,
    createdAt: '2026-07-01T00:00:00Z'
  }
}

function githubWith(get: ReturnType<typeof vi.fn>): GithubClient {
  return { get } as never
}

function ghRun(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: 'CI',
    head_branch: 'main',
    head_sha: 'abcdef1234567890',
    display_title: 'some commit',
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:05:00Z',
    html_url: 'https://github.com/me/demo/actions/runs/1',
    ...overrides
  }
}

describe('mapRun', () => {
  it('maps GitHub status/conclusion pairs to RunStatus', () => {
    expect(mapRun(ghRun() as never).status).toBe('success')
    expect(mapRun(ghRun({ conclusion: 'failure' }) as never).status).toBe('failure')
    expect(mapRun(ghRun({ conclusion: 'timed_out' }) as never).status).toBe('failure')
    expect(mapRun(ghRun({ status: 'in_progress', conclusion: null }) as never).status).toBe('in_progress')
    expect(mapRun(ghRun({ status: 'waiting', conclusion: null }) as never).status).toBe('action_required')
  })

  it('computes duration only for completed runs', () => {
    expect(mapRun(ghRun() as never).durationSeconds).toBe(300)
    expect(mapRun(ghRun({ status: 'in_progress', conclusion: null }) as never).durationSeconds).toBeNull()
  })

  it('tags every run with the github-actions pipeline kind, a string id, and logs available', () => {
    const run = mapRun(ghRun() as never)
    expect(run.pipeline).toBe('github-actions')
    expect(run.id).toBe('1')
    expect(run.logsAvailable).toBe(true)
  })

  it('falls back to a placeholder workflow name and empty branch when GitHub omits them', () => {
    const run = mapRun(ghRun({ name: null, head_branch: null }) as never)
    expect(run.name).toBe('workflow')
    expect(run.branch).toBe('')
  })
})

describe('GithubActionsPipelineProvider.fetchLogs', () => {
  it('stitches per-job logs into normalized lines, headered by job, and links to the run on GitHub', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        jobs: [
          { id: 11, name: 'build' },
          { id: 12, name: 'test' }
        ]
      })
      .mockResolvedValueOnce(
        '2026-07-01T10:00:00.0000000Z Installing dependencies\n' +
          '2026-07-01T10:00:01.0000000Z ##[error]npm install failed\n'
      )
      .mockResolvedValueOnce('2026-07-01T10:01:00.0000000Z Running tests\n')
    const provider = new GithubActionsPipelineProvider(githubWith(get))

    const logs = await provider.fetchLogs(project(), '999')

    expect(logs.externalUrl).toBe('https://github.com/me/demo/actions/runs/999')
    expect(logs.lines).toEqual([
      { at: null, stream: 'system', text: '== build ==' },
      { at: '2026-07-01T10:00:00.0000000Z', stream: 'stdout', text: 'Installing dependencies' },
      { at: '2026-07-01T10:00:01.0000000Z', stream: 'stderr', text: '##[error]npm install failed' },
      { at: null, stream: 'system', text: '== test ==' },
      { at: '2026-07-01T10:01:00.0000000Z', stream: 'stdout', text: 'Running tests' }
    ])
    expect(get).toHaveBeenNthCalledWith(1, '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
      owner: 'me',
      repo: 'demo',
      run_id: 999
    })
    expect(get).toHaveBeenNthCalledWith(2, '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
      owner: 'me',
      repo: 'demo',
      job_id: 11
    })
  })

  it('omits the job header and skips blank lines when the run has a single job', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ jobs: [{ id: 21, name: 'build' }] })
      .mockResolvedValueOnce('2026-07-01T10:00:00.0000000Z one\n\n2026-07-01T10:00:01.0000000Z two\n')
    const provider = new GithubActionsPipelineProvider(githubWith(get))

    const logs = await provider.fetchLogs(project(), '5')

    expect(logs.lines).toEqual([
      { at: '2026-07-01T10:00:00.0000000Z', stream: 'stdout', text: 'one' },
      { at: '2026-07-01T10:00:01.0000000Z', stream: 'stdout', text: 'two' }
    ])
  })

  it('treats a line with no timestamp prefix as untimed stdout', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ jobs: [{ id: 1, name: 'build' }] })
      .mockResolvedValueOnce('not a timestamped line\n')
    const provider = new GithubActionsPipelineProvider(githubWith(get))

    const logs = await provider.fetchLogs(project(), '1')

    expect(logs.lines).toEqual([{ at: null, stream: 'stdout', text: 'not a timestamped line' }])
  })
})
