// OS privacy permissions (macOS mostly; Windows reports 'granted' where not applicable) and the
// Chromium permission handlers of the default session.
import { desktopCapturer, shell, systemPreferences, type Session } from 'electron'
import type { PermissionKind, PermissionsStatus, PermissionState } from '@shared/types'
import { createLogger } from '../log'
import { isAppUrl } from './urls'

const log = createLogger('permissions')

const MAC_PANES: Record<PermissionKind, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
}
const WIN_MIC_SETTINGS = 'ms-settings:privacy-microphone'

export interface PermissionService {
  status(): PermissionsStatus
  /** Shows the OS prompt where possible (or opens the settings pane); never prompts in E2E mode. */
  request(kind: PermissionKind): Promise<PermissionsStatus>
  openSettings(kind: PermissionKind): Promise<void>
  /** macOS: ask for the microphone once before the voice engine starts (skipped in E2E mode). */
  ensureMicrophone(): Promise<void>
}

export interface PermissionServiceOptions {
  platform: NodeJS.Platform
  /** JARVIS_E2E: never show prompts or open System Settings. */
  e2e: boolean
}

function mediaStatus(kind: 'microphone' | 'screen'): PermissionState {
  try {
    return systemPreferences.getMediaAccessStatus(kind)
  } catch (err) {
    log.warn(`getMediaAccessStatus(${kind}) failed`, err)
    return 'unknown'
  }
}

export function createPermissionService(opts: PermissionServiceOptions): PermissionService {
  const isMac = opts.platform === 'darwin'
  const isWin = opts.platform === 'win32'

  function status(): PermissionsStatus {
    if (isMac) {
      let accessibility: PermissionState = 'unknown'
      try {
        accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
      } catch (err) {
        log.warn('isTrustedAccessibilityClient failed', err)
      }
      return { microphone: mediaStatus('microphone'), screen: mediaStatus('screen'), accessibility }
    }
    if (isWin) return { microphone: mediaStatus('microphone'), screen: 'granted', accessibility: 'granted' }
    return { microphone: 'granted', screen: 'granted', accessibility: 'granted' }
  }

  async function openSettings(kind: PermissionKind): Promise<void> {
    if (opts.e2e) return
    const url = isMac ? MAC_PANES[kind] : isWin && kind === 'microphone' ? WIN_MIC_SETTINGS : null
    if (!url) return
    try {
      await shell.openExternal(url)
    } catch (err) {
      log.warn(`cannot open settings for ${kind}`, err)
    }
  }

  async function request(kind: PermissionKind): Promise<PermissionsStatus> {
    const current = status()
    if (opts.e2e || current[kind] === 'granted') return current
    if (isMac) {
      try {
        if (kind === 'microphone') {
          if (current.microphone === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
          else await openSettings('microphone')
        } else if (kind === 'screen') {
          // Listing screens registers the app in the Screen Recording list and shows the system prompt once.
          if (current.screen === 'not-determined') {
            await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
          } else {
            await openSettings('screen')
          }
        } else {
          systemPreferences.isTrustedAccessibilityClient(true)
        }
      } catch (err) {
        log.warn(`permission request for ${kind} failed`, err)
      }
    } else if (isWin && kind === 'microphone') {
      await openSettings('microphone')
    }
    return status()
  }

  return {
    status,
    request,
    openSettings,
    async ensureMicrophone() {
      if (!isMac || opts.e2e) return
      if (mediaStatus('microphone') !== 'not-determined') return
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone')
        log.info(`microphone access ${granted ? 'granted' : 'denied'}`)
      } catch (err) {
        log.warn('askForMediaAccess failed', err)
      }
    }
  }
}

export interface SessionPermissionOptions {
  /** Our page origins (app://jarvis, dev server). */
  origins: readonly string[]
  /** Whether renderers may open the microphone at all (false in E2E runs without a fake device). */
  allowMicrophone(): boolean
}

/** Allow microphone (audio only) and clipboard writes for our own pages; deny everything else. */
export function installSessionPermissionHandlers(ses: Session, opts: SessionPermissionOptions): void {
  const ours = (url: string | undefined): boolean => !!url && isAppUrl(url, opts.origins)

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const fromUs = ours(details.requestingUrl)
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      const audioOnly = types.length > 0 && types.every((t) => t === 'audio')
      const allowed = fromUs && audioOnly && opts.allowMicrophone()
      if (!allowed) log.info(`media request denied (${types.join(',') || 'none'}) from ${details.requestingUrl}`)
      callback(allowed)
      return
    }
    if (permission === 'clipboard-sanitized-write') {
      callback(fromUs)
      return
    }
    log.debug(`permission ${permission} denied for ${details.requestingUrl}`)
    callback(false)
  })

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const fromUs = ours(requestingOrigin) || ours(details.requestingUrl) || ours(details.securityOrigin)
    if (permission === 'media') return fromUs && details.mediaType !== 'video' && opts.allowMicrophone()
    if (permission === 'clipboard-sanitized-write') return fromUs
    return false
  })

  ses.setDevicePermissionHandler(() => false)
}
