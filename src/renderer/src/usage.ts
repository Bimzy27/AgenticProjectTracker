// Shared formatting for Claude usage windows, used by the About view and the
// sidebar usage bars so both render identical labels.
import type { ClaudeUsageWindow } from '@shared/domain'

/** Human label for a usage window reported by the account API. */
export function windowLabel(window: ClaudeUsageWindow): string {
  if (window.kind === 'session') return 'Session (5-hour window)'
  if (window.kind === 'weekly_all') return 'Weekly - all models'
  if (window.scope) return `Weekly - ${window.scope}`
  return window.kind
}

/** " · resets <local date>" suffix, or empty when the reset time is unknown. */
export function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return ''
  return ` · resets ${date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}`
}
