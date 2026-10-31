// macOS privacy (TCC) checks for screenshots and synthetic input.
import { shell, systemPreferences } from 'electron'
import { ToolError } from '../errors'

const PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
} as const

export function openPrivacyPane(kind: keyof typeof PANES): void {
  if (process.env.JARVIS_E2E) return
  shell.openExternal(PANES[kind]).catch(() => {})
}

/** Throws unless Jarvis may post keyboard / mouse events. Shows the system prompt once per call. */
export function ensureAccessibility(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') return
  if (systemPreferences.isTrustedAccessibilityClient(false)) return
  if (!process.env.JARVIS_E2E) systemPreferences.isTrustedAccessibilityClient(true)
  throw new ToolError(
    'macOS Accessibility permission is required to control the keyboard and mouse. The system prompt was shown: ' +
      'the user must enable Jarvis in System Settings → Privacy & Security → Accessibility and then repeat the request.',
    'Нужно разрешение «Универсальный доступ»'
  )
}

/** Throws (and opens the Privacy pane) unless screen capture is allowed. */
export function ensureScreenAccess(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') return
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted') return
  openPrivacyPane('screen')
  throw new ToolError(
    `macOS Screen Recording permission is not granted (status: ${status}). The Privacy & Security → Screen & System Audio ` +
      'Recording settings were opened: the user must enable Jarvis there, then quit and reopen Jarvis.',
    'Нужно разрешение «Запись экрана»'
  )
}
