// OS integration: launch at login, start hidden, macOS Dock icon, App Nap prevention, first-close hint.
import { app, Notification, powerSaveBlocker } from 'electron'
import type { Settings } from '@shared/types'
import { createLogger } from '../log'
import type { SettingsStore, WindowService } from '../services'
import type { AppStateStore } from '../store/app-state'

const log = createLogger('system')

export interface SystemOptions {
  platform: NodeJS.Platform
  settings: SettingsStore
  windows: WindowService
  appState: AppStateStore
  /** JARVIS_E2E: no login-item changes, no notifications. */
  e2e: boolean
}

export interface SystemIntegration {
  /** The main window was hidden; the background hint is shown only after the user closed it. */
  onMainHidden(reason: 'close' | 'hide'): void
  onMainShown(): void
  /** Applies settings.showInDock for the current main-window visibility (e.g. after starting hidden). */
  refreshDock(): void
  dispose(): void
}

/** Packaged builds only: an unpackaged run would register the bare Electron binary at login. */
function applyLoginItem(platform: NodeJS.Platform, enabled: boolean): void {
  try {
    if (platform === 'win32') app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    else app.setLoginItemSettings({ openAtLogin: enabled })
  } catch (err) {
    log.warn('cannot change the login item', err)
  }
}

export function shouldStartHidden(settings: Settings, opts: { platform: NodeJS.Platform; hiddenArg: boolean }): boolean {
  if (settings.startHidden || opts.hiddenArg) return true
  if (opts.platform !== 'darwin' || !app.isPackaged) return false
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin
  } catch {
    return false
  }
}

export function createSystemIntegration(opts: SystemOptions): SystemIntegration {
  const isMac = opts.platform === 'darwin'
  const manageLoginItem = app.isPackaged && !opts.e2e
  let blockerId: number | null = null

  function syncLoginItem(enabled: boolean): void {
    if (manageLoginItem) applyLoginItem(opts.platform, enabled)
  }

  // Keeps the hidden voice window's audio pipeline from being throttled by App Nap / power saving.
  function syncPowerBlocker(wakeOn: boolean): void {
    if (wakeOn && blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension')
      log.info('power save blocker started')
    } else if (!wakeOn && blockerId !== null) {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
      blockerId = null
      log.info('power save blocker stopped')
    }
  }

  function syncDock(): void {
    if (!isMac || !app.dock) return
    const show = opts.settings.get().showInDock || opts.windows.isMainVisible()
    if (show) app.dock.show().catch(() => {})
    else app.dock.hide()
  }

  function showCloseHint(): void {
    if (opts.e2e || opts.appState.get('closeHintShown')) return
    opts.appState.set('closeHintShown', true)
    try {
      if (!Notification.isSupported()) return
      new Notification({
        title: 'Джарвис',
        body: isMac
          ? 'Джарвис продолжает работать в фоне. Он в строке меню.'
          : 'Джарвис продолжает работать в фоне. Он в области уведомлений.',
        silent: true
      }).show()
    } catch (err) {
      log.warn('cannot show the notification', err)
    }
  }

  const initial = opts.settings.get()
  syncLoginItem(initial.launchAtLogin)
  syncPowerBlocker(initial.wakeEngine !== 'off')

  const off = opts.settings.onChange((next, prev) => {
    if (next.launchAtLogin !== prev.launchAtLogin) syncLoginItem(next.launchAtLogin)
    if ((next.wakeEngine !== 'off') !== (prev.wakeEngine !== 'off')) syncPowerBlocker(next.wakeEngine !== 'off')
    if (next.showInDock !== prev.showInDock) syncDock()
  })

  return {
    onMainHidden(reason) {
      if (reason === 'close') showCloseHint()
      syncDock()
    },
    onMainShown: syncDock,
    refreshDock: syncDock,
    dispose() {
      off()
      syncPowerBlocker(false)
    }
  }
}
