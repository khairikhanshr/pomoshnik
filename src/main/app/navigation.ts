// Navigation requests main sends to the main window (tray, app menu, notifications).
// Tab ids are shared with the settings view (SETTINGS_TAB_IDS in src/shared/types.ts).
import type { NavigateRequest, SettingsTabId } from '@shared/types'

/** Opens the settings view, optionally on a specific tab. */
export function settingsNav(tab?: SettingsTabId): NavigateRequest {
  return tab ? { view: 'settings', settingsTab: tab } : { view: 'settings' }
}

/** "Настройки…" (tray / app menu): without an API key the AI tab is the only useful place. */
export function settingsEntryNav(hasApiKey: boolean): NavigateRequest {
  return settingsNav(hasApiKey ? undefined : 'ai')
}
