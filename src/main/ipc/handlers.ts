// ipcMain handlers for every channel of src/shared/ipc.ts, plus PublicSettings broadcasts.
import { dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { IPC, IPC_EVENT, IPC_SEND } from '@shared/ipc'
import type { ModelsListResult, SynthesizeResult, TestConnectionResult } from '@shared/ipc'
import type { ImageRef, PublicSettings } from '@shared/types'
import type { AiServices } from '../ai'
import type { AppWindows } from '../app/windows'
import type { PermissionService } from '../app/permissions'
import { isAppUrl, isSafeExternalUrl } from '../app/urls'
import type { AppBus } from '../bus'
import { createLogger } from '../log'
import type { ChatStore, MediaStore, SecretStore, SettingsStore } from '../services'
import { prepareImportedImage } from '../store/image-tools'
import { captureScreen, type ToolHost } from '../tools'
import { newId } from '../util/fs'
import type { VoiceBridge } from '../voice-bridge'
import { buildPublicSettings } from './public-settings'
import { buildReplayChunks } from './replay'
import {
  asBinary,
  asBoolean,
  asChatId,
  asMime,
  asNavigate,
  asOptionalTier,
  asPermissionKind,
  asSecretKey,
  asSendRequest,
  asSettingsPatch,
  asText,
  asTier,
  asTitle,
  isAudioMime,
  isImageMime,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES
} from './validate'

const log = createLogger('ipc')

const PICK_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'bmp', 'tif', 'tiff']
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heic',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

export interface IpcDeps {
  settings: SettingsStore
  secrets: SecretStore
  chats: ChatStore
  media: MediaStore
  windows: AppWindows
  bus: AppBus
  ai: AiServices
  toolHost: ToolHost
  voice: VoiceBridge
  permissions: PermissionService
  platform: NodeJS.Platform
  appVersion: string
  /** Our page origins; requests from anything else are rejected. */
  origins: readonly string[]
  /** Scratch directory for image conversions. */
  tmpDir: string
  setWakeEnabled(enabled: boolean): void
  listen(): void
  quit(): void
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return 'Неизвестная ошибка.'
}

export interface IpcHandlers {
  /** Re-fetches the model list in the background, then broadcasts the new PublicSettings. */
  refreshModels(): void
  dispose(): void
}

export function registerIpcHandlers(deps: IpcDeps): IpcHandlers {
  const { settings, secrets, chats, media, windows, bus, ai } = deps
  const invokeChannels: string[] = []
  const sendChannels: string[] = []

  function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    const url = event.senderFrame?.url
    return !!url && isAppUrl(url, deps.origins)
  }

  function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    invokeChannels.push(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) {
        log.warn(`${channel}: rejected request from ${event.senderFrame?.url ?? 'unknown frame'}`)
        throw new Error('Запрос отклонён: недоверенный источник.')
      }
      try {
        return await fn(...args)
      } catch (err) {
        const message = errorMessage(err)
        log.warn(`${channel} failed: ${message}`)
        throw new Error(message)
      }
    })
  }

  function on(channel: string, fn: (...args: unknown[]) => void): void {
    sendChannels.push(channel)
    ipcMain.on(channel, (event, ...args) => {
      if (!trusted(event)) return
      try {
        fn(...args)
      } catch (err) {
        log.warn(`${channel} failed`, err)
      }
    })
  }

  // ---------- settings ----------

  const publicSettings = (): PublicSettings =>
    buildPublicSettings({
      settings: settings.get(),
      secrets,
      resolvedModels: () => ai.models.resolvedAll(),
      platform: deps.platform,
      appVersion: deps.appVersion
    })

  const broadcastSettings = (): void => windows.broadcast(IPC_EVENT.settingsChanged, publicSettings())

  function refreshModels(): void {
    ai.models
      .refresh()
      .catch((err) => log.warn('model list refresh failed', err))
      .finally(broadcastSettings)
  }

  let lastApiKey = secrets.getApiKey()
  const offSettings = settings.onChange((next, prev) => {
    bus.emit('settings-changed', next)
    broadcastSettings()
    if (next.baseUrl !== prev.baseUrl || next.apiMode !== prev.apiMode) refreshModels()
  })
  const offSecrets = secrets.onChange(() => {
    const key = secrets.getApiKey()
    if (key !== lastApiKey) {
      lastApiKey = key
      refreshModels()
    } else {
      broadcastSettings()
    }
  })

  handle(IPC.settingsGet, () => publicSettings())
  handle(IPC.settingsUpdate, (patch) => {
    settings.update(asSettingsPatch(patch))
    return publicSettings()
  })
  handle(IPC.settingsSetApiKey, (key) => {
    secrets.setApiKey(asSecretKey(key))
    return publicSettings()
  })
  handle(IPC.settingsClearApiKey, () => {
    secrets.setApiKey(null)
    return publicSettings()
  })
  handle(IPC.settingsSetElevenLabsKey, (key) => {
    secrets.setElevenLabsKey(asSecretKey(key))
    return publicSettings()
  })
  handle(IPC.settingsClearElevenLabsKey, () => {
    secrets.setElevenLabsKey(null)
    return publicSettings()
  })
  handle(IPC.settingsReset, () => {
    settings.reset()
    return publicSettings()
  })

  // ---------- models ----------

  handle(IPC.modelsList, async (force): Promise<ModelsListResult> => {
    try {
      const models = await ai.models.list(force === true)
      broadcastSettings() // resolution of 'auto' tiers may have changed
      return { models }
    } catch (err) {
      return { models: [], error: errorMessage(err) }
    }
  })
  handle(IPC.modelsTest, async (): Promise<TestConnectionResult> => {
    try {
      return await ai.assistant.testConnection()
    } catch (err) {
      return { ok: false, message: errorMessage(err) }
    }
  })

  // ---------- chats ----------

  function cancelTurnIn(chatId?: string): void {
    const turn = ai.assistant.currentTurn()
    if (turn && (!chatId || turn.chatId === chatId)) ai.assistant.cancel(turn.turnId)
  }

  handle(IPC.chatsList, () => chats.list())
  handle(IPC.chatsGet, (id) => (typeof id === 'string' ? chats.get(id) : null))
  handle(IPC.chatsCreate, (opts) => {
    const tier = asOptionalTier((opts as { tier?: unknown } | undefined)?.tier) ?? settings.get().defaultTier
    return chats.create({ tier, source: 'text' })
  })
  handle(IPC.chatsRename, (id, title) => chats.rename(asChatId(id), asTitle(title)))
  handle(IPC.chatsSetTier, (id, tier) => chats.setTier(asChatId(id), asTier(tier)))
  handle(IPC.chatsRemove, (id) => {
    const chatId = asChatId(id)
    cancelTurnIn(chatId)
    chats.remove(chatId)
  })
  handle(IPC.chatsClearAll, () => {
    cancelTurnIn()
    chats.clearAll()
  })
  handle(IPC.chatsSearch, (query) => chats.search(asText(query, { max: 500 })))
  handle(IPC.chatsSend, async (raw) => {
    const req = asSendRequest(raw)
    if (req.chatId && !chats.summary(req.chatId)) throw new Error('Чат не найден. Возможно, он был удалён.')
    for (const id of req.images ?? []) {
      if (!media.ref(id)) throw new Error('Прикреплённое изображение не найдено. Прикрепите его ещё раз.')
    }
    return ai.assistant.send({ ...req, source: 'text' })
  })
  handle(IPC.chatsCancel, (turnId) => ai.assistant.cancel(typeof turnId === 'string' && turnId ? turnId : undefined))

  // ---------- media ----------

  async function importImage(data: Buffer, mime: string): Promise<ImageRef> {
    const prepared = await prepareImportedImage(data, mime, deps.tmpDir)
    return media.save(prepared.data, {
      kind: 'upload',
      mime: prepared.mime,
      width: prepared.width,
      height: prepared.height
    })
  }

  handle(IPC.mediaCaptureScreen, () => captureScreen(deps.toolHost))
  handle(IPC.mediaImportImage, (data, mime) =>
    importImage(
      asBinary(data, MAX_IMAGE_BYTES, 'Изображение больше 20 МБ.'),
      asMime(mime, isImageMime, 'изображения')
    )
  )
  handle(IPC.mediaPickImage, async () => {
    const options: OpenDialogOptions = {
      title: 'Выберите изображение',
      properties: ['openFile'],
      filters: [{ name: 'Изображения', extensions: PICK_EXTENSIONS }]
    }
    const parent = windows.getMainWindow()
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const file = result.filePaths[0]
    if (result.canceled || !file) return null
    const info = await stat(file)
    if (!info.isFile()) throw new Error('Выберите файл изображения.')
    if (info.size > MAX_IMAGE_BYTES) throw new Error('Изображение больше 20 МБ.')
    return importImage(await readFile(file), MIME_BY_EXTENSION[extname(file).toLowerCase()] ?? 'image/png')
  })

  // ---------- speech ----------

  handle(IPC.speechTranscribe, (audio, mime) =>
    ai.speech.transcribe(asBinary(audio, MAX_AUDIO_BYTES, 'Аудио больше 25 МБ.'), asMime(mime, isAudioMime, 'аудио'))
  )
  handle(IPC.speechSynthesize, async (text): Promise<SynthesizeResult> => {
    const { data, mime } = await ai.speech.synthesize(asText(text, { allowEmpty: false }))
    return { audio: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mime }
  })
  handle(IPC.speechListElevenLabsVoices, async () => {
    try {
      return { voices: await ai.speech.listElevenLabsVoices() }
    } catch (err) {
      return { voices: [], error: errorMessage(err) }
    }
  })
  handle(IPC.speechSpeak, (text) => {
    const value = asText(text, { allowEmpty: false })
    const chunks = buildReplayChunks(value, `replay-${newId()}`)
    if (!chunks.length) return
    bus.emit('stop-speaking')
    // The HUD shows what is being read, not the previous turn's reply (a running turn keeps its own).
    if (!ai.assistant.currentTurn()) {
      bus.patchState({ response: value.slice(0, 4000), transcript: undefined, toolTitle: undefined, error: undefined })
    }
    for (const chunk of chunks) bus.emit('speak', chunk)
  })
  handle(IPC.speechStop, () => bus.emit('stop-speaking'))

  // ---------- assistant / voice ----------

  handle(IPC.assistantGetState, () => bus.getState())
  handle(IPC.assistantListen, () => deps.listen())
  handle(IPC.assistantSetWake, (enabled) => deps.setWakeEnabled(asBoolean(enabled)))

  handle(IPC.voiceSubmit, (text) => deps.voice.submit(text))
  on(IPC_SEND.voicePhase, (report) => deps.voice.reportPhase(report))
  on(IPC_SEND.voiceLevel, (level) => deps.voice.reportLevel(level))
  on(IPC_SEND.voiceSpeechDone, (report) => deps.voice.speechDone(report))
  on(IPC_SEND.voiceLog, (level, message) => deps.voice.log(level, message))

  // ---------- app ----------

  handle(IPC.appShowMain, (nav) => windows.showMain(asNavigate(nav)))
  handle(IPC.appHideOverlay, () => windows.hideOverlay())
  handle(IPC.appGetPermissions, () => deps.permissions.status())
  handle(IPC.appRequestPermission, (kind) => deps.permissions.request(asPermissionKind(kind)))
  handle(IPC.appOpenPermissionSettings, (kind) => deps.permissions.openSettings(asPermissionKind(kind)))
  handle(IPC.appOpenExternal, async (url) => {
    if (!isSafeExternalUrl(url)) throw new Error('Можно открывать только ссылки http, https и mailto.')
    await shell.openExternal(url)
  })
  // Reply first, then quit, so the renderer's promise settles.
  handle(IPC.appQuit, () => void setImmediate(() => deps.quit()))

  return {
    refreshModels,
    dispose() {
      offSettings()
      offSecrets()
      for (const channel of invokeChannels) ipcMain.removeHandler(channel)
      for (const channel of sendChannels) ipcMain.removeAllListeners(channel)
    }
  }
}
