// Pure validation of values coming from renderers over IPC. Errors carry Russian messages for the UI.
import type { SendChatRequest, SpeechDoneReport } from '@shared/ipc'
import { isSettingsTabId, TIERS } from '@shared/types'
import type {
  AssistantPhase,
  NavigateRequest,
  PermissionKind,
  SettingsPatch,
  Tier,
  VoicePhaseReport
} from '@shared/types'
import { CHAT_ID_RE } from '../store/chat-format'
import { MEDIA_ID_RE } from '../store/media'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024
export const MAX_TEXT_CHARS = 100_000
export const MAX_IMAGES_PER_MESSAGE = 10

export class IpcInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcInputError'
  }
}

type Raw = Record<string, unknown>
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

const PHASES: readonly AssistantPhase[] = [
  'idle',
  'wake',
  'listening',
  'transcribing',
  'thinking',
  'acting',
  'speaking',
  'error'
]
const PERMISSION_KINDS: readonly PermissionKind[] = ['microphone', 'screen', 'accessibility']

export function asText(value: unknown, opts: { max?: number; allowEmpty?: boolean } = {}): string {
  const max = opts.max ?? MAX_TEXT_CHARS
  if (typeof value !== 'string') throw new IpcInputError('Ожидался текст.')
  if (value.length > max) throw new IpcInputError(`Текст слишком длинный (больше ${max.toLocaleString('ru-RU')} символов).`)
  if (opts.allowEmpty === false && !value.trim()) throw new IpcInputError('Пустой текст.')
  return value
}

export function asChatId(value: unknown): string {
  if (typeof value !== 'string' || !CHAT_ID_RE.test(value)) throw new IpcInputError('Некорректный идентификатор чата.')
  return value
}

export function asTier(value: unknown): Tier {
  if (typeof value !== 'string' || !(TIERS as readonly string[]).includes(value)) {
    throw new IpcInputError('Неизвестный уровень модели. Допустимо: Luna, Terra, Sol.')
  }
  return value as Tier
}

export function asOptionalTier(value: unknown): Tier | undefined {
  return value === undefined || value === null ? undefined : asTier(value)
}

export function asBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new IpcInputError('Ожидалось значение да/нет.')
  return value
}

export function asTitle(value: unknown): string {
  const title = asText(value, { max: 1000 }).replace(/\s+/g, ' ').trim()
  if (!title) throw new IpcInputError('Название чата не может быть пустым.')
  return title.slice(0, 200)
}

/** ArrayBuffer or any typed array / Buffer → Buffer, with a size limit. */
export function asBinary(value: unknown, maxBytes: number, tooLarge: string): Buffer {
  let buf: Buffer
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    buf = Buffer.from(value as ArrayBuffer)
  } else if (ArrayBuffer.isView(value)) {
    buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  } else {
    throw new IpcInputError('Ожидались двоичные данные.')
  }
  if (buf.length === 0) throw new IpcInputError('Пустые данные.')
  if (buf.length > maxBytes) throw new IpcInputError(tooLarge)
  return buf
}

const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+(\s*;.*)?$/

export function asMime(value: unknown, accept: (type: string) => boolean, what: string): string {
  if (typeof value !== 'string' || value.length > 200) throw new IpcInputError(`Некорректный тип ${what}.`)
  const mime = value.trim().toLowerCase()
  if (!MIME_RE.test(mime) || !accept(mime.split(';')[0].trim())) throw new IpcInputError(`Неподдерживаемый тип ${what}: ${mime}`)
  return mime
}

export const isImageMime = (type: string): boolean => type.startsWith('image/')
export const isAudioMime = (type: string): boolean => type.startsWith('audio/') || /^video\/(webm|mp4|ogg)$/.test(type)

export function asSecretKey(value: unknown): string {
  if (typeof value !== 'string') throw new IpcInputError('Ключ должен быть строкой.')
  const key = value.trim()
  if (!key) throw new IpcInputError('Введите ключ.')
  if (key.length > 512) throw new IpcInputError('Ключ слишком длинный.')
  return key
}

export function asSettingsPatch(value: unknown): SettingsPatch {
  if (!isRecord(value)) throw new IpcInputError('Некорректные настройки.')
  let size = 0
  try {
    size = JSON.stringify(value).length
  } catch {
    throw new IpcInputError('Некорректные настройки.')
  }
  if (size > 200_000) throw new IpcInputError('Слишком большой объём настроек.')
  return value as SettingsPatch
}

export function asSendRequest(value: unknown): SendChatRequest {
  if (!isRecord(value)) throw new IpcInputError('Некорректный запрос.')
  const text = asText(value.text)
  let images: string[] | undefined
  if (value.images !== undefined && value.images !== null) {
    if (!Array.isArray(value.images)) throw new IpcInputError('Некорректный список изображений.')
    if (value.images.length > MAX_IMAGES_PER_MESSAGE) {
      throw new IpcInputError(`Можно прикрепить не больше ${MAX_IMAGES_PER_MESSAGE} изображений.`)
    }
    images = value.images.map((id) => {
      if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) throw new IpcInputError('Некорректное изображение.')
      return id
    })
  }
  if (!text.trim() && !images?.length) throw new IpcInputError('Пустое сообщение.')
  const req: SendChatRequest = { text }
  if (value.chatId !== undefined && value.chatId !== null && value.chatId !== '') req.chatId = asChatId(value.chatId)
  if (images?.length) req.images = [...new Set(images)]
  const tier = asOptionalTier(value.tier)
  if (tier) req.tier = tier
  if (typeof value.speak === 'boolean') req.speak = value.speak
  return req
}

export function asNavigate(value: unknown): NavigateRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new IpcInputError('Некорректный адрес перехода.')
  const nav: NavigateRequest = {}
  if (value.view === 'chat' || value.view === 'settings') nav.view = value.view
  if (typeof value.chatId === 'string' && CHAT_ID_RE.test(value.chatId)) nav.chatId = value.chatId
  // Only the tab ids the settings view knows (unknown ids would silently open the last tab).
  if (isSettingsTabId(value.settingsTab)) nav.settingsTab = value.settingsTab
  return nav
}

export function asPermissionKind(value: unknown): PermissionKind {
  if (typeof value !== 'string' || !(PERMISSION_KINDS as readonly string[]).includes(value)) {
    throw new IpcInputError('Неизвестное разрешение.')
  }
  return value as PermissionKind
}

// --- fire-and-forget reports from the voice window: invalid input is dropped, never thrown ---

export function asVoicePhaseReport(value: unknown): VoicePhaseReport | null {
  if (!isRecord(value) || typeof value.phase !== 'string' || !(PHASES as readonly string[]).includes(value.phase)) {
    return null
  }
  const report: VoicePhaseReport = { phase: value.phase as AssistantPhase }
  if (typeof value.transcript === 'string') report.transcript = value.transcript.slice(0, 4000)
  if (typeof value.error === 'string') report.error = value.error.slice(0, 1000)
  if (typeof value.wakeActive === 'boolean') report.wakeActive = value.wakeActive
  if (value.engineError === null) report.engineError = null
  else if (typeof value.engineError === 'string') report.engineError = value.engineError.slice(0, 1000)
  return report
}

export function asSpeechDone(value: unknown): SpeechDoneReport | null {
  if (!isRecord(value) || typeof value.turnId !== 'string' || !value.turnId || value.turnId.length > 200) return null
  return { turnId: value.turnId, interrupted: value.interrupted === true }
}

export function asLevel(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}
