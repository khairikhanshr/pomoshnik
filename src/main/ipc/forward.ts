// Forwards bus events to renderer windows (speak / stop-speaking / listen go through the voice bridge).
import { IPC_EVENT } from '@shared/ipc'
import type { AppBus } from '../bus'
import type { WindowKind } from '../app/windows'
import { createThrottle } from './throttle'

/** Level updates for the orb animation: at most 20 per second. */
const LEVEL_INTERVAL_MS = 50

export interface ForwardTargets {
  broadcast(channel: string, payload?: unknown): void
  sendTo(kind: WindowKind, channel: string, payload?: unknown): void
}

export function startBusForwarding(bus: AppBus, windows: ForwardTargets): () => void {
  const level = createThrottle<number>(LEVEL_INTERVAL_MS, (value) => {
    windows.sendTo('overlay', IPC_EVENT.level, value)
    windows.sendTo('main', IPC_EVENT.level, value)
  })
  const offs = [
    bus.on('chat', (ev) => windows.broadcast(IPC_EVENT.chatEvent, ev)),
    bus.on('assistant-state', (state) => windows.broadcast(IPC_EVENT.assistantState, state)),
    bus.on('level', (value) => level.push(value))
  ]
  return () => {
    for (const off of offs) off()
    level.cancel()
  }
}
