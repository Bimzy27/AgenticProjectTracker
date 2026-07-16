import { describe, expect, it, vi } from 'vitest'
import { createTrackerApi, type ApiDeps } from '../src/main/api'

/** Minimal deps stub: only the members updateProject/updateTask touch are real. */
function makeDeps(project: { id: string; looping: boolean }) {
  return {
    projects: { update: vi.fn().mockResolvedValue(project) },
    sessions: { approvePendingRunPermissions: vi.fn() },
    tasks: { update: vi.fn().mockReturnValue({ id: 't1' }) },
    orchestrator: { reschedule: vi.fn() },
    onProjectsChanged: vi.fn()
  }
}

describe('createTrackerApi updateProject', () => {
  it('flushes parked run permissions and reschedules when looping turns on', async () => {
    const deps = makeDeps({ id: 'p1', looping: true })
    const api = createTrackerApi(deps as unknown as ApiDeps)

    await api.updateProject('p1', { looping: true })

    expect(deps.sessions.approvePendingRunPermissions).toHaveBeenCalledWith('p1')
    expect(deps.orchestrator.reschedule).toHaveBeenCalledOnce()
  })

  it('does not flush permissions when looping turns off or is untouched', async () => {
    const deps = makeDeps({ id: 'p1', looping: false })
    const api = createTrackerApi(deps as unknown as ApiDeps)

    await api.updateProject('p1', { looping: false })
    // Turning looping off still reschedules (the loop must stop picking up work)
    // but must not approve prompts the user now wants to answer personally.
    expect(deps.orchestrator.reschedule).toHaveBeenCalledOnce()
    expect(deps.sessions.approvePendingRunPermissions).not.toHaveBeenCalled()

    await api.updateProject('p1', { name: 'Renamed' })
    expect(deps.orchestrator.reschedule).toHaveBeenCalledOnce()
    expect(deps.sessions.approvePendingRunPermissions).not.toHaveBeenCalled()
  })
})

describe('createTrackerApi updateTask', () => {
  it('reschedules when loop participation is toggled, so idle looping projects react', async () => {
    const deps = makeDeps({ id: 'p1', looping: true })
    const api = createTrackerApi(deps as unknown as ApiDeps)

    await api.updateTask('p1', 't1', { loopEnabled: true })

    expect(deps.tasks.update).toHaveBeenCalledWith('t1', { loopEnabled: true })
    expect(deps.orchestrator.reschedule).toHaveBeenCalledOnce()
  })

  it('does not reschedule for edits that leave loop participation untouched', async () => {
    const deps = makeDeps({ id: 'p1', looping: true })
    const api = createTrackerApi(deps as unknown as ApiDeps)

    await api.updateTask('p1', 't1', { title: 'Renamed' })

    expect(deps.orchestrator.reschedule).not.toHaveBeenCalled()
  })
})
