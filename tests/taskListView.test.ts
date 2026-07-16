import { describe, expect, it } from 'vitest'
import type { TaskDefinition } from '../src/shared/domain'
import {
  applyTaskListView,
  DEFAULT_TASK_LIST_VIEW,
  defaultDirection,
  isManualOrderView
} from '../src/shared/taskListView'
import type { TaskListView } from '../src/shared/taskListView'

function task(overrides: Partial<TaskDefinition>): TaskDefinition {
  return {
    id: 'id',
    projectId: 'p1',
    title: 'Task',
    purpose: 'Do something',
    acceptanceCriteria: [],
    state: 'draft',
    order: 0,
    mode: 'acceptEdits',
    model: null,
    stepBudget: 30,
    recoveryBudget: 3,
    autoApprove: false,
    reviewFeedback: null,
    archived: false,
    loopEnabled: true,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    transitions: [],
    ...overrides
  }
}

const backlog = [
  task({
    id: 'a',
    title: 'beta feature',
    purpose: 'Build the beta surface',
    order: 0,
    createdAt: '2026-07-03T10:00:00.000Z',
    updatedAt: '2026-07-05T10:00:00.000Z'
  }),
  task({
    id: 'b',
    title: 'Alpha fix',
    purpose: 'Repair the alpha regression',
    order: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-06T10:00:00.000Z'
  }),
  task({
    id: 'c',
    title: 'Charlie chore',
    purpose: 'Sweep up the leftovers',
    order: 2,
    createdAt: '2026-07-02T10:00:00.000Z',
    updatedAt: '2026-07-04T10:00:00.000Z'
  })
]

function ids(view: TaskListView): string[] {
  return applyTaskListView(backlog, view).map((t) => t.id)
}

describe('applyTaskListView', () => {
  it('defaults to the manual backlog order without filtering', () => {
    expect(ids(DEFAULT_TASK_LIST_VIEW)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input array', () => {
    const input = [...backlog]
    applyTaskListView(input, { filter: '', sortKey: 'title', direction: 'desc' })
    expect(input).toEqual(backlog)
  })

  it('filters case-insensitively on the title', () => {
    expect(ids({ ...DEFAULT_TASK_LIST_VIEW, filter: 'ALPHA' })).toEqual(['b'])
  })

  it('filters on the purpose text as well', () => {
    expect(ids({ ...DEFAULT_TASK_LIST_VIEW, filter: 'leftovers' })).toEqual(['c'])
  })

  it('ignores surrounding whitespace in the filter', () => {
    expect(ids({ ...DEFAULT_TASK_LIST_VIEW, filter: '  charlie  ' })).toEqual(['c'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(ids({ ...DEFAULT_TASK_LIST_VIEW, filter: 'zebra' })).toEqual([])
  })

  it('sorts alphabetically by title in both directions, ignoring case', () => {
    expect(ids({ filter: '', sortKey: 'title', direction: 'asc' })).toEqual(['b', 'a', 'c'])
    expect(ids({ filter: '', sortKey: 'title', direction: 'desc' })).toEqual(['c', 'a', 'b'])
  })

  it('sorts by creation time in both directions', () => {
    expect(ids({ filter: '', sortKey: 'created', direction: 'asc' })).toEqual(['b', 'c', 'a'])
    expect(ids({ filter: '', sortKey: 'created', direction: 'desc' })).toEqual(['a', 'c', 'b'])
  })

  it('sorts by update time in both directions', () => {
    expect(ids({ filter: '', sortKey: 'updated', direction: 'asc' })).toEqual(['c', 'a', 'b'])
    expect(ids({ filter: '', sortKey: 'updated', direction: 'desc' })).toEqual(['b', 'a', 'c'])
  })

  it('reverses the backlog order when descending', () => {
    expect(ids({ filter: '', sortKey: 'backlog', direction: 'desc' })).toEqual(['c', 'b', 'a'])
  })

  it('combines filtering with sorting', () => {
    // 'e' appears in every task's title or purpose, so all three survive and get sorted.
    expect(ids({ filter: 'e', sortKey: 'title', direction: 'desc' })).toEqual(['c', 'a', 'b'])
    expect(ids({ filter: 'alpha', sortKey: 'created', direction: 'asc' })).toEqual(['b'])
  })
})

describe('defaultDirection', () => {
  it('starts date sorts newest-first and text sorts A-to-Z', () => {
    expect(defaultDirection('created')).toBe('desc')
    expect(defaultDirection('updated')).toBe('desc')
    expect(defaultDirection('title')).toBe('asc')
    expect(defaultDirection('backlog')).toBe('asc')
  })
})

describe('isManualOrderView', () => {
  it('is true only for the unfiltered ascending backlog view', () => {
    expect(isManualOrderView(DEFAULT_TASK_LIST_VIEW)).toBe(true)
    expect(isManualOrderView({ ...DEFAULT_TASK_LIST_VIEW, filter: 'x' })).toBe(false)
    expect(isManualOrderView({ ...DEFAULT_TASK_LIST_VIEW, direction: 'desc' })).toBe(false)
    expect(isManualOrderView({ ...DEFAULT_TASK_LIST_VIEW, sortKey: 'title' })).toBe(false)
  })

  it('treats a whitespace-only filter as blank', () => {
    expect(isManualOrderView({ ...DEFAULT_TASK_LIST_VIEW, filter: '   ' })).toBe(true)
  })
})
