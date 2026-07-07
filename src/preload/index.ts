import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNEL, INVOKE_CHANNEL } from '@shared/ipc'
import type { TrackerBridge, TrackerEventName, TrackerEvents } from '@shared/ipc'

type Listener = (payload: unknown) => void

const listeners = new Map<TrackerEventName, Set<Listener>>()

ipcRenderer.on(EVENT_CHANNEL, (_ipcEvent, event: TrackerEventName, payload: unknown) => {
  listeners.get(event)?.forEach((listener) => listener(payload))
})

const bridge: TrackerBridge = {
  invoke: ((method: string, ...args: unknown[]) =>
    ipcRenderer.invoke(INVOKE_CHANNEL, method, args)) as TrackerBridge['invoke'],
  on<E extends TrackerEventName>(event: E, listener: (payload: TrackerEvents[E]) => void) {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(listener as Listener)
    return () => {
      set.delete(listener as Listener)
    }
  }
}

contextBridge.exposeInMainWorld('tracker', bridge)
