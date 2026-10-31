// Sandboxed preload: exposes window.jarvis (JarvisApi) on top of ipcRenderer. Only 'electron' is
// required at runtime; the shared channel constants are bundled in.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, IPC_EVENT, IPC_SEND, type JarvisApi, type Unsubscribe } from '@shared/ipc'
import type { Platform } from '@shared/types'

/** ipcMain.handle errors arrive as "Error invoking remote method 'x': Error: <message>". */
function cleanError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const message = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(\w*Error):\s*/, '')
  return new Error(message || 'Неизвестная ошибка.')
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((err: unknown) => {
    throw cleanError(err)
  }) as Promise<T>
}

function send(channel: string, ...args: unknown[]): void {
  ipcRenderer.send(channel, ...args)
}

/** Each subscription gets its own listener so the returned function removes exactly that one. */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const platform: Platform =
  process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'

const api: JarvisApi = {
  platform,

  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch),
    setApiKey: (key) => invoke(IPC.settingsSetApiKey, key),
    clearApiKey: () => invoke(IPC.settingsClearApiKey),
    setElevenLabsKey: (key) => invoke(IPC.settingsSetElevenLabsKey, key),
    clearElevenLabsKey: () => invoke(IPC.settingsClearElevenLabsKey),
    reset: () => invoke(IPC.settingsReset),
    onChanged: (cb) => subscribe(IPC_EVENT.settingsChanged, cb)
  },

  models: {
    list: (force) => invoke(IPC.modelsList, force === true),
    test: () => invoke(IPC.modelsTest)
  },

  chats: {
    list: () => invoke(IPC.chatsList),
    get: (id) => invoke(IPC.chatsGet, id),
    create: (opts) => invoke(IPC.chatsCreate, opts ?? {}),
    rename: (id, title) => invoke(IPC.chatsRename, id, title),
    setTier: (id, tier) => invoke(IPC.chatsSetTier, id, tier),
    remove: (id) => invoke(IPC.chatsRemove, id),
    clearAll: () => invoke(IPC.chatsClearAll),
    search: (query) => invoke(IPC.chatsSearch, query),
    send: (req) => invoke(IPC.chatsSend, req),
    cancel: (turnId) => invoke(IPC.chatsCancel, turnId),
    onEvent: (cb) => subscribe(IPC_EVENT.chatEvent, cb)
  },

  media: {
    captureScreen: () => invoke(IPC.mediaCaptureScreen),
    importImage: (data, mime) => invoke(IPC.mediaImportImage, data, mime),
    pickImage: () => invoke(IPC.mediaPickImage)
  },

  speech: {
    transcribe: (audio, mime) => invoke(IPC.speechTranscribe, audio, mime),
    synthesize: (text) => invoke(IPC.speechSynthesize, text),
    listElevenLabsVoices: () => invoke(IPC.speechListElevenLabsVoices),
    speak: (text) => invoke(IPC.speechSpeak, text),
    stop: () => invoke(IPC.speechStop)
  },

  assistant: {
    getState: () => invoke(IPC.assistantGetState),
    onState: (cb) => subscribe(IPC_EVENT.assistantState, cb),
    onLevel: (cb) => subscribe(IPC_EVENT.level, cb),
    listen: () => invoke(IPC.assistantListen),
    setWakeEnabled: (enabled) => invoke(IPC.assistantSetWake, enabled)
  },

  voice: {
    submit: (text) => invoke(IPC.voiceSubmit, text),
    reportPhase: (report) => send(IPC_SEND.voicePhase, report),
    reportLevel: (level) => send(IPC_SEND.voiceLevel, level),
    reportSpeechDone: (report) => send(IPC_SEND.voiceSpeechDone, report),
    log: (level, message) => send(IPC_SEND.voiceLog, level, message),
    onSpeak: (cb) => subscribe(IPC_EVENT.voiceSpeak, cb),
    onStopSpeaking: (cb) => subscribe<void>(IPC_EVENT.voiceStopSpeaking, () => cb()),
    onListen: (cb) => subscribe<void>(IPC_EVENT.voiceListen, () => cb()),
    onSetWake: (cb) => subscribe(IPC_EVENT.voiceSetWake, cb)
  },

  app: {
    showMain: (nav) => invoke(IPC.appShowMain, nav),
    hideOverlay: () => invoke(IPC.appHideOverlay),
    getPermissions: () => invoke(IPC.appGetPermissions),
    requestPermission: (kind) => invoke(IPC.appRequestPermission, kind),
    openPermissionSettings: (kind) => invoke(IPC.appOpenPermissionSettings, kind),
    openExternal: (url) => invoke(IPC.appOpenExternal, url),
    quit: () => invoke(IPC.appQuit),
    onNavigate: (cb) => subscribe(IPC_EVENT.navigate, cb)
  }
}

contextBridge.exposeInMainWorld('jarvis', api)
