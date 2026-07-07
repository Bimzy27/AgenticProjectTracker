import type { TrackerBridge } from '../shared/ipc'

declare global {
  interface Window {
    tracker: TrackerBridge
  }
}

export {}
