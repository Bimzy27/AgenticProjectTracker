import type { TaskDefinition } from './domain'

/** Sort keys offered by the task list; 'backlog' is the manual arrangement agents pull from. */
export type TaskSortKey = 'backlog' | 'created' | 'updated' | 'title'

/** Sort direction; 'asc' on the backlog key is the manual order, reversible like the rest. */
export type TaskSortDirection = 'asc' | 'desc'

/** UI state describing how a task list is filtered and sorted. */
export interface TaskListView {
  /** Case-insensitive text matched against title and purpose; blank matches everything. */
  filter: string
  sortKey: TaskSortKey
  direction: TaskSortDirection
}

/** The view every task list starts in: everything shown, manual backlog order. */
export const DEFAULT_TASK_LIST_VIEW: TaskListView = {
  filter: '',
  sortKey: 'backlog',
  direction: 'asc'
}

/** Natural direction when switching to a sort key: newest first for dates, A to Z for text. */
export function defaultDirection(sortKey: TaskSortKey): TaskSortDirection {
  return sortKey === 'created' || sortKey === 'updated' ? 'desc' : 'asc'
}

/**
 * True when the view shows the plain manual backlog order, the only
 * arrangement in which position-based reordering controls make sense.
 */
export function isManualOrderView(view: TaskListView): boolean {
  return view.sortKey === 'backlog' && view.direction === 'asc' && view.filter.trim() === ''
}

/** Apply the view's text filter and sort to a task list. The input array is not mutated. */
export function applyTaskListView(tasks: readonly TaskDefinition[], view: TaskListView): TaskDefinition[] {
  const needle = view.filter.trim().toLowerCase()
  const filtered = needle
    ? tasks.filter((t) => t.title.toLowerCase().includes(needle) || t.purpose.toLowerCase().includes(needle))
    : [...tasks]
  const sign = view.direction === 'desc' ? -1 : 1
  return filtered.sort((a, b) => sign * compare(a, b, view.sortKey))
}

function compare(a: TaskDefinition, b: TaskDefinition, key: TaskSortKey): number {
  switch (key) {
    case 'backlog':
      return a.order - b.order
    case 'created':
      // ISO-8601 timestamps (always written via toISOString) compare lexicographically.
      return a.createdAt.localeCompare(b.createdAt)
    case 'updated':
      return a.updatedAt.localeCompare(b.updatedAt)
    case 'title':
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
  }
}
