import { BrowserWindow, ipcMain } from 'electron'
import { EVENT_CHANNEL, INVOKE_CHANNEL } from '@shared/ipc'
import type { TrackerApi, TrackerEventName, TrackerEvents } from '@shared/ipc'

/** Broadcast a typed event to every open window. */
export function emitTrackerEvent<E extends TrackerEventName>(event: E, payload: TrackerEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(EVENT_CHANNEL, event, payload)
  }
}

/** Register the single invoke channel that dispatches to the TrackerApi implementation. */
export function registerTrackerApi(api: TrackerApi): void {
  ipcMain.handle(INVOKE_CHANNEL, async (_event, method: string, args: unknown[]) => {
    const fn = api[method as keyof TrackerApi]
    if (typeof fn !== 'function') {
      throw new Error(`Unknown tracker method: ${method}`)
    }
    return (fn as (...a: unknown[]) => unknown).apply(api, args)
  })
}
