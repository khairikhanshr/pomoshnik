// Tray / menu bar icon and its menu.
import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import { TIER_INFO } from '@shared/defaults'
import { TIERS } from '@shared/types'
import type { AppBus } from '../bus'
import { createLogger } from '../log'
import type { SettingsStore, WindowService } from '../services'
import { checkAccelerator } from './accelerator'
import { loadTrayIcons } from './tray-icon'

const log = createLogger('tray')

export interface TrayOptions {
  platform: NodeJS.Platform
  settings: SettingsStore
  windows: WindowService
  /** Switches to the active icon while the assistant is busy. */
  bus: AppBus
  onListen(): void
  /** "Настройки…": opens the settings view (on the AI tab while there is no API key). */
  onSettings(): void
  setWakeEnabled(enabled: boolean): void
  onQuit(): void
}

export interface AppTray {
  dispose(): void
}

export function createTray(opts: TrayOptions): AppTray {
  const isMac = opts.platform === 'darwin'
  let tray: Tray | null = null
  const icons = loadTrayIcons(opts.platform)
  try {
    tray = new Tray(icons.idle)
  } catch (err) {
    log.error('cannot create the tray icon', err)
    return { dispose: () => {} }
  }

  function buildMenu(): Menu {
    const s = opts.settings.get()
    const wakeOn = s.wakeEngine !== 'off'
    const listenAccelerator = s.hotkeyVoice && checkAccelerator(s.hotkeyVoice).valid ? s.hotkeyVoice : undefined
    const template: MenuItemConstructorOptions[] = [
      { label: 'Открыть Джарвис', click: () => opts.windows.showMain() },
      { label: 'Слушать', accelerator: listenAccelerator, registerAccelerator: false, click: () => opts.onListen() },
      { type: 'separator' },
      {
        label: 'Голосовая активация',
        type: 'checkbox',
        checked: wakeOn,
        click: (item) => opts.setWakeEnabled(item.checked)
      },
      {
        label: 'Модель по умолчанию',
        submenu: TIERS.map((tier) => ({
          label: `${TIER_INFO[tier].label} — ${TIER_INFO[tier].subtitle}`,
          type: 'radio' as const,
          checked: s.defaultTier === tier,
          click: () => opts.settings.update({ defaultTier: tier })
        }))
      },
      { type: 'separator' },
      {
        label: 'Настройки…',
        accelerator: isMac ? 'Command+,' : undefined,
        registerAccelerator: false,
        click: () => opts.onSettings()
      },
      { type: 'separator' },
      { label: 'Выход', accelerator: isMac ? 'Command+Q' : undefined, registerAccelerator: false, click: () => opts.onQuit() }
    ]
    return Menu.buildFromTemplate(template)
  }

  function refresh(): void {
    if (!tray || tray.isDestroyed()) return
    try {
      const s = opts.settings.get()
      tray.setContextMenu(buildMenu())
      tray.setToolTip(
        s.wakeEngine === 'off'
          ? 'Джарвис — голосовая активация выключена'
          : `Джарвис — слушаю «${s.wakePhrases[0] ?? 'джарвис'}»`
      )
    } catch (err) {
      log.error('cannot update the tray menu', err)
    }
  }

  refresh()
  // Windows / Linux: a left click opens the main window (macOS shows the menu).
  if (!isMac) tray.on('click', () => opts.windows.showMain())

  const off = opts.settings.onChange((next, prev) => {
    if (
      next.wakeEngine !== prev.wakeEngine ||
      next.defaultTier !== prev.defaultTier ||
      next.hotkeyVoice !== prev.hotkeyVoice ||
      next.wakePhrases.join() !== prev.wakePhrases.join()
    ) {
      refresh()
    }
  })

  let showingActive = false
  const offState = opts.bus.on('assistant-state', (state) => {
    const active = state.phase !== 'idle' && state.phase !== 'error'
    if (active === showingActive || !tray || tray.isDestroyed()) return
    showingActive = active
    try {
      tray.setImage(active ? icons.active : icons.idle)
    } catch (err) {
      log.warn('cannot change the tray icon', err)
    }
  })

  return {
    dispose() {
      off()
      offState()
      if (tray && !tray.isDestroyed()) tray.destroy()
      tray = null
    }
  }
}
