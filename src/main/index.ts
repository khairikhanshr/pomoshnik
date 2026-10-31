// Main-process entry: environment overrides, single instance, service wiring and app lifecycle.
import { app, globalShortcut, session } from 'electron'
import { join, resolve } from 'node:path'
import { createAiServices, type AiDeps, type AiServices } from './ai'
import { readEnv } from './app/env'
import { unavailableAi, unavailableTools } from './app/fallbacks'
import { setupApplicationMenu } from './app/menu'
import { createPermissionService, installSessionPermissionHandlers } from './app/permissions'
import { registerProtocolHandlers, registerSchemes } from './app/protocol'
import { createShortcuts } from './app/shortcuts'
import { createSystemIntegration, shouldStartHidden, type SystemIntegration } from './app/system'
import { createTray } from './app/tray'
import { appOrigins, isAppUrl, rendererBaseUrl } from './app/urls'
import { createWakeToggle } from './app/wake'
import { APP_NAME, resolveAppVersion } from './app/version'
import { createWindowService } from './app/windows'
import { settingsEntryNav } from './app/navigation'
import { AppBus } from './bus'
import { startBusForwarding } from './ipc/forward'
import { registerIpcHandlers } from './ipc/handlers'
import { createLogger, initLogFile } from './log'
import { createAppStateStore } from './store/app-state'
import { createChatStore } from './store/chats'
import { downscaleImage } from './store/image-tools'
import { createMediaStore } from './store/media'
import { createSafeStorageCipher, plainCipher } from './store/secret-cipher'
import { createSecretStore } from './store/secrets'
import { createSettingsStore } from './store/settings'
import { createToolRegistry } from './tools'
import type { ToolHost, ToolRegistry } from './tools/types'
import { createVoiceBridge } from './voice-bridge'

const log = createLogger('main')
const env = readEnv(process.env, process.argv, app.isPackaged)
// The logger checks the variable for presence; make JARVIS_DEBUG=0 mean "off".
if (!env.debug) delete process.env.JARVIS_DEBUG

let quitting = false
const cleanups: Array<() => void> = []

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function createTools(host: ToolHost): ToolRegistry & { dispose(): void } {
  try {
    return createToolRegistry(host)
  } catch (err) {
    log.error('tool registry failed to start', err)
    return unavailableTools(errorText(err))
  }
}

function createAi(deps: AiDeps): AiServices {
  try {
    return createAiServices(deps)
  } catch (err) {
    log.error('AI services failed to start', err)
    return unavailableAi(errorText(err))
  }
}

function runCleanups(): void {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup()
    } catch (err) {
      log.warn('cleanup failed', err)
    }
  }
}

async function start(): Promise<void> {
  const userData = app.getPath('userData')
  const appVersion = resolveAppVersion()
  initLogFile(join(userData, 'logs'))
  log.info(
    `Jarvis ${appVersion} starting: ${process.platform}/${process.arch}, Electron ${process.versions.electron}` +
      `${app.isPackaged ? '' : ', unpackaged'}${env.e2e ? ', E2E mode' : ''}`
  )
  const platform = process.platform
  const origins = appOrigins(env.rendererUrl)

  // ---------- stores ----------
  const appState = createAppStateStore(userData)
  const settings = createSettingsStore(userData, {
    overrides: env.openaiBaseUrl ? { baseUrl: env.openaiBaseUrl } : undefined
  })
  if (env.e2e) log.info('E2E mode: secrets are stored without OS encryption')
  const secrets = createSecretStore(userData, {
    // E2E runs must never touch the Keychain / DPAPI.
    cipher: env.e2e ? plainCipher : createSafeStorageCipher(),
    overrides: { openaiApiKey: env.apiKey, elevenlabsKey: env.elevenLabsKey }
  })
  const bus = new AppBus()
  const media = createMediaStore(join(userData, 'media'), { downscale: downscaleImage })
  const chats = createChatStore(join(userData, 'chats'), {
    onEvent: (ev) => bus.emit('chat', ev),
    onRemoveMedia: (ids) => ids.forEach((id) => media.remove(id)),
    defaultTier: () => settings.get().defaultTier
  })
  cleanups.push(() => chats.flush())

  // ---------- protocols & permissions ----------
  registerProtocolHandlers({ rendererDir: join(__dirname, '../renderer'), media })
  const permissions = createPermissionService({ platform, e2e: env.e2e })
  installSessionPermissionHandlers(session.defaultSession, {
    origins,
    // Without a fake capture device an E2E run would trigger the macOS microphone prompt.
    allowMicrophone: () => !env.e2e || app.commandLine.hasSwitch('use-fake-device-for-media-stream')
  })

  // ---------- windows ----------
  let system: SystemIntegration | null = null
  const windows = createWindowService({
    settings,
    bus,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererBaseUrl: rendererBaseUrl(env.rendererUrl),
    isAppUrl: (url) => isAppUrl(url, origins),
    platform,
    showVoiceWindow: env.showVoice,
    isQuitting: () => quitting,
    onMainHidden: (reason) => system?.onMainHidden(reason),
    onMainShown: () => system?.onMainShown(),
    onSessionEnd: () => {
      quitting = true
      runCleanups()
    }
  })
  cleanups.push(() => windows.dispose())

  // ---------- tools & AI ----------
  const toolHost: ToolHost = { settings, media, windows, bus, userDataDir: userData, platform }
  const tools = createTools(toolHost)
  cleanups.push(() => tools.dispose())
  const ai = createAi({ settings, secrets, chats, media, tools, bus, userDataDir: userData })

  // ---------- wiring ----------
  const listen = (): void => bus.emit('listen')
  const wake = createWakeToggle({ settings, appState, windows })
  cleanups.push(() => wake.dispose())
  const voice = createVoiceBridge({ bus, windows, assistant: ai.assistant })
  cleanups.push(() => voice.dispose())
  cleanups.push(startBusForwarding(bus, windows))
  const ipc = registerIpcHandlers({
    settings,
    secrets,
    chats,
    media,
    windows,
    bus,
    ai,
    toolHost,
    voice,
    permissions,
    platform,
    appVersion,
    origins,
    tmpDir: join(app.getPath('temp'), 'jarvis-import'),
    setWakeEnabled: (enabled) => wake.setEnabled(enabled),
    listen,
    quit: () => app.quit()
  })
  cleanups.push(() => ipc.dispose())

  // ---------- OS integration ----------
  system = createSystemIntegration({ platform, settings, windows, appState, e2e: env.e2e })
  const systemRef = system
  cleanups.push(() => systemRef.dispose())
  const openSettings = (): void => windows.showMain(settingsEntryNav(!!secrets.getApiKey()))
  setupApplicationMenu(platform, openSettings)
  const tray = createTray({
    platform,
    settings,
    windows,
    bus,
    onListen: listen,
    onSettings: openSettings,
    setWakeEnabled: (enabled) => wake.setEnabled(enabled),
    onQuit: () => app.quit()
  })
  cleanups.push(() => tray.dispose())
  const shortcuts = createShortcuts({ settings, onVoice: listen, onWindow: () => windows.toggleMain() })
  cleanups.push(() => shortcuts.dispose())

  app.on('second-instance', () => windows.showMain())
  app.on('activate', () => windows.showMain())

  // ---------- windows ----------
  const startHidden = shouldStartHidden(settings.get(), { platform, hiddenArg: env.hiddenArg })
  windows.createMain(!startHidden)
  if (startHidden) system.refreshDock()
  windows.ensureOverlay()
  // Ask for the microphone (macOS) before the voice engine opens it.
  permissions
    .ensureMicrophone()
    .catch((err) => log.warn('microphone permission check failed', err))
    .finally(() => windows.ensureVoice())

  if (secrets.getApiKey()) ipc.refreshModels()
  // E2E runs (JARVIS_E2E=1) drive window behaviour that has no IPC surface, e.g. withUiHidden.
  if (env.e2e) Object.assign(globalThis, { __jarvisE2E: { windows, bus } })
  log.info(`ready${startHidden ? ' (hidden)' : ''}`)
}

// Same name (and default userData folder) in packaged, `electron .` and direct-script runs.
app.setName(APP_NAME)
if (env.userDataDir) app.setPath('userData', resolve(env.userDataDir))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  registerSchemes()
  if (process.platform === 'win32') app.setAppUserModelId('com.pomoshnik.jarvis')

  process.on('uncaughtException', (err) => log.error('uncaught exception', err))
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit())

  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') log.warn(`${details.type} process gone: ${details.reason}`)
  })
  // Jarvis lives in the tray / menu bar: closing windows never quits the app.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    runCleanups()
    globalShortcut.unregisterAll()
    log.info('bye')
  })

  app
    .whenReady()
    .then(start)
    .catch((err) => {
      log.error('startup failed', err)
      app.exit(1)
    })
}
