// When the overlay HUD is shown / hidden (electron-free; the window operations are injected).
import type { AssistantPhase } from '@shared/types'

export const OVERLAY_IDLE_HIDE_MS = 5000
export const OVERLAY_ERROR_HIDE_MS = 8000
/** Explicit show (hotkey / tray) without any activity following, e.g. the voice engine is not running. */
export const OVERLAY_EXPLICIT_HIDE_MS = 8000

export interface OverlayControllerDeps {
  /** settings.showOverlay */
  isEnabled(): boolean
  /** Jarvis windows are temporarily hidden (screenshot in progress). */
  isSuppressed(): boolean
  isVisible(): boolean
  /** Position on the display under the cursor and show without taking focus. */
  show(): void
  hide(): void
}

export interface OverlayController {
  onPhase(phase: AssistantPhase): void
  /** Hotkey / tray / voice listen: show now even if the user closed it during this activity. */
  showExplicit(): void
  /** The user closed the HUD: keep it hidden until the assistant is idle again. */
  dismiss(): void
  setEnabled(enabled: boolean): void
  /** Windows were restored after withUiHidden. */
  resume(): void
  dispose(): void
}

const isActive = (phase: AssistantPhase): boolean => phase !== 'idle' && phase !== 'error'

export function createOverlayController(deps: OverlayControllerDeps): OverlayController {
  let phase: AssistantPhase = 'idle'
  let dismissed = false
  let hideTimer: NodeJS.Timeout | null = null

  function cancelHide(): void {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
  }

  function scheduleHide(ms: number): void {
    cancelHide()
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (!isActive(phase)) deps.hide()
    }, ms)
  }

  function ensureShown(): void {
    if (!deps.isEnabled() || deps.isSuppressed() || deps.isVisible()) return
    deps.show()
  }

  return {
    onPhase(next) {
      const prev = phase
      phase = next
      if (isActive(next)) {
        cancelHide()
        if (!dismissed) ensureShown()
        return
      }
      if (next === 'idle') dismissed = false
      if (!deps.isVisible()) {
        cancelHide()
        return
      }
      if (prev !== next || !hideTimer) scheduleHide(next === 'error' ? OVERLAY_ERROR_HIDE_MS : OVERLAY_IDLE_HIDE_MS)
    },

    showExplicit() {
      if (!deps.isEnabled()) return
      dismissed = false
      if (!deps.isSuppressed() && !deps.isVisible()) deps.show()
      if (isActive(phase)) cancelHide()
      else scheduleHide(OVERLAY_EXPLICIT_HIDE_MS)
    },

    dismiss() {
      cancelHide()
      deps.hide()
      if (isActive(phase)) dismissed = true
    },

    setEnabled(enabled) {
      if (enabled) {
        if (isActive(phase) && !dismissed) ensureShown()
        return
      }
      cancelHide()
      deps.hide()
    },

    resume() {
      if (isActive(phase) && !dismissed) ensureShown()
    },

    dispose: cancelHide
  }
}
