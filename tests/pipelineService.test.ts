import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRun, Project } from '../src/shared/domain'
import type { ConditionalResponse } from '../src/main/services/GithubClient'
import { GithubNotConfiguredError } from '../src/main/services/GithubClient'
import { GithubActionsPipelineProvider } from '../src/main/services/GithubActionsPipelineProvider'
import { PipelineService, summarize } from '../src/main/services/PipelineService'
import type { PipelineEventSink } from '../src/main/services/PipelineService'
import type { PipelinePoll, PipelineProvider } from '../src/main/services/PipelineProvider'
import { ProjectStore } from '../src/main/services/ProjectStore'

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

interface FakeGithub {
  conditionalGet: ReturnType<typeof vi.fn>
}

function fakeGithub(): FakeGithub {
  return { conditionalGet: vi.fn() }
}

function response(runs: Record<string, unknown>[], etag = 'etag-1'): ConditionalResponse<unknown> {
  return { data: { workflow_runs: runs }, etag, notModified: false }
}

describe('PipelineService with a GitHub Actions provider', () => {
  let dir: string
  let store: ProjectStore
  let project: Project
  let github: FakeGithub
  let sink: { pipelineUpdated: ReturnType<typeof vi.fn>; notifyRun: ReturnType<typeof vi.fn> }
  let service: PipelineService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apt-pipe-'))
    store = new ProjectStore(dir)
    project = store.add({
      path: 'C:\\repos\\demo',
      name: 'Demo',
      tags: [],
      github: { owner: 'me', repo: 'demo' }
    })
    github = fakeGithub()
    sink = { pipelineUpdated: vi.fn(), notifyRun: vi.fn() }
    const provider = new GithubActionsPipelineProvider(github as never)
    service = new PipelineService([provider], store, sink as unknown as PipelineEventSink, 60_000)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('polls repos, stores runs, and emits pipeline-updated', async () => {
    github.conditionalGet.mockResolvedValueOnce(response([ghRun()]))
    await service.tick(1_000)
    expect(github.conditionalGet).toHaveBeenCalledWith(
      '/repos/{owner}/{repo}/actions/runs',
      expect.objectContaining({ owner: 'me', repo: 'demo' }),
      null
    )
    expect(service.getRuns(project.id)).toHaveLength(1)
    expect(sink.pipelineUpdated).toHaveBeenCalledOnce()
    expect(service.getSummary(project.id)?.overall).toBe('success')
  })

  it('sends the stored ETag and skips work on 304', async () => {
    github.conditionalGet.mockResolvedValueOnce(response([ghRun()], 'etag-xyz'))
    await service.tick(1_000)
    github.conditionalGet.mockResolvedValueOnce({ data: null, etag: 'etag-xyz', notModified: true })
    await service.tick(100_000)
    expect(github.conditionalGet).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), 'etag-xyz')
    expect(sink.pipelineUpdated).toHaveBeenCalledOnce()
  })

  it('respects the per-provider poll interval', async () => {
    github.conditionalGet.mockResolvedValue(response([ghRun()]))
    await service.tick(1_000)
    await service.tick(2_000)
    expect(github.conditionalGet).toHaveBeenCalledOnce()
    await service.tick(1_000 + 61_000)
    expect(github.conditionalGet).toHaveBeenCalledTimes(2)
  })

  it('does not notify for failures already present when the app starts', async () => {
    // A fresh service instance is what an app launch produces; runs that failed
    // before startup are old news and must not spam desktop notifications.
    const staleFailures = [
      ghRun({ id: 1, conclusion: 'failure' }),
      ghRun({ id: 2, name: 'Deploy', conclusion: 'failure' }),
      ghRun({ id: 3, name: 'Nightly', status: 'waiting', conclusion: null })
    ]
    github.conditionalGet.mockResolvedValueOnce(response(staleFailures, 'e1'))
    await service.tick(1_000)
    expect(sink.notifyRun).not.toHaveBeenCalled()

    // the same stale failures on the next poll stay silent too
    github.conditionalGet.mockResolvedValueOnce(response(staleFailures, 'e2'))
    await service.tick(200_000)
    expect(sink.notifyRun).not.toHaveBeenCalled()

    // a run that fails after startup still notifies
    github.conditionalGet.mockResolvedValueOnce(
      response([ghRun({ id: 4, conclusion: 'failure' }), ...staleFailures], 'e3')
    )
    await service.tick(400_000)
    expect(sink.notifyRun).toHaveBeenCalledOnce()
  })

  it('notifies on failure exactly once and re-notifies only after recovery', async () => {
    // baseline poll: everything green
    github.conditionalGet.mockResolvedValueOnce(response([ghRun({ conclusion: 'success' })], 'e0'))
    await service.tick(1_000)

    const failing = ghRun({ conclusion: 'failure' })
    github.conditionalGet.mockResolvedValueOnce(response([failing], 'e1'))
    await service.tick(200_000)
    expect(sink.notifyRun).toHaveBeenCalledOnce()

    // same failure polled again: no duplicate notification
    github.conditionalGet.mockResolvedValueOnce(response([failing], 'e2'))
    await service.tick(400_000)
    expect(sink.notifyRun).toHaveBeenCalledOnce()

    // recovery then a new failure: notify again
    github.conditionalGet.mockResolvedValueOnce(response([ghRun({ conclusion: 'success' })], 'e3'))
    await service.tick(600_000)
    github.conditionalGet.mockResolvedValueOnce(response([failing], 'e4'))
    await service.tick(800_000)
    expect(sink.notifyRun).toHaveBeenCalledTimes(2)
  })

  it('backs off exponentially after API failures', async () => {
    github.conditionalGet.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 403 }))
    await service.tick(0)
    expect(github.conditionalGet).toHaveBeenCalledOnce()
    // first backoff equals the poll interval: not yet due at +30s
    await service.tick(30_000)
    expect(github.conditionalGet).toHaveBeenCalledOnce()
    await service.tick(61_000)
    expect(github.conditionalGet).toHaveBeenCalledTimes(2)
    // second backoff doubles: not due until +120s after the failure
    await service.tick(61_000 + 100_000)
    expect(github.conditionalGet).toHaveBeenCalledTimes(2)
    await service.tick(61_000 + 121_000)
    expect(github.conditionalGet).toHaveBeenCalledTimes(3)
  })

  it('surfaces poll failures in the summary and clears them on recovery', async () => {
    github.conditionalGet.mockRejectedValueOnce(Object.assign(new Error('bad credentials'), { status: 401 }))
    await service.tick(1_000)
    expect(service.getSummary(project.id)?.error).toBe('bad credentials')
    expect(sink.pipelineUpdated).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ error: 'bad credentials' }),
      []
    )

    github.conditionalGet.mockResolvedValueOnce(response([ghRun()]))
    await service.tick(200_000)
    expect(service.getSummary(project.id)?.error).toBeNull()
  })

  it('skips silently while no GitHub token is configured yet, without backoff or an error', async () => {
    github.conditionalGet.mockRejectedValue(new GithubNotConfiguredError())
    await service.tick(1_000)
    expect(sink.pipelineUpdated).not.toHaveBeenCalled()
    expect(service.getRuns(project.id)).toEqual([])
    // Retried immediately on the very next tick (no backoff for "not configured yet").
    await service.tick(1_001)
    expect(github.conditionalGet).toHaveBeenCalledTimes(2)
  })

  it('does nothing for a project without a linked repo', async () => {
    store.update(project.id, { github: null })
    await service.tick(1_000)
    expect(github.conditionalGet).not.toHaveBeenCalled()
  })
})

describe('PipelineService merging multiple providers', () => {
  let dir: string
  let store: ProjectStore
  let project: Project
  let sink: { pipelineUpdated: ReturnType<typeof vi.fn>; notifyRun: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apt-pipe-multi-'))
    store = new ProjectStore(dir)
    project = store.add({ path: 'C:\\repos\\demo', name: 'Demo', tags: [], github: null })
    sink = { pipelineUpdated: vi.fn(), notifyRun: vi.fn() }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function fakeProvider(
    kind: 'github-actions' | 'vercel',
    poll: () => Promise<PipelinePoll>
  ): PipelineProvider {
    return { kind, isConfigured: () => true, poll }
  }

  function pipelineRun(overrides: Partial<PipelineRun>): PipelineRun {
    return {
      id: '1',
      pipeline: 'github-actions',
      name: 'CI',
      branch: 'main',
      commitSha: 'abc',
      commitMessage: 'msg',
      status: 'success',
      startedAt: '2026-07-01T00:00:00Z',
      durationSeconds: 60,
      url: 'https://example.com',
      logsAvailable: false,
      ...overrides
    }
  }

  it('merges runs from every configured provider, newest first, into one combined summary', async () => {
    const ghRuns = [
      pipelineRun({
        id: '1',
        pipeline: 'github-actions',
        status: 'success',
        startedAt: '2026-07-01T00:00:00Z'
      })
    ]
    const vercelRuns = [
      pipelineRun({
        id: 'dpl_1',
        pipeline: 'vercel',
        name: 'Production',
        status: 'failure',
        startedAt: '2026-07-02T00:00:00Z',
        logsAvailable: true
      })
    ]
    const github = fakeProvider('github-actions', async () => ({
      runs: ghRuns,
      etag: null,
      notModified: false
    }))
    const vercel = fakeProvider('vercel', async () => ({ runs: vercelRuns, etag: null, notModified: false }))
    const service = new PipelineService([github, vercel], store, sink as unknown as PipelineEventSink, 60_000)

    await service.tick(0)

    const runs = service.getRuns(project.id)
    expect(runs.map((r) => r.pipeline)).toEqual(['vercel', 'github-actions'])

    const summary = service.getSummary(project.id)!
    expect(summary.overall).toBe('failure')
    expect(summary.failureRatePercent).toBe(50)
    expect(summary.failureRateSampleSize).toBe(2)
  })

  it("routes fetchLogs to the provider matching the run's pipeline kind", async () => {
    const fetchLogs = vi.fn().mockResolvedValue({ lines: [], externalUrl: 'https://vercel.com/x' })
    const vercel: PipelineProvider = {
      kind: 'vercel',
      isConfigured: () => true,
      poll: async () => ({ runs: [], etag: null, notModified: false }),
      fetchLogs
    }
    const service = new PipelineService([vercel], store, sink as unknown as PipelineEventSink, 60_000)
    const logs = await service.fetchLogs(project.id, 'vercel', 'dpl_1')
    expect(fetchLogs).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), 'dpl_1')
    expect(logs.externalUrl).toBe('https://vercel.com/x')
  })

  it('rejects fetchLogs for a provider that does not support logs', async () => {
    const github = fakeProvider('github-actions', async () => ({ runs: [], etag: null, notModified: false }))
    const service = new PipelineService([github], store, sink as unknown as PipelineEventSink, 60_000)
    await expect(service.fetchLogs(project.id, 'github-actions', '1')).rejects.toThrow(/does not support/)
  })
})

describe('summarize', () => {
  function pipelineRun(overrides: Partial<PipelineRun>): PipelineRun {
    return {
      id: '1',
      pipeline: 'github-actions',
      name: 'CI',
      branch: 'main',
      commitSha: 'abc',
      commitMessage: 'msg',
      status: 'success',
      startedAt: '2026-07-01T00:00:00Z',
      durationSeconds: 60,
      url: 'https://example.com',
      logsAvailable: false,
      ...overrides
    }
  }

  it('summarizes using the latest run per (pipeline, name) group', () => {
    const runs: PipelineRun[] = [
      pipelineRun({ id: '3', name: 'CI', status: 'failure', startedAt: '2026-07-03T00:00:00Z' }),
      pipelineRun({ id: '2', name: 'CI', status: 'success', startedAt: '2026-07-02T00:00:00Z' }),
      pipelineRun({ id: '1', name: 'Deploy', status: 'success', startedAt: '2026-07-01T00:00:00Z' })
    ]
    const summary = summarize(runs)
    expect(summary.overall).toBe('failure')
    expect(summary.failingRuns).toBe(1)
  })

  it('keeps GitHub Actions and Vercel groups independent even when names collide', () => {
    const runs: PipelineRun[] = [
      pipelineRun({ id: '1', pipeline: 'github-actions', name: 'Production', status: 'failure' }),
      pipelineRun({ id: 'dpl_1', pipeline: 'vercel', name: 'Production', status: 'success' })
    ]
    const summary = summarize(runs)
    expect(summary.overall).toBe('failure')
    expect(summary.failingRuns).toBe(1)
  })
})
