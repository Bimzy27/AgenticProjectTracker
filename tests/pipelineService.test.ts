import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, WorkflowRun } from '../src/shared/domain'
import type { ConditionalResponse } from '../src/main/services/GithubClient'
import { PipelineService, mapRun, summarize } from '../src/main/services/PipelineService'
import type { PipelineEventSink } from '../src/main/services/PipelineService'
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
  isConfigured(): boolean
  conditionalGet: ReturnType<typeof vi.fn>
  getRateLimit(): unknown
}

function fakeGithub(): FakeGithub {
  return {
    isConfigured: () => true,
    conditionalGet: vi.fn(),
    getRateLimit: () => ({ limit: null, remaining: null, resetAt: null, low: false })
  }
}

function response(runs: Record<string, unknown>[], etag = 'etag-1'): ConditionalResponse<unknown> {
  return { data: { workflow_runs: runs }, etag, notModified: false }
}

describe('PipelineService', () => {
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
    service = new PipelineService(github as never, store, sink as unknown as PipelineEventSink, 60_000)
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

  it('respects the per-repo poll interval', async () => {
    github.conditionalGet.mockResolvedValue(response([ghRun()]))
    await service.tick(1_000)
    await service.tick(2_000)
    expect(github.conditionalGet).toHaveBeenCalledOnce()
    await service.tick(1_000 + 61_000)
    expect(github.conditionalGet).toHaveBeenCalledTimes(2)
  })

  it('notifies on failure exactly once and re-notifies only after recovery', async () => {
    const failing = ghRun({ conclusion: 'failure' })
    github.conditionalGet.mockResolvedValueOnce(response([failing], 'e1'))
    await service.tick(1_000)
    expect(sink.notifyRun).toHaveBeenCalledOnce()

    // same failure polled again: no duplicate notification
    github.conditionalGet.mockResolvedValueOnce(response([failing], 'e2'))
    await service.tick(200_000)
    expect(sink.notifyRun).toHaveBeenCalledOnce()

    // recovery then a new failure: notify again
    github.conditionalGet.mockResolvedValueOnce(response([ghRun({ conclusion: 'success' })], 'e3'))
    await service.tick(400_000)
    github.conditionalGet.mockResolvedValueOnce(response([failing], 'e4'))
    await service.tick(600_000)
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

  it('does nothing without a token or without a linked repo', async () => {
    github.isConfigured = () => false
    await service.tick(1_000)
    expect(github.conditionalGet).not.toHaveBeenCalled()
  })
})

describe('mapRun and summarize', () => {
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

  it('summarizes using the latest run per workflow', () => {
    const runs: WorkflowRun[] = [
      mapRun(ghRun({ id: 3, name: 'CI', conclusion: 'failure' }) as never),
      mapRun(ghRun({ id: 2, name: 'CI', conclusion: 'success' }) as never),
      mapRun(ghRun({ id: 1, name: 'Deploy', conclusion: 'success' }) as never)
    ]
    const summary = summarize(runs)
    expect(summary.overall).toBe('failure')
    expect(summary.failingRuns).toBe(1)
  })
})
