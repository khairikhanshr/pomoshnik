// Voice activation on/off (tray, UI pill, assistant:set-wake): remembers the last engine that was on.
import { IPC_EVENT } from '@shared/ipc'
import type { SettingsStore, WindowService } from '../services'
import type { AppStateStore } from '../store/app-state'

export interface WakeToggle {
  setEnabled(enabled: boolean): void
  dispose(): void
}

export function createWakeToggle(deps: {
  settings: SettingsStore
  appState: AppStateStore
  windows: Pick<WindowService, 'sendToVoice'>
}): WakeToggle {
  const { settings, appState, windows } = deps
  const initial = settings.get().wakeEngine
  if (initial !== 'off') appState.set('lastWakeEngine', initial)

  // On/off transitions reach the voice window through the settingsChanged broadcast (with the engine
  // to use). A voiceSetWake sent here would arrive first and make the engine guess from the old settings
  // ('off' → local), e.g. briefly loading Whisper when the remembered engine is 'cloud'.
  const off = settings.onChange((next) => {
    if (next.wakeEngine !== 'off') appState.set('lastWakeEngine', next.wakeEngine)
  })

  return {
    setEnabled(enabled) {
      const current = settings.get().wakeEngine
      if (enabled && current === 'off') settings.update({ wakeEngine: appState.get('lastWakeEngine') ?? 'local' })
      else if (!enabled && current !== 'off') settings.update({ wakeEngine: 'off' })
      // Already in the requested state: tell the engine again (it may have stopped after an error).
      else windows.sendToVoice(IPC_EVENT.voiceSetWake, enabled)
    },
    dispose: off
  }
}
