// Global hotkeys from settings (hotkeyVoice → listen, hotkeyWindow → toggle the main window).
import { globalShortcut } from 'electron'
import { createLogger } from '../log'
import type { SettingsStore } from '../services'
import { checkAccelerator } from './accelerator'

const log = createLogger('shortcuts')

/** Ignore auto-repeat while a hotkey is held down (Windows repeats RegisterHotKey events). */
const REPEAT_GUARD_MS = 400

export interface ShortcutOptions {
  settings: SettingsStore
  onVoice(): void
  onWindow(): void
}

export interface AppShortcuts {
  /** Accelerators that are currently registered. */
  registered(): string[]
  dispose(): void
}

export function createShortcuts(opts: ShortcutOptions): AppShortcuts {
  const active = new Set<string>()

  function guarded(action: () => void): () => void {
    let last = 0
    return () => {
      const now = Date.now()
      if (now - last < REPEAT_GUARD_MS) return
      last = now
      try {
        action()
      } catch (err) {
        log.error('hotkey action failed', err)
      }
    }
  }

  function unregisterAll(): void {
    for (const acc of active) {
      try {
        globalShortcut.unregister(acc)
      } catch (err) {
        log.debug(`unregister ${acc} failed`, err)
      }
    }
    active.clear()
  }

  function registerAll(): void {
    unregisterAll()
    const s = opts.settings.get()
    const bindings: Array<[string, string, () => void]> = [
      ['hotkeyVoice', s.hotkeyVoice, opts.onVoice],
      ['hotkeyWindow', s.hotkeyWindow, opts.onWindow]
    ]
    for (const [name, raw, action] of bindings) {
      const acc = raw.trim()
      if (!acc) continue
      const check = checkAccelerator(acc)
      if (!check.valid) {
        log.warn(`${name} "${acc}" ignored: ${check.reason}`)
        continue
      }
      if ([...active].some((a) => a.toLowerCase() === acc.toLowerCase())) {
        log.warn(`${name} "${acc}" is already used by another Jarvis hotkey`)
        continue
      }
      try {
        if (globalShortcut.register(acc, guarded(action))) active.add(acc)
        else log.warn(`${name} "${acc}" is taken by another application`)
      } catch (err) {
        log.warn(`${name} "${acc}" is not a valid accelerator`, err)
      }
    }
    log.info(`hotkeys registered: ${[...active].join(', ') || 'none'}`)
  }

  registerAll()
  const off = opts.settings.onChange((next, prev) => {
    if (next.hotkeyVoice !== prev.hotkeyVoice || next.hotkeyWindow !== prev.hotkeyWindow) registerAll()
  })

  return {
    registered: () => [...active],
    dispose() {
      off()
      unregisterAll()
    }
  }
}
