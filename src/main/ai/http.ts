// Authorized fetch for OpenAI-compatible APIs: retries with backoff (Retry-After aware),
// request timeouts, idle timeouts for SSE streams and Russian error mapping.
import { DEFAULT_BASE_URL } from '@shared/defaults'
import type { Logger } from '../log'
import type { SecretStore, SettingsStore } from '../services'
import { AiError, OPENAI_MESSAGES, abortError, networkError, openAiHttpError } from './errors'
import { SseParser, type SseEvent } from './sse'

export interface HttpTuning {
  /** Extra attempts for 429 (not quota) / 5xx / network errors. */
  retries: number
  retryBaseDelayMs: number
  /** Longer server-requested waits are not honoured: the error is reported instead. */
  maxRetryDelayMs: number
  /** Whole-request timeout for non-streaming calls. */
  requestTimeoutMs: number
  /** Streams fail when no bytes arrive for this long (also bounds the wait for headers). */
  streamIdleTimeoutMs: number
}

export const DEFAULT_HTTP_TUNING: HttpTuning = {
  retries: 2,
  retryBaseDelayMs: 700,
  maxRetryDelayMs: 30_000,
  requestTimeoutMs: 90_000,
  streamIdleTimeoutMs: 120_000
}

/** AbortController linked to an outer signal, with a restartable timeout. */
export class Deadline {
  private readonly ctrl = new AbortController()
  private timer: NodeJS.Timeout | null = null
  private readonly onOuterAbort = (): void => this.ctrl.abort()
  timedOut = false

  constructor(
    private readonly outer: AbortSignal | undefined,
    ms: number
  ) {
    if (outer?.aborted) this.ctrl.abort()
    else outer?.addEventListener('abort', this.onOuterAbort, { once: true })
    this.restart(ms)
  }

  get signal(): AbortSignal {
    return this.ctrl.signal
  }

  restart(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.ctrl.abort()
    }, ms)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.outer?.removeEventListener('abort', this.onOuterAbort)
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function backoffDelay(attempt: number, baseMs: number): number {
  return Math.round(baseMs * 2 ** attempt * (1 + Math.random() * 0.25))
}

export interface RetryRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string | FormData
  signal?: AbortSignal
  /** Time allowed until the response headers (and, for the caller, the body). */
  timeoutMs: number
  retries: number
  toError(res: Response, bodyText: string): AiError
  networkMessage: string
  log?: Logger
}

export interface OpenResponse {
  res: Response
  /** Still armed: the caller reads the body under it and must dispose() it. */
  deadline: Deadline
}

/** fetch with retries for retryable errors; resolves with a 2xx response or throws an AiError. */
export async function fetchWithRetry(req: RetryRequest, tuning: HttpTuning): Promise<OpenResponse> {
  for (let attempt = 0; ; attempt++) {
    if (req.signal?.aborted) throw abortError()
    const deadline = new Deadline(req.signal, req.timeoutMs)
    let failure: AiError
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: deadline.signal
      })
      if (res.ok) return { res, deadline }
      const text = await res.text().catch(() => '')
      deadline.dispose()
      failure = req.toError(res, text)
    } catch (err) {
      deadline.dispose()
      if (req.signal?.aborted) throw abortError()
      if (deadline.timedOut) throw new AiError('timeout', OPENAI_MESSAGES.timeout, { cause: err })
      failure = err instanceof AiError ? err : networkError(err, req.networkMessage)
    }
    if (!failure.retryable || attempt >= req.retries) throw failure
    const delay = failure.retryAfterMs ?? backoffDelay(attempt, tuning.retryBaseDelayMs)
    if (delay > tuning.maxRetryDelayMs) throw failure
    const what = `${failure.status ?? failure.code}${failure.detail ? `: ${failure.detail}` : ''}`
    req.log?.warn(`${req.method} ${new URL(req.url).pathname} failed (${what}), retry ${attempt + 1}/${req.retries} in ${delay} ms`)
    await sleep(delay, req.signal)
  }
}

/** Maps a failure while reading a response body. */
function bodyReadError(
  err: unknown,
  deadline: Deadline,
  signal: AbortSignal | undefined,
  networkMessage: string
): AiError {
  if (signal?.aborted) return abortError()
  if (deadline.timedOut) return new AiError('timeout', OPENAI_MESSAGES.timeout, { cause: err })
  if (err instanceof AiError) return err
  return networkError(err, networkMessage)
}

export interface StreamReadOptions {
  idleTimeoutMs: number
  signal?: AbortSignal
  networkMessage: string
}

/**
 * Yields SSE events of a 2xx response. A JSON body (server ignored `stream: true`) is yielded once
 * as the synthetic event 'json'. Fails with "Сервер не отвечает" when no bytes arrive within the idle timeout.
 */
export async function* readEventStream(
  res: Response,
  deadline: Deadline,
  opts: StreamReadOptions
): AsyncGenerator<SseEvent> {
  try {
    const body = res.body
    if (!body) return
    if (/application\/json/i.test(res.headers.get('content-type') ?? '')) {
      deadline.restart(opts.idleTimeoutMs)
      let text: string
      try {
        text = await res.text()
      } catch (err) {
        throw bodyReadError(err, deadline, opts.signal, opts.networkMessage)
      }
      if (text.trim()) yield { event: 'json', data: text }
      return
    }
    const reader = body.getReader()
    const parser = new SseParser()
    let finished = false
    try {
      for (;;) {
        deadline.restart(opts.idleTimeoutMs)
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (err) {
          throw bodyReadError(err, deadline, opts.signal, opts.networkMessage)
        }
        if (chunk.done) {
          finished = true
          break
        }
        for (const ev of parser.push(chunk.value)) yield ev
      }
      for (const ev of parser.end()) yield ev
    } finally {
      if (!finished) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  } finally {
    deadline.dispose()
  }
}

export interface OpenAiClientDeps {
  settings: SettingsStore
  secrets: SecretStore
  tuning: HttpTuning
  log: Logger
}

export interface CallOptions {
  signal?: AbortSignal
  /** Model id the request is for (used in "model not available" messages). */
  model?: string
  timeoutMs?: number
  retries?: number
}

/** Thin client for `{baseUrl}` (settings.baseUrl, overridden by JARVIS_OPENAI_BASE_URL). */
export class OpenAiClient {
  constructor(private readonly deps: OpenAiClientDeps) {}

  get tuning(): HttpTuning {
    return this.deps.tuning
  }

  baseUrl(): string {
    const env = process.env.JARVIS_OPENAI_BASE_URL?.trim()
    const raw = env || this.deps.settings.get().baseUrl?.trim() || DEFAULT_BASE_URL
    return raw.replace(/\/+$/, '')
  }

  hasKey(): boolean {
    return Boolean(this.deps.secrets.getApiKey()?.trim())
  }

  private authHeaders(): Record<string, string> {
    const key = this.deps.secrets.getApiKey()?.trim()
    if (!key) throw new AiError('no_key', OPENAI_MESSAGES.noKey)
    return { Authorization: `Bearer ${key}` }
  }

  private open(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body: string | FormData | undefined,
    opts: CallOptions,
    timeoutMs: number
  ): Promise<OpenResponse> {
    return fetchWithRetry(
      {
        url: `${this.baseUrl()}${path}`,
        method,
        headers: { ...this.authHeaders(), ...headers },
        body,
        signal: opts.signal,
        timeoutMs,
        retries: opts.retries ?? this.deps.tuning.retries,
        toError: (res, text) => openAiHttpError(res.status, text, res.headers, { model: opts.model }),
        networkMessage: OPENAI_MESSAGES.network,
        log: this.deps.log
      },
      this.deps.tuning
    )
  }

  private async readBody<T>(open: OpenResponse, opts: CallOptions, read: (res: Response) => Promise<T>): Promise<T> {
    try {
      return await read(open.res)
    } catch (err) {
      throw bodyReadError(err, open.deadline, opts.signal, OPENAI_MESSAGES.network)
    } finally {
      open.deadline.dispose()
    }
  }

  async getJson<T>(path: string, opts: CallOptions = {}): Promise<T> {
    const timeout = opts.timeoutMs ?? this.deps.tuning.requestTimeoutMs
    const open = await this.open('GET', path, { Accept: 'application/json' }, undefined, opts, timeout)
    return this.parseJson<T>(await this.readBody(open, opts, (res) => res.text()))
  }

  async postJson<T>(path: string, json: unknown, opts: CallOptions = {}): Promise<T> {
    const open = await this.open(
      'POST',
      path,
      { Accept: 'application/json', 'Content-Type': 'application/json' },
      JSON.stringify(json),
      opts,
      opts.timeoutMs ?? this.deps.tuning.requestTimeoutMs
    )
    return this.parseJson<T>(await this.readBody(open, opts, (res) => res.text()))
  }

  /** Multipart POST; fetch sets the boundary Content-Type itself. */
  async postForm<T>(path: string, form: FormData, opts: CallOptions = {}): Promise<T> {
    const timeout = opts.timeoutMs ?? this.deps.tuning.requestTimeoutMs
    const open = await this.open('POST', path, { Accept: 'application/json' }, form, opts, timeout)
    return this.parseJson<T>(await this.readBody(open, opts, (res) => res.text()))
  }

  async postBinary(path: string, json: unknown, opts: CallOptions = {}): Promise<{ data: Buffer; mime: string }> {
    const open = await this.open(
      'POST',
      path,
      { 'Content-Type': 'application/json' },
      JSON.stringify(json),
      opts,
      opts.timeoutMs ?? this.deps.tuning.requestTimeoutMs
    )
    const mime = open.res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
    const data = await this.readBody(open, opts, async (res) => Buffer.from(await res.arrayBuffer()))
    return { data, mime }
  }

  /** POST with `stream: true` semantics: yields SSE events until the server closes the stream. */
  async *stream(path: string, json: unknown, opts: CallOptions = {}): AsyncGenerator<SseEvent> {
    const idle = this.deps.tuning.streamIdleTimeoutMs
    const open = await this.open(
      'POST',
      path,
      { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      JSON.stringify(json),
      opts,
      opts.timeoutMs ?? idle
    )
    yield* readEventStream(open.res, open.deadline, {
      idleTimeoutMs: idle,
      signal: opts.signal,
      networkMessage: OPENAI_MESSAGES.network
    })
  }

  private parseJson<T>(text: string): T {
    try {
      return JSON.parse(text) as T
    } catch (err) {
      throw new AiError('invalid_response', OPENAI_MESSAGES.invalidResponse, { detail: text.slice(0, 200), cause: err })
    }
  }
}
