import { createServer } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AiError, OPENAI_MESSAGES, openAiHttpError, parseRetryAfter } from '../../src/main/ai/errors'
import { DEFAULT_HTTP_TUNING, OpenAiClient, type HttpTuning } from '../../src/main/ai/http'
import type { SseEvent } from '../../src/main/ai/sse'
import { FakeSecrets, FakeSettings, memoryLog } from './helpers/fakes'
import { MockServer, json, openAiError, sse } from './helpers/mock-server'

let server: MockServer
beforeAll(async () => {
  server = await MockServer.start()
})
afterAll(() => server.close())
beforeEach(() => {
  server.reset()
  delete process.env.JARVIS_OPENAI_BASE_URL
})
afterEach(() => {
  delete process.env.JARVIS_OPENAI_BASE_URL
})

const TUNING: HttpTuning = { ...DEFAULT_HTTP_TUNING, retryBaseDelayMs: 5, streamIdleTimeoutMs: 2000, requestTimeoutMs: 2000 }

function client(opts: { key?: string | null; baseUrl?: string; tuning?: Partial<HttpTuning> } = {}): OpenAiClient {
  return new OpenAiClient({
    settings: new FakeSettings({ baseUrl: opts.baseUrl ?? `${server.url}/v1/` }),
    secrets: new FakeSecrets(opts.key === undefined ? 'sk-test-0123456789abcdef' : opts.key),
    tuning: { ...TUNING, ...opts.tuning },
    log: memoryLog()
  })
}

async function failure(p: Promise<unknown>): Promise<AiError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(AiError)
    return err as AiError
  }
  throw new Error('expected a failure')
}

async function collect(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('OpenAiClient', () => {
  it('sends Authorization: Bearer to the base URL without a trailing slash', async () => {
    server.on('GET /v1/models', json(200, { object: 'list', data: [] }))
    await client().getJson('/models')
    const [req] = server.requestsTo('GET /v1/models')
    expect(req.headers.authorization).toBe('Bearer sk-test-0123456789abcdef')
  })

  it('JARVIS_OPENAI_BASE_URL overrides settings.baseUrl', async () => {
    process.env.JARVIS_OPENAI_BASE_URL = `${server.url}/proxy/`
    server.on('GET /proxy/models', json(200, { data: [] }))
    const c = client({ baseUrl: 'https://api.openai.com/v1' })
    expect(c.baseUrl()).toBe(`${server.url}/proxy`)
    await c.getJson('/models')
    expect(server.requestsTo('GET /proxy/models')).toHaveLength(1)
  })

  it('fails without a request when no API key is set', async () => {
    const err = await failure(client({ key: null }).getJson('/models'))
    expect(err.code).toBe('no_key')
    expect(err.message).toBe('Не задан API-ключ OpenAI. Откройте Настройки → ИИ.')
    expect(server.requests).toHaveLength(0)
  })

  it('maps 401 without retrying', async () => {
    server.on('GET /v1/models', openAiError(401, 'Incorrect API key provided: sk-test***.', 'invalid_api_key'))
    const err = await failure(client().getJson('/models'))
    expect(err.code).toBe('unauthorized')
    expect(err.message).toBe(OPENAI_MESSAGES.unauthorized)
    expect(server.requests).toHaveLength(1)
  })

  it('maps 403 region errors', async () => {
    server.on(
      'GET /v1/models',
      openAiError(403, 'Country, region, or territory not supported', 'unsupported_country_region_territory', 'request_forbidden')
    )
    const err = await failure(client().getJson('/models'))
    expect(err.message).toBe(OPENAI_MESSAGES.region)
  })

  it('maps 404 model_not_found to a message naming the model', async () => {
    server.on(
      'POST /v1/responses',
      openAiError(404, 'The model `gpt-9-sol` does not exist or you do not have access to it.', 'model_not_found')
    )
    const err = await failure(collect(client().stream('/responses', { model: 'gpt-9-sol' }, { model: 'gpt-9-sol' })))
    expect(err.code).toBe('model_not_found')
    expect(err.message).toBe('Модель «gpt-9-sol» недоступна для вашего ключа. Выберите другую модель или режим «Авто».')
    expect(server.requests).toHaveLength(1)
  })

  it('does not retry 429 insufficient_quota', async () => {
    server.on(
      'POST /v1/responses',
      openAiError(429, 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota', 'insufficient_quota')
    )
    const err = await failure(collect(client().stream('/responses', {})))
    expect(err.code).toBe('quota')
    expect(err.message).toBe(OPENAI_MESSAGES.quota)
    expect(server.requests).toHaveLength(1)
  })

  it('retries 429 rate limits honouring retry-after, then succeeds', async () => {
    server.enqueue('GET /v1/models', (_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '0.05' })
      res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }))
    })
    server.enqueue('GET /v1/models', json(200, { data: [{ id: 'gpt-6-sol' }] }))
    const started = Date.now()
    const res = await client().getJson<{ data: unknown[] }>('/models')
    expect(res.data).toHaveLength(1)
    expect(server.requests).toHaveLength(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })

  it('gives up on rate limits when retry-after exceeds the allowed wait', async () => {
    server.on('GET /v1/models', (_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '3600' })
      res.end(JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }))
    })
    const err = await failure(client().getJson('/models'))
    expect(err.code).toBe('rate_limit')
    expect(err.message).toBe(OPENAI_MESSAGES.rateLimit)
    expect(server.requests).toHaveLength(1)
  })

  it('retries 5xx twice', async () => {
    server.enqueue('GET /v1/models', openAiError(500, 'The server had an error', null, 'server_error'))
    server.enqueue('GET /v1/models', openAiError(503, 'Overloaded', null, 'server_error'))
    server.enqueue('GET /v1/models', json(200, { data: [] }))
    await client().getJson('/models')
    expect(server.requests).toHaveLength(3)

    server.reset()
    server.on('GET /v1/models', openAiError(502, 'Bad gateway', null, 'server_error'))
    const err = await failure(client().getJson('/models'))
    expect(err.code).toBe('server')
    expect(err.message).toBe('Сервер OpenAI временно недоступен (502). Попробуйте позже.')
    expect(server.requests).toHaveLength(3)
  })

  it('maps connection failures to a network error after retries', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port
        s.close(() => resolve(p))
      })
    })
    const err = await failure(client({ baseUrl: `http://127.0.0.1:${port}/v1` }).getJson('/models'))
    expect(err.code).toBe('network')
    expect(err.message).toBe(OPENAI_MESSAGES.network)
    expect(err.detail).toMatch(/ECONNREFUSED/)
  })

  it('reports "Сервер не отвечает" when a stream goes idle', async () => {
    server.on('POST /v1/responses', sse([{ event: 'response.created', data: { type: 'response.created' } }], { hang: true }))
    const started = Date.now()
    const events: SseEvent[] = []
    const err = await failure(
      (async () => {
        for await (const ev of client({ tuning: { streamIdleTimeoutMs: 150 } }).stream('/responses', {})) events.push(ev)
      })()
    )
    expect(events).toHaveLength(1)
    expect(err.code).toBe('timeout')
    expect(err.message).toBe('Сервер не отвечает. Попробуйте ещё раз.')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('aborts a stream mid-way through the AbortSignal', async () => {
    server.on('POST /v1/responses', sse([{ event: 'a', data: { type: 'a' } }], { hang: true }))
    const ctrl = new AbortController()
    const err = await failure(
      (async () => {
        for await (const _ev of client().stream('/responses', {}, { signal: ctrl.signal })) ctrl.abort()
      })()
    )
    expect(err.code).toBe('aborted')
  })

  it('yields a JSON body as a single synthetic event when the server ignores stream:true', async () => {
    server.on('POST /v1/responses', json(200, { id: 'resp_1', status: 'completed', output: [] }))
    const events = await collect(client().stream('/responses', {}))
    expect(events).toEqual([{ event: 'json', data: JSON.stringify({ id: 'resp_1', status: 'completed', output: [] }) }])
  })
})

describe('error helpers', () => {
  it('parses retry-after variants', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250)
    expect(parseRetryAfter(new Headers({ 'retry-after': '2' }))).toBe(2000)
    const now = Date.parse('2026-10-29T10:00:00Z')
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Thu, 29 Oct 2026 10:00:03 GMT' }), now)).toBe(3000)
    expect(parseRetryAfter(new Headers())).toBeUndefined()
  })

  it('does not mistake unsupported-parameter 400s for a missing model', () => {
    const body = JSON.stringify({
      error: {
        message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
        type: 'invalid_request_error',
        param: 'reasoning.effort',
        code: 'unsupported_parameter'
      }
    })
    const err = openAiHttpError(400, body, null, { model: 'gpt-4.1' })
    expect(err.code).toBe('bad_request')
    expect(err.message).toContain('Сервер отклонил запрос (400)')
  })

  it('maps context length errors', () => {
    const body = JSON.stringify({ error: { message: 'Input too long', code: 'context_length_exceeded' } })
    expect(openAiHttpError(400, body, null).message).toBe(OPENAI_MESSAGES.contextLength)
  })
})
