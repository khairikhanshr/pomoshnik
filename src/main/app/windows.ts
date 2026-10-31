// WindowService: the main window (chats + settings), the overlay HUD and the hidden voice-engine window.
import { app, BrowserWindow, screen, shell, type WebContents, type WebPreferences } from 'electron'
import { IPC_EVENT } from '@shared/ipc'
import type { NavigateRequest } from '@shared/types'
import type { AppBus } from '../bus'
import { createLogger } from '../log'
import type { SettingsStore, WindowService } from '../services'
import { createOverlayController } from './overlay-controller'
import { OVERLAY_SIZE, overlayBounds } from './overlay-position'
import { hideForCapture, hideTiming } from './ui-hide'
import { isSafeExternalUrl } from './urls'

const log = createLogger('windows')
const rendererLog = createLogger('renderer')

export type WindowKind = 'main' | 'overlay' | 'voice'

const PAGES: Record<WindowKind, string> = { main: 'index', overlay: 'overlay', voice: 'voice' }
const BACKGROUND = '#05080d'
/** Height of the main window's header in the UI (--header-h in src/renderer/src/main/styles/app.css). */
const HEADER_HEIGHT = 52
const VOICE_QUEUE_LIMIT = 100
const VOICE_QUEUE_MAX_AGE_MS = 15_000
const VOICE_MAX_RESTARTS = 5
const VOICE_RESTART_WINDOW_MS = 5 * 60_000

export interface WindowServiceOptions {
  settings: SettingsStore
  bus: AppBus
  preloadPath: string
  /** app://jarvis in production, the Vite dev server in development (no trailing slash). */
  rendererBaseUrl: string
  /** Whether a URL belongs to our own pages (navigation inside the app is allowed). */
  isAppUrl(url: string): boolean
  platform: NodeJS.Platform
  /** JARVIS_SHOW_VOICE=1 */
  showVoiceWindow: boolean
  isQuitting(): boolean
  /** The main window was hidden: 'close' = the user closed it, 'hide' = hideMain() (hotkey, tools). Not called for withUiHidden. */
  onMainHidden?(reason: 'close' | 'hide'): void
  onMainShown?(): void
  /** Windows: the OS session is ending (shutdown / log-off); no before-quit follows. */
  onSessionEnd?(): void
}

export interface AppWindows extends WindowService {
  /** Creates the main window; `show: false` keeps it hidden (start in the tray). */
  createMain(show: boolean): void
  ensureOverlay(): void
  ensureVoice(): void
  sendTo(kind: WindowKind, channel: string, payload?: unknown): void
  /** Which Jarvis window owns these webContents, if any. */
  kindOf(contents: WebContents): WindowKind | null
  dispose(): void
}

function alive(win: BrowserWindow | null): win is BrowserWindow {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed()
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!alive(win) || win.webContents.isCrashed()) return
  try {
    win.webContents.send(channel, payload)
  } catch (err) {
    log.debug(`send ${channel} failed`, err)
  }
}

export function openExternalSafe(url: unknown): void {
  if (!isSafeExternalUrl(url)) {
    log.warn('blocked opening a non-http(s) URL')
    return
  }
  shell.openExternal(url).catch((err) => log.warn('openExternal failed', err))
}

export function createWindowService(opts: WindowServiceOptions): AppWindows {
  const isMac = opts.platform === 'darwin'
  let main: BrowserWindow | null = null
  let mainReady = false
  /** did-finish-load happened and React had time to register its IPC listeners. */
  let mainListening = false
  let mainShowPending = false
  let pendingNav: NavigateRequest | null = null
  const mainCrashes: number[] = []

  let overlay: BrowserWindow | null = null

  let voice: BrowserWindow | null = null
  let voiceLoaded = false
  const voiceQueue: Array<{ channel: string; payload: unknown; at: number }> = []
  const voiceRestarts: number[] = []
  let voiceRestartTimer: NodeJS.Timeout | null = null
  let voiceGaveUp = false

  let hideDepth = 0
  let disposed = false

  const pageUrl = (kind: WindowKind): string => `${opts.rendererBaseUrl}/${PAGES[kind]}.html?window=${kind}`

  function webPreferences(extra: WebPreferences = {}): WebPreferences {
    return {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      ...extra
    }
  }

  function harden(kind: WindowKind, wc: WebContents): void {
    wc.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event) => {
      if (opts.isAppUrl(event.url)) return
      event.preventDefault()
      openExternalSafe(event.url)
    })
    wc.on('will-redirect', (event) => {
      if (event.isMainFrame && !opts.isAppUrl(event.url)) event.preventDefault()
    })
    wc.on('will-attach-webview', (event) => event.preventDefault())
    wc.on('console-message', (details) => {
      const text = `[${kind}] ${details.message} (${details.sourceId}:${details.lineNumber})`
      if (details.level === 'error') rendererLog.warn(text)
      else rendererLog.debug(text)
    })
    wc.on('preload-error', (_event, preloadPath, error) => log.error(`[${kind}] preload ${preloadPath} failed`, error))
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) log.error(`[${kind}] failed to load ${url}: ${description} (${code})`)
    })
    wc.on('unresponsive', () => log.warn(`[${kind}] renderer is unresponsive`))
  }

  function load(kind: WindowKind, win: BrowserWindow): void {
    win.loadURL(pageUrl(kind)).catch((err) => log.error(`[${kind}] loadURL failed`, err))
  }

  // ---------- main window ----------

  function revealMain(): void {
    const win = main
    if (!alive(win)) return
    mainShowPending = false
    if (isMac) app.dock?.show().catch(() => {})
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (isMac) app.focus({ steal: true })
    opts.onMainShown?.()
  }

  function deliverNav(): void {
    if (!pendingNav || !alive(main) || !mainListening || main.webContents.isLoading()) return
    const nav = pendingNav
    pendingNav = null
    send(main, IPC_EVENT.navigate, nav)
  }

  function createMain(show: boolean): void {
    if (alive(main)) {
      if (show) showMain()
      return
    }
    const win = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 860,
      minHeight: 560,
      show: false,
      title: 'Jarvis',
      backgroundColor: BACKGROUND,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      // Window controls aligned with the UI's 52 px header: macOS traffic lights centred in it (the UI
      // keeps a 74 px inset for them), Windows caption buttons as tall as it (144 px inset on the right).
      ...(isMac
        ? { trafficLightPosition: { x: 18, y: 20 } }
        : { titleBarOverlay: { color: BACKGROUND, symbolColor: '#9fe9ff', height: HEADER_HEIGHT } }),
      autoHideMenuBar: true,
      webPreferences: webPreferences()
    })
    main = win
    mainReady = false
    mainListening = false
    mainShowPending = show
    harden('main', win.webContents)

    win.once('ready-to-show', () => {
      mainReady = true
      if (mainShowPending) revealMain()
    })
    if (show) {
      // Show anyway if the first paint never happens (e.g. a renderer error).
      setTimeout(() => {
        if (main === win && mainShowPending && alive(win) && !win.isVisible()) revealMain()
      }, 4000).unref()
    }
    win.on('close', (event) => {
      if (opts.isQuitting()) return
      event.preventDefault()
      userHideMain('close')
    })
    win.on('closed', () => {
      if (main === win) main = null
    })
    win.on('session-end', () => opts.onSessionEnd?.())
    win.webContents.on('did-start-loading', () => {
      if (main === win) mainListening = false
    })
    win.webContents.on('did-finish-load', () => {
      // React registers its IPC listeners in effects that run shortly after the load event.
      setTimeout(() => {
        if (main !== win || win.webContents.isLoading()) return
        mainListening = true
        deliverNav()
      }, 300).unref()
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      log.error(`main renderer gone: ${details.reason} (${details.exitCode})`)
      if (opts.isQuitting() || details.reason === 'clean-exit' || main !== win) return
      const now = Date.now()
      while (mainCrashes.length && now - mainCrashes[0] > 60_000) mainCrashes.shift()
      if (mainCrashes.length >= 3) return
      mainCrashes.push(now)
      win.webContents.reload()
    })
    load('main', win)
  }

  function userHideMain(reason: 'close' | 'hide'): void {
    const win = main
    if (!alive(win)) return
    mainShowPending = false
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => {
        if (alive(win)) win.hide()
      })
      win.setFullScreen(false)
    } else {
      win.hide()
    }
    opts.onMainHidden?.(reason)
  }

  function isMainVisible(): boolean {
    return alive(main) && main.isVisible() && !main.isMinimized()
  }

  function showMain(nav?: NavigateRequest): void {
    if (nav) pendingNav = nav
    if (!alive(main)) createMain(true)
    else if (!mainReady) mainShowPending = true
    else revealMain()
    deliverNav()
  }

  // ---------- overlay ----------

  function ensureOverlay(): BrowserWindow {
    if (alive(overlay)) return overlay
    const win = new BrowserWindow({
      width: OVERLAY_SIZE.width,
      height: OVERLAY_SIZE.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Jarvis',
      // NSPanel-style window: floats over full-screen apps without activating Jarvis.
      ...(isMac ? { type: 'panel' } : {}),
      webPreferences: webPreferences({ spellcheck: false })
    })
    overlay = win
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    harden('overlay', win.webContents)
    win.on('close', (event) => {
      if (opts.isQuitting()) return
      event.preventDefault()
      win.hide()
    })
    win.on('closed', () => {
      if (overlay === win) overlay = null
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      log.error(`overlay renderer gone: ${details.reason}`)
      if (opts.isQuitting() || overlay !== win) return
      overlay = null
      win.destroy() // recreated on the next show
    })
    load('overlay', win)
    return win
  }

  function placeOverlay(win: BrowserWindow): void {
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      win.setBounds(overlayBounds(display.workArea, opts.settings.get().overlayPosition))
    } catch (err) {
      log.warn('cannot position the overlay', err)
    }
  }

  function showOverlayWindow(): void {
    const win = ensureOverlay()
    if (!win.isVisible()) placeOverlay(win)
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  }

  const overlayIsVisible = (): boolean => alive(overlay) && overlay.isVisible()

  const overlayCtl = createOverlayController({
    isEnabled: () => opts.settings.get().showOverlay,
    isSuppressed: () => hideDepth > 0,
    isVisible: overlayIsVisible,
    show: showOverlayWindow,
    hide: () => {
      if (alive(overlay)) overlay.hide()
    }
  })

  // ---------- voice engine ----------

  function flushVoiceQueue(): void {
    const now = Date.now()
    const items = voiceQueue.splice(0)
    for (const item of items) {
      if (now - item.at <= VOICE_QUEUE_MAX_AGE_MS) send(voice, item.channel, item.payload)
    }
  }

  function scheduleVoiceRestart(reason: string): void {
    if (voiceRestartTimer || voiceGaveUp || disposed || opts.isQuitting()) return
    const now = Date.now()
    while (voiceRestarts.length && now - voiceRestarts[0] > VOICE_RESTART_WINDOW_MS) voiceRestarts.shift()
    const phase = opts.bus.getState().phase
    const voicePhase = phase === 'wake' || phase === 'listening' || phase === 'transcribing' || phase === 'speaking'
    if (voiceRestarts.length >= VOICE_MAX_RESTARTS) {
      voiceGaveUp = true
      log.error('the voice engine keeps crashing; not restarting it again')
      opts.bus.patchState({
        wakeActive: false,
        engineError: 'Голосовой движок несколько раз аварийно завершился и остановлен. Перезапустите Джарвис.',
        ...(voicePhase ? { phase: 'idle' as const } : {})
      })
      return
    }
    opts.bus.patchState({ wakeActive: false, ...(voicePhase ? { phase: 'idle' as const } : {}) })
    const wait = Math.min(30_000, 1000 * 2 ** voiceRestarts.length)
    voiceRestarts.push(now)
    log.warn(`restarting the voice engine in ${wait} ms (${reason})`)
    voiceRestartTimer = setTimeout(() => {
      voiceRestartTimer = null
      if (!opts.isQuitting() && !disposed) ensureVoice()
    }, wait)
  }

  function ensureVoice(): void {
    if (alive(voice)) return
    const visible = opts.showVoiceWindow
    const win = new BrowserWindow({
      width: 560,
      height: 460,
      show: false,
      title: 'Jarvis — голосовой движок',
      skipTaskbar: !visible,
      focusable: visible,
      backgroundColor: BACKGROUND,
      webPreferences: webPreferences({ backgroundThrottling: false, spellcheck: false })
    })
    voice = win
    voiceLoaded = false
    harden('voice', win.webContents)
    if (visible) win.once('ready-to-show', () => win.showInactive())
    win.on('close', (event) => {
      if (opts.isQuitting()) return
      event.preventDefault()
      win.hide()
    })
    win.on('closed', () => {
      if (voice !== win) return
      voice = null
      voiceLoaded = false
      scheduleVoiceRestart('window closed')
    })
    win.webContents.on('did-start-loading', () => {
      if (voice === win) voiceLoaded = false
    })
    win.webContents.on('did-finish-load', () => {
      if (voice !== win) return
      voiceLoaded = true
      flushVoiceQueue()
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      log.error(`voice engine renderer gone: ${details.reason} (${details.exitCode})`)
      if (opts.isQuitting() || voice !== win) return
      voice = null
      voiceLoaded = false
      win.destroy()
      scheduleVoiceRestart(details.reason)
    })
    load('voice', win)
  }

  function sendToVoice(channel: string, payload?: unknown): void {
    if (alive(voice) && voiceLoaded) {
      send(voice, channel, payload)
      return
    }
    voiceQueue.push({ channel, payload, at: Date.now() })
    if (voiceQueue.length > VOICE_QUEUE_LIMIT) voiceQueue.shift()
  }

  // ---------- shared ----------

  const offState = opts.bus.on('assistant-state', (state) => overlayCtl.onPhase(state.phase))
  const offSettings = opts.settings.onChange((next, prev) => {
    if (next.showOverlay !== prev.showOverlay) overlayCtl.setEnabled(next.showOverlay)
    if (next.overlayPosition !== prev.overlayPosition && alive(overlay) && overlay.isVisible()) placeOverlay(overlay)
  })

  const windowOf = (kind: WindowKind): BrowserWindow | null =>
    kind === 'main' ? main : kind === 'overlay' ? overlay : voice

  const captureTiming = hideTiming(opts.platform)

  async function withUiHidden<T>(fn: () => Promise<T>): Promise<T> {
    if (hideDepth > 0) {
      hideDepth++
      try {
        return await fn()
      } finally {
        hideDepth--
      }
    }
    hideDepth++
    let hidden: Awaited<ReturnType<typeof hideForCapture>> | null = null
    try {
      // Resolves only once the windows are really off the screen, so captures never contain them.
      hidden = await hideForCapture(
        {
          restorable: [isMainVisible() ? main : null, opts.showVoiceWindow ? voice : null],
          hideOnly: [overlayIsVisible() ? overlay : null]
        },
        captureTiming
      )
      return await fn()
    } finally {
      hideDepth--
      try {
        hidden?.restore()
      } catch (err) {
        log.warn('cannot restore windows after the capture', err)
      }
      // The HUD comes back (repositioned) only while the assistant is still busy.
      overlayCtl.resume()
    }
  }

  return {
    createMain,
    ensureOverlay: () => void ensureOverlay(),
    ensureVoice,
    showMain,
    hideMain: () => userHideMain('hide'),
    toggleMain() {
      if (isMainVisible() && main?.isFocused()) userHideMain('hide')
      else showMain()
    },
    isMainVisible,
    getMainWindow: () => (alive(main) ? main : null),
    showOverlay: () => overlayCtl.showExplicit(),
    hideOverlay: () => overlayCtl.dismiss(),
    withUiHidden,
    sendToVoice,
    broadcast(channel, payload) {
      for (const win of [main, overlay, voice]) send(win, channel, payload)
    },
    sendTo(kind, channel, payload) {
      if (kind === 'voice') sendToVoice(channel, payload)
      else send(windowOf(kind), channel, payload)
    },
    kindOf(contents) {
      for (const kind of ['main', 'overlay', 'voice'] as const) {
        const win = windowOf(kind)
        if (alive(win) && win.webContents.id === contents.id) return kind
      }
      return null
    },
    dispose() {
      disposed = true
      offState()
      offSettings()
      overlayCtl.dispose()
      if (voiceRestartTimer) clearTimeout(voiceRestartTimer)
      voiceRestartTimer = null
    }
  }
}
