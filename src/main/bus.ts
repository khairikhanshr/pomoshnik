// In-process event bus that decouples the assistant / tools from Electron windows.
// The IPC layer (src/main/ipc) forwards bus events to renderer windows.
import { EventEmitter } from 'node:events'
import type { AssistantState, ChatEvent, Settings, SpeakChunk } from '@shared/types'
import type { SpeechDoneReport } from '@shared/ipc'

export interface BusEvents {
  chat: ChatEvent
  'assistant-state': AssistantState
  /** Chunk of a reply to speak (forwarded to the voice window). */
  speak: SpeakChunk
  'stop-speaking': void
  /** Mic / speaker level 0..1 (forwarded to the overlay). */
  level: number
  /** Ask the voice window to start recording a command. */
  listen: void
  /** Voice window finished (or aborted) speaking a turn. */
  'speech-done': SpeechDoneReport
  'settings-changed': Settings
}

type Listener<T> = (payload: T) => void

export class AppBus {
  private readonly emitter = new EventEmitter()
  private state: AssistantState = { phase: 'idle', wakeActive: false, updatedAt: Date.now() }

  constructor() {
    this.emitter.setMaxListeners(50)
  }

  on<K extends keyof BusEvents>(event: K, cb: Listener<BusEvents[K]>): () => void {
    this.emitter.on(event, cb as Listener<unknown>)
    return () => this.emitter.off(event, cb as Listener<unknown>)
  }

  emit<K extends keyof BusEvents>(event: K, ...payload: BusEvents[K] extends void ? [] : [BusEvents[K]]): void {
    this.emitter.emit(event, payload[0])
  }

  getState(): AssistantState {
    return this.state
  }

  /** Merge a patch into the assistant state and broadcast it. `undefined` values clear fields. */
  patchState(patch: Partial<AssistantState>): AssistantState {
    const next: AssistantState = { ...this.state, ...patch, updatedAt: Date.now() }
    for (const key of Object.keys(patch) as (keyof AssistantState)[]) {
      if (patch[key] === undefined) delete next[key]
    }
    this.state = next
    this.emit('assistant-state', next)
    return next
  }
}
