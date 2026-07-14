import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskService } from '../src/main/services/TaskService'
import type { TaskEventSink } from '../src/main/services/TaskService'

describe('TaskService', () => {
  let userData: string
  let sink: { tasksChanged: ReturnType<typeof vi.fn> }
  let service: TaskService

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'apt-tasks-'))
    sink = { tasksChanged: vi.fn() }
    service = new TaskService(userData, sink as TaskEventSink)
  })

  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  const input = { title: 'Add login', purpose: 'Build the login page', acceptanceCriteria: ['form works'] }

  it('creates tasks in draft state with defaults and timestamps', () => {
    const task = service.create('p1', input)
    expect(task).toMatchObject({
      projectId: 'p1',
      state: 'draft',
      mode: 'acceptEdits',
      model: null,
      stepBudget: 30,
      recoveryBudget: 3,
      autoApprove: false,
      order: 0
    })
    expect(task.transitions).toEqual([{ state: 'draft', at: task.createdAt }])
    expect(sink.tasksChanged).toHaveBeenCalledWith('p1', [task])
  })

  it('appends new tasks to the end of the project backlog', () => {
    service.create('p1', { ...input, title: 'A' })
    service.create('p1', { ...input, title: 'B' })
    service.create('other', { ...input, title: 'X' })
    expect(service.listTasks('p1').map((t) => t.title)).toEqual(['A', 'B'])
  })

  it('records lifecycle transitions with timestamps', () => {
    const task = service.create('p1', input)
    service.setState(task.id, 'queued')
    service.setState(task.id, 'running')
    const stored = service.getOrThrow(task.id)
    expect(stored.transitions.map((t) => t.state)).toEqual(['draft', 'queued', 'running'])
    for (const transition of stored.transitions) {
      expect(Date.parse(transition.at)).not.toBeNaN()
    }
  })

  it('updates editable fields on non-running tasks', () => {
    const task = service.create('p1', input)
    service.update(task.id, { purpose: 'Build login with SSO', mode: 'auto', stepBudget: 50 })
    expect(service.getOrThrow(task.id)).toMatchObject({
      purpose: 'Build login with SSO',
      mode: 'auto',
      stepBudget: 50
    })
  })

  it('stores the selected model and normalizes blank selections to the default', () => {
    const task = service.create('p1', { ...input, model: 'opus' })
    expect(task.model).toBe('opus')

    service.update(task.id, { model: 'claude-opus-4-8' })
    expect(service.getOrThrow(task.id).model).toBe('claude-opus-4-8')

    // Whitespace-only custom ids mean "no selection", not a broken CLI flag.
    service.update(task.id, { model: '  ' })
    expect(service.getOrThrow(task.id).model).toBeNull()
    expect(service.create('p1', { ...input, model: '' }).model).toBeNull()
  })

  it('stores and toggles the auto-approve flag', () => {
    const auto = service.create('p1', { ...input, autoApprove: true })
    expect(auto.autoApprove).toBe(true)

    const manual = service.create('p1', input)
    expect(manual.autoApprove).toBe(false)

    service.update(manual.id, { autoApprove: true })
    expect(service.getOrThrow(manual.id).autoApprove).toBe(true)
    service.update(manual.id, { autoApprove: false })
    expect(service.getOrThrow(manual.id).autoApprove).toBe(false)
  })

  it('defaults auto-approve off for tasks persisted before it existed', () => {
    const task = service.create('p1', input)
    const file = JSON.parse(readFileSync(join(userData, 'tasks.json'), 'utf8'))
    for (const stored of file.tasks) delete stored.autoApprove
    writeFileSync(join(userData, 'tasks.json'), JSON.stringify(file), 'utf8')

    const reloaded = new TaskService(userData, sink as TaskEventSink)
    expect(reloaded.getOrThrow(task.id).autoApprove).toBe(false)
  })

  it('defaults the model for tasks persisted before model selection existed', () => {
    const task = service.create('p1', input)
    const file = JSON.parse(readFileSync(join(userData, 'tasks.json'), 'utf8'))
    for (const stored of file.tasks) delete stored.model
    writeFileSync(join(userData, 'tasks.json'), JSON.stringify(file), 'utf8')

    const reloaded = new TaskService(userData, sink as TaskEventSink)
    expect(reloaded.getOrThrow(task.id).model).toBeNull()
  })

  it.each(['running', 'needs-input'] as const)('refuses to edit or delete a task in %s state', (state) => {
    const task = service.create('p1', input)
    service.setState(task.id, state)
    expect(() => service.update(task.id, { title: 'New' })).toThrow(/stop the run first/)
    expect(() => service.delete(task.id)).toThrow(/stop the run first/)
  })

  it('deletes non-running tasks', () => {
    const task = service.create('p1', input)
    service.setState(task.id, 'done')
    service.delete(task.id)
    expect(service.listTasks('p1')).toEqual([])
  })

  it('reorders a task before another and to the end', () => {
    const a = service.create('p1', { ...input, title: 'A' })
    const b = service.create('p1', { ...input, title: 'B' })
    const c = service.create('p1', { ...input, title: 'C' })

    service.reorder(c.id, a.id)
    expect(service.listTasks('p1').map((t) => t.title)).toEqual(['C', 'A', 'B'])

    service.reorder(c.id, null)
    expect(service.listTasks('p1').map((t) => t.title)).toEqual(['A', 'B', 'C'])
    void b
  })

  it('rejects invalid budgets and blank fields', () => {
    const task = service.create('p1', input)
    expect(() => service.update(task.id, { stepBudget: 0 })).toThrow(/positive/)
    expect(() => service.update(task.id, { recoveryBudget: -1 })).toThrow(/zero or a positive/)
    expect(() => service.update(task.id, { title: '  ' })).toThrow(/title/)
    expect(() => service.create('p1', { ...input, purpose: ' ' })).toThrow(/purpose/)
  })

  it('archives a task automatically when it completes', () => {
    const task = service.create('p1', input)
    expect(task.archived).toBe(false)
    service.setState(task.id, 'done')
    expect(service.getOrThrow(task.id).archived).toBe(true)
  })

  it('archives settled tasks manually', () => {
    const draft = service.create('p1', { ...input, title: 'Draft' })
    const failed = service.create('p1', { ...input, title: 'Failed' })
    service.setState(failed.id, 'failed')
    service.archive(draft.id)
    service.archive(failed.id)
    expect(service.getOrThrow(draft.id).archived).toBe(true)
    expect(service.getOrThrow(failed.id).archived).toBe(true)
  })

  it.each(['queued', 'running', 'needs-input', 'review'] as const)(
    'refuses to archive a task in %s state',
    (state) => {
      const task = service.create('p1', input)
      service.setState(task.id, state)
      expect(() => service.archive(task.id)).toThrow(/cannot be archived/)
    }
  )

  it('revives an archived done task back to draft', () => {
    const task = service.create('p1', input)
    service.setState(task.id, 'done')
    const revived = service.revive(task.id)
    expect(revived).toMatchObject({ archived: false, state: 'draft' })
    expect(revived.transitions.map((t) => t.state)).toEqual(['draft', 'done', 'draft'])
  })

  it('revives a manually archived task without touching its state', () => {
    const task = service.create('p1', input)
    service.setState(task.id, 'failed')
    service.archive(task.id)
    expect(service.revive(task.id)).toMatchObject({ archived: false, state: 'failed' })
    expect(() => service.revive(task.id)).toThrow(/not archived/)
  })

  it('sweeps pre-archiving done tasks into the archive on load', () => {
    const done = service.create('p1', { ...input, title: 'Old done' })
    const open = service.create('p1', { ...input, title: 'Old open' })
    service.setState(done.id, 'done')
    // Rewrite the file as an older version of the app would have: no archived flag.
    const file = JSON.parse(readFileSync(join(userData, 'tasks.json'), 'utf8'))
    for (const task of file.tasks) delete task.archived
    writeFileSync(join(userData, 'tasks.json'), JSON.stringify(file), 'utf8')

    const reloaded = new TaskService(userData, sink as TaskEventSink)
    expect(reloaded.getOrThrow(done.id).archived).toBe(true)
    expect(reloaded.getOrThrow(open.id).archived).toBe(false)
  })

  it('persists tasks, states, and order across instances', () => {
    const a = service.create('p1', { ...input, title: 'A' })
    const b = service.create('p1', { ...input, title: 'B' })
    service.setState(a.id, 'queued')
    service.setReviewFeedback(b.id, 'needs polish')
    service.reorder(b.id, a.id)

    const reloaded = new TaskService(userData, sink as TaskEventSink)
    const tasks = reloaded.listTasks('p1')
    expect(tasks.map((t) => t.title)).toEqual(['B', 'A'])
    expect(tasks[1].state).toBe('queued')
    expect(tasks[0].reviewFeedback).toBe('needs polish')
    expect(tasks[1].transitions.map((t) => t.state)).toEqual(['draft', 'queued'])
  })
})
