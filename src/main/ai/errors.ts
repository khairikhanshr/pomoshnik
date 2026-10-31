// Errors of the AI module: Russian user-facing messages and mapping of HTTP / network failures
// (OpenAI-compatible APIs and ElevenLabs).

export type AiErrorCode =
  | 'no_key'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'model_not_found'
  | 'bad_request'
  | 'context_length'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'model_error'
  | 'invalid_response'
  | 'unsupported'

export interface AiErrorInit {
  status?: number
  retryable?: boolean
  retryAfterMs?: number
  /** Raw API message (usually English): logs and fallback detection. */
  detail?: string
  apiCode?: string
  param?: string
  cause?: unknown
}

export class AiError extends Error {
  readonly code: AiErrorCode
  readonly status?: number
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly detail?: string
  readonly apiCode?: string
  readonly param?: string

  constructor(code: AiErrorCode, message: string, init: AiErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'AiError'
    this.code = code
    this.status = init.status
    this.retryable = init.retryable ?? false
    this.retryAfterMs = init.retryAfterMs
    this.detail = init.detail
    this.apiCode = init.apiCode
    this.param = init.param
  }
}

export const OPENAI_MESSAGES = {
  noKey: 'Не задан API-ключ OpenAI. Откройте Настройки → ИИ.',
  unauthorized: 'API-ключ OpenAI недействителен или отозван (401). Проверьте ключ в Настройках → ИИ.',
  region:
    'OpenAI недоступен в вашей стране или регионе (403). Укажите прокси-сервер в поле «Базовый URL» в Настройках → ИИ.',
  forbidden:
    'Доступ запрещён (403): у ключа или проекта нет прав на этот запрос. Проверьте права ключа на platform.openai.com.',
  modelNotFound: (model: string): string =>
    `Модель «${model}» недоступна для вашего ключа. Выберите другую модель или режим «Авто».`,
  notFound: 'Адрес API не найден (404). Проверьте базовый URL в Настройках → ИИ.',
  rateLimit: 'Слишком много запросов к OpenAI (429). Подождите немного и повторите.',
  quota:
    'Квота OpenAI исчерпана: закончились средства на балансе или достигнут лимит расходов. Проверьте биллинг на platform.openai.com.',
  server: (status: number): string => `Сервер OpenAI временно недоступен (${status}). Попробуйте позже.`,
  network: 'Нет соединения с сервером OpenAI. Проверьте интернет и базовый URL в Настройках → ИИ.',
  timeout: 'Сервер не отвечает. Попробуйте ещё раз.',
  aborted: 'Запрос отменён.',
  contextLength: 'Диалог слишком длинный для модели. Начните новый чат.',
  badRequest: (detail?: string): string => `Сервер отклонил запрос (400)${detail ? `: ${detail}` : '.'}`,
  unexpected: (status: number, detail?: string): string =>
    `Ошибка сервера OpenAI (${status})${detail ? `: ${detail}` : '.'}`,
  modelError: (detail?: string): string => `Ошибка модели${detail ? `: ${detail}` : '.'}`,
  invalidResponse: 'Сервер вернул некорректный ответ. Проверьте базовый URL в Настройках → ИИ.',
  streamBroken: 'Ответ модели оборвался. Попробуйте ещё раз.',
  emptyRequest: 'Пустой запрос: введите текст или прикрепите изображение.'
} as const

export const ELEVEN_MESSAGES = {
  noKey: 'Не задан ключ ElevenLabs. Откройте Настройки → Голос и вставьте ключ.',
  noVoice: 'Не выбран голос ElevenLabs. Выберите голос или укажите Voice ID в Настройках → Голос.',
  unauthorized: 'Ключ ElevenLabs недействителен (401). Проверьте ключ в Настройках → Голос.',
  permissions: (detail?: string): string =>
    `У ключа ElevenLabs нет нужных прав${detail ? `: ${detail}` : '.'} Включите доступ к Text to Speech и Voices для ключа.`,
  forbidden: 'Доступ к ElevenLabs запрещён (403). Проверьте ключ и подписку.',
  voiceNotFound: 'Голос ElevenLabs не найден (404). Проверьте Voice ID или выберите другой голос.',
  notFound: 'Адрес ElevenLabs API не найден (404).',
  validation: (detail?: string): string => `ElevenLabs отклонил запрос${detail ? `: ${detail}` : '.'}`,
  quota: 'Лимит ElevenLabs исчерпан: закончились символы по тарифу. Проверьте подписку ElevenLabs.',
  rateLimit: 'Лимит ElevenLabs исчерпан: слишком много запросов одновременно. Подождите немного.',
  server: (status: number): string => `Сервер ElevenLabs временно недоступен (${status}). Попробуйте позже.`,
  unexpected: (status: number, detail?: string): string =>
    `Ошибка ElevenLabs (${status})${detail ? `: ${detail}` : '.'}`,
  network: 'Нет соединения с ElevenLabs. Проверьте интернет.'
} as const

export function abortError(): AiError {
  return new AiError('aborted', OPENAI_MESSAGES.aborted)
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof AiError) return err.code === 'aborted'
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** Russian message for any error (AiError messages are already user-facing). */
export function userMessage(err: unknown): string {
  if (err instanceof AiError) return err.message
  if (err instanceof Error && err.message) return `Непредвиденная ошибка: ${err.message}`
  return 'Непредвиденная ошибка.'
}

export interface ApiErrorBody {
  message?: string
  type?: string
  code?: string
  param?: string
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function clip(text: string, max = 400): string {
  const flat = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Extracts `{ error: { message, type, code, param } }` (also bare `{ message }` / `{ error: '…' }`). */
export function extractApiError(json: unknown): ApiErrorBody {
  if (!json || typeof json !== 'object') return {}
  const root = json as Record<string, unknown>
  const inner = root.error
  if (typeof inner === 'string') return { message: clip(inner) }
  const src = inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : root
  const message = str(src.message)
  return {
    message: message ? clip(message) : undefined,
    type: str(src.type),
    code: str(src.code),
    param: str(src.param)
  }
}

export function parseApiErrorBody(text: string): ApiErrorBody {
  if (!text.trim()) return {}
  try {
    return extractApiError(JSON.parse(text))
  } catch {
    return { message: clip(text, 300) }
  }
}

/** Delay requested by the server (`retry-after-ms`, `retry-after` seconds or HTTP date). */
export function parseRetryAfter(headers: Headers | null | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined
  const ms = headers.get('retry-after-ms')?.trim()
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms))
  const value = headers.get('retry-after')?.trim()
  if (!value) return undefined
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

const MODEL_MISSING_RE =
  /(model\b.*\b(does not exist|not found|not exist|unavailable|no access|do not have access))|invalid model|unknown model|no such model/

export function openAiHttpError(
  status: number,
  bodyText: string,
  headers: Headers | null,
  ctx: { model?: string } = {}
): AiError {
  const body = parseApiErrorBody(bodyText)
  const detail = body.message
  const init: AiErrorInit = { status, detail, apiCode: body.code, param: body.param }
  const code = (body.code ?? '').toLowerCase()
  const type = (body.type ?? '').toLowerCase()
  const lower = (detail ?? '').toLowerCase()
  const modelError = (): AiError =>
    ctx.model
      ? new AiError('model_not_found', OPENAI_MESSAGES.modelNotFound(ctx.model), init)
      : new AiError('not_found', OPENAI_MESSAGES.notFound, init)

  if (code === 'model_not_found') return modelError()
  if (status === 401) return new AiError('unauthorized', OPENAI_MESSAGES.unauthorized, init)
  if (status === 403) {
    if (code === 'unsupported_country_region_territory' || /country|region|territor/.test(lower)) {
      return new AiError('forbidden', OPENAI_MESSAGES.region, init)
    }
    if (ctx.model && /\bmodel\b/.test(lower)) return modelError()
    return new AiError('forbidden', OPENAI_MESSAGES.forbidden, init)
  }
  if (status === 404) {
    if (ctx.model && /\bmodel\b/.test(lower)) return modelError()
    return new AiError('not_found', OPENAI_MESSAGES.notFound, init)
  }
  if (status === 429) {
    if (code === 'insufficient_quota' || type === 'insufficient_quota' || /quota|billing/.test(lower)) {
      return new AiError('quota', OPENAI_MESSAGES.quota, init)
    }
    return new AiError('rate_limit', OPENAI_MESSAGES.rateLimit, {
      ...init,
      retryable: true,
      retryAfterMs: parseRetryAfter(headers)
    })
  }
  if (status === 400 || status === 422) {
    if (code === 'context_length_exceeded' || /context length|context window|maximum context/.test(lower)) {
      return new AiError('context_length', OPENAI_MESSAGES.contextLength, init)
    }
    if (ctx.model && (MODEL_MISSING_RE.test(lower) || body.param === 'model')) return modelError()
    return new AiError('bad_request', OPENAI_MESSAGES.badRequest(detail), init)
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new AiError('server', OPENAI_MESSAGES.server(status), {
      ...init,
      retryable: true,
      retryAfterMs: parseRetryAfter(headers)
    })
  }
  return new AiError('bad_request', OPENAI_MESSAGES.unexpected(status, detail), init)
}

/** Error object of a streamed `error` event or of `response.failed` (`{ code, message }`). */
export function openAiStreamError(raw: unknown, ctx: { model?: string } = {}): AiError {
  const body = extractApiError(raw)
  const code = (body.code ?? body.type ?? '').toLowerCase()
  const detail = body.message
  const init: AiErrorInit = { detail, apiCode: body.code, param: body.param }
  switch (code) {
    case 'insufficient_quota':
      return new AiError('quota', OPENAI_MESSAGES.quota, init)
    case 'rate_limit_exceeded':
      return new AiError('rate_limit', OPENAI_MESSAGES.rateLimit, { ...init, retryable: true })
    case 'context_length_exceeded':
      return new AiError('context_length', OPENAI_MESSAGES.contextLength, init)
    case 'model_not_found':
      return ctx.model
        ? new AiError('model_not_found', OPENAI_MESSAGES.modelNotFound(ctx.model), init)
        : new AiError('model_error', OPENAI_MESSAGES.modelError(detail), init)
    case 'server_error':
    case 'internal_error':
    case 'service_unavailable':
      return new AiError('server', OPENAI_MESSAGES.modelError(detail ?? 'внутренняя ошибка сервера'), {
        ...init,
        retryable: true
      })
    default:
      return new AiError('model_error', OPENAI_MESSAGES.modelError(detail), init)
  }
}

/** fetch() rejections (DNS, refused, reset, TLS…) → retryable network error. */
export function networkError(err: unknown, message: string): AiError {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  const parts = [str(cause?.code), str(cause?.message) ?? (err instanceof Error ? err.message : undefined)]
  return new AiError('network', message, {
    retryable: true,
    detail: parts.filter(Boolean).join(': ') || undefined,
    cause: err
  })
}

interface ElevenBody {
  status?: string
  message?: string
}

/** ElevenLabs bodies: `{ detail: { status, message } }`, `{ detail: '…' }` or FastAPI `{ detail: [{ loc, msg }] }`. */
export function parseElevenLabsBody(text: string): ElevenBody {
  if (!text.trim()) return {}
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { message: clip(text, 300) }
  }
  const detail = (json as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return { message: clip(detail) }
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => {
        const item = d as { loc?: unknown; msg?: unknown }
        const loc = Array.isArray(item.loc) ? item.loc.filter((p) => p !== 'body').join('.') : ''
        const msg = str(item.msg) ?? ''
        return loc && msg ? `${loc}: ${msg}` : msg
      })
      .filter(Boolean)
    return { message: msgs.length ? clip(msgs.join('; ')) : undefined }
  }
  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>
    const message = str(d.message)
    return { status: str(d.status), message: message ? clip(message) : undefined }
  }
  const generic = extractApiError(json)
  return { status: generic.code, message: generic.message }
}

export function elevenLabsHttpError(
  status: number,
  bodyText: string,
  headers: Headers | null,
  op: 'tts' | 'voices'
): AiError {
  const body = parseElevenLabsBody(bodyText)
  const detail = body.message
  const kind = (body.status ?? '').toLowerCase()
  const lower = `${kind} ${detail ?? ''}`.toLowerCase()
  const init: AiErrorInit = { status, detail, apiCode: body.status }

  if (kind === 'quota_exceeded' || /quota/.test(lower)) return new AiError('quota', ELEVEN_MESSAGES.quota, init)
  if (status === 401) {
    if (/permission/.test(lower)) return new AiError('forbidden', ELEVEN_MESSAGES.permissions(detail), init)
    return new AiError('unauthorized', ELEVEN_MESSAGES.unauthorized, init)
  }
  if (status === 403) {
    if (/permission/.test(lower)) return new AiError('forbidden', ELEVEN_MESSAGES.permissions(detail), init)
    return new AiError('forbidden', ELEVEN_MESSAGES.forbidden, init)
  }
  if (status === 404) {
    return new AiError('not_found', op === 'tts' ? ELEVEN_MESSAGES.voiceNotFound : ELEVEN_MESSAGES.notFound, init)
  }
  if (status === 400 || status === 422) return new AiError('bad_request', ELEVEN_MESSAGES.validation(detail), init)
  if (status === 429) {
    return new AiError('rate_limit', ELEVEN_MESSAGES.rateLimit, {
      ...init,
      retryable: true,
      retryAfterMs: parseRetryAfter(headers)
    })
  }
  if (status >= 500) {
    return new AiError('server', ELEVEN_MESSAGES.server(status), {
      ...init,
      retryable: true,
      retryAfterMs: parseRetryAfter(headers)
    })
  }
  return new AiError('bad_request', ELEVEN_MESSAGES.unexpected(status, detail), init)
}
