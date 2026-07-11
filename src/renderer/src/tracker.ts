// Single access point to the tracker bridge. Everything in the renderer goes
// through this module so a future web build can swap the transport (D2).
import { useEffect } from 'react'
import type { TrackerBridge, TrackerEventName, TrackerEvents } from '@shared/ipc'

export const tracker: TrackerBridge = window.tracker

/** Subscribe to a tracker event for the lifetime of the component. */
export function useTrackerEvent<E extends TrackerEventName>(
  event: E,
  listener: (payload: TrackerEvents[E]) => void
): void {
  useEffect(() => tracker.on(event, listener), [event, listener])
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'unknown'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return 'unknown'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/** Compact token counts: 950, 12.4k, 1.2M. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '–'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}
