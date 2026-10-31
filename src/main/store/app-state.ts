// Internal app flags that are not user settings: userData/app-state.json (electron-free).
import { join } from 'node:path'
import { createLogger } from '../log'
import { readJson, writeJsonAtomic } from '../util/fs'

const log = createLogger('app-state')

export interface AppState {
  /** The "Джарвис продолжает работать в фоне" notification was shown. */
  closeHintShown?: boolean
  /** Wake engine to restore when voice activation is switched back on. */
  lastWakeEngine?: 'local' | 'cloud'
}

export interface AppStateStore {
  get<K extends keyof AppState>(key: K): AppState[K]
  set<K extends keyof AppState>(key: K, value: AppState[K]): void
}

function sanitize(raw: unknown): AppState {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const state: AppState = {}
  if (typeof src.closeHintShown === 'boolean') state.closeHintShown = src.closeHintShown
  if (src.lastWakeEngine === 'local' || src.lastWakeEngine === 'cloud') state.lastWakeEngine = src.lastWakeEngine
  return state
}

export function createAppStateStore(dir: string): AppStateStore {
  const file = join(dir, 'app-state.json')
  const state = sanitize(readJson(file))
  return {
    get: (key) => state[key],
    set(key, value) {
      if (state[key] === value) return
      if (value === undefined) delete state[key]
      else state[key] = value
      try {
        writeJsonAtomic(file, state)
      } catch (err) {
        log.warn('cannot save app state', err)
      }
    }
  }
}
