// Hiding Jarvis' own windows while the screen is captured (electron-free: BrowserWindow-like objects
// are injected, so the timing logic is unit-tested).

export interface HideableWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  hide(): void
  showInactive(): void
  focus(): void
  once(event: 'hide', listener: () => void): unknown
  removeListener(event: 'hide', listener: () => void): unknown
}

export interface HideTiming {
  /**
   * Max wait for a window's 'hide' event. On macOS Electron reports it from the occlusion-state
   * notification, i.e. once the window server has really taken the window off the screen.
   */
  hideTimeoutMs: number
  /** Extra time for the compositor to repaint the uncovered area before the capture. */
  settleMs: number
}

export function hideTiming(platform: NodeJS.Platform): HideTiming {
  // Windows emits 'hide' synchronously while DWM still plays the ~200 ms fade-out animation.
  return platform === 'win32' ? { hideTimeoutMs: 500, settleMs: 300 } : { hideTimeoutMs: 500, settleMs: 100 }
}

/** Hides the window and resolves once it reported 'hide' (or after the timeout). */
export function hideAndWait(win: HideableWindow, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || !win.isVisible()) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (!win.isDestroyed()) win.removeListener('hide', done)
      resolve()
    }
    win.once('hide', done)
    timer = setTimeout(done, timeoutMs)
    try {
      win.hide()
    } catch {
      done()
    }
  })
}

export interface HiddenWindows {
  /** Shows the windows again without activating Jarvis over another app. */
  restore(): void
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Hides the visible windows and resolves when they are really gone from the screen (each reported
 * 'hide', plus a short compositor delay). `restore()` shows the `restorable` ones again; windows in
 * `hideOnly` (the overlay HUD, which has its own show logic) are left to the caller.
 */
export async function hideForCapture(
  windows: { restorable: ReadonlyArray<HideableWindow | null | undefined>; hideOnly?: ReadonlyArray<HideableWindow | null | undefined> },
  timing: HideTiming
): Promise<HiddenWindows> {
  const isShown = (w: HideableWindow | null | undefined): w is HideableWindow => !!w && !w.isDestroyed() && w.isVisible()
  const restorable = windows.restorable.filter(isShown)
  const others = (windows.hideOnly ?? []).filter(isShown)
  const focused = restorable.find((w) => w.isFocused()) ?? null
  const all = [...restorable, ...others]
  if (all.length) {
    await Promise.all(all.map((w) => hideAndWait(w, timing.hideTimeoutMs)))
    await wait(timing.settleMs)
  }
  return {
    restore() {
      for (const win of restorable) {
        if (win.isDestroyed() || win.isVisible()) continue
        // showInactive never activates the app; show() would (activateIgnoringOtherApps on macOS).
        win.showInactive()
      }
      // focus() asks politely: macOS does not activate us over another app, Windows applies its
      // foreground lock. It only gives the window back the focus it had before the capture.
      if (focused && !focused.isDestroyed() && focused.isVisible()) focused.focus()
    }
  }
}
