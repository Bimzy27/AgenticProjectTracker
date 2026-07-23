import { describe, expect, it } from 'vitest'
import type { PipelineRun } from '../src/shared/domain'
import { computeFailureRate } from '../src/main/services/PipelineProvider'

function run(overrides: Partial<PipelineRun> = {}): PipelineRun {
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

describe('computeFailureRate', () => {
  it('is null with no completed runs', () => {
    expect(computeFailureRate([])).toEqual({ percent: null, sampleSize: 0 })
    expect(computeFailureRate([run({ status: 'in_progress' }), run({ status: 'queued' })])).toEqual({
      percent: null,
      sampleSize: 0
    })
  })

  it('counts only success/failure as completed attempts, ignoring in-flight and neutral runs', () => {
    const runs = [
      run({ id: '1', status: 'success', startedAt: '2026-07-01T00:00:00Z' }),
      run({ id: '2', status: 'failure', startedAt: '2026-07-02T00:00:00Z' }),
      run({ id: '3', status: 'cancelled', startedAt: '2026-07-03T00:00:00Z' }),
      run({ id: '4', status: 'in_progress', startedAt: '2026-07-04T00:00:00Z' }),
      run({ id: '5', status: 'neutral', startedAt: '2026-07-05T00:00:00Z' })
    ]
    expect(computeFailureRate(runs)).toEqual({ percent: 50, sampleSize: 2 })
  })

  it('is generic across pipeline kinds: mixed providers combine into one rate', () => {
    const runs = [
      run({ id: '1', pipeline: 'github-actions', status: 'success', startedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'dpl_1', pipeline: 'vercel', status: 'failure', startedAt: '2026-07-02T00:00:00Z' })
    ]
    expect(computeFailureRate(runs)).toEqual({ percent: 50, sampleSize: 2 })
  })

  it('only samples the most recent N completed runs', () => {
    const older = run({ id: 'old', status: 'failure', startedAt: '2026-01-01T00:00:00Z' })
    const recentSuccesses = Array.from({ length: 5 }, (_, i) =>
      run({ id: `r${i}`, status: 'success', startedAt: `2026-07-0${i + 1}T00:00:00Z` })
    )
    const result = computeFailureRate([older, ...recentSuccesses], 5)
    expect(result).toEqual({ percent: 0, sampleSize: 5 })
  })

  it('rounds the percentage to the nearest integer', () => {
    const runs = [
      run({ id: '1', status: 'failure', startedAt: '2026-07-01T00:00:00Z' }),
      run({ id: '2', status: 'success', startedAt: '2026-07-02T00:00:00Z' }),
      run({ id: '3', status: 'success', startedAt: '2026-07-03T00:00:00Z' })
    ]
    expect(computeFailureRate(runs).percent).toBe(33)
  })
})
