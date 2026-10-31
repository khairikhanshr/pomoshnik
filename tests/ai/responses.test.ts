import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_HTTP_TUNING, OpenAiClient } from '../../src/main/ai/http'
import type { SessionOptions } from '../../src/main/ai/provider'
import { ResponsesProvider } from '../../src/main/ai/responses'
import { FakeSecrets, FakeSettings, memoryLog, toolSpec } from './helpers/fakes'
import { MockServer, ResponsesStream, json, openAiError, sse } from './helpers/mock-server'

let server: MockServer
beforeAll(async () => {
  server = await MockServer.start()
})
afterAll(() => server.close())
beforeEach(() => server.reset())

const ROUTE = 'POST /v1/responses'
const IMG = 'data:image/png;base64,AAAA'

function provider(): ResponsesProvider {
  const http = new OpenAiClient({
    settings: new FakeSettings({ baseUrl: `${server.url}/v1` }),
    secrets: new FakeSecrets(),
    tuning: { ...DEFAULT_HTTP_TUNING, retryBaseDelayMs: 5, streamIdleTimeoutMs: 3000 },
    log: memoryLog()
  })
  return new ResponsesProvider(http, memoryLog())
}

function options(patch: Partial<SessionOptions> = {}): SessionOptions {
  return {
    model: 'gpt-6-terra',
    instructions: 'You are Jarvis.',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'Привет' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Добрый день, сэр.' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Что на картинке?' },
          { type: 'image', url: IMG, detail: 'high' }
        ]
      }
    ],
    tools: [toolSpec('take_screenshot', { display: { type: 'string' } }), toolSpec('open_application', { name: { type: 'string' } })],
    webSearch: true,
    effort: 'low',
    ...patch
  }
}

const signal = (): AbortSignal => new AbortController().signal

describe('ResponsesProvider request', () => {
  it('sends the exact Responses API body', async () => {
    server.enqueue(ROUTE, sse(new ResponsesStream().text('Это кот, сэр.').completed()))
    const deltas: string[] = []
    const result = await provider()
      .createSession(options())
      .step({ signal: signal(), onTextDelta: (d) => deltas.push(d) })
    expect(result).toEqual({ text: 'Это кот, сэр.', toolCalls: [], finishReason: 'stop' })
    expect(deltas.join('')).toBe('Это кот, сэр.')
    expect(deltas.length).toBeGreaterThan(1)

    const [req] = server.requestsTo(ROUTE)
    expect(req.headers.accept).toBe('text/event-stream')
    expect(req.json()).toEqual({
      model: 'gpt-6-terra',
      instructions: 'You are Jarvis.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Привет' }] },
        { role: 'assistant', content: 'Добрый день, сэр.' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Что на картинке?' },
            { type: 'input_image', image_url: IMG, detail: 'high' }
          ]
        }
      ],
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      tools: [
        {
          type: 'function',
          name: 'take_screenshot',
          description: 'Test tool take_screenshot',
          parameters: { type: 'object', properties: { display: { type: 'string' } } },
          strict: false
        },
        {
          type: 'function',
          name: 'open_application',
          description: 'Test tool open_application',
          parameters: { type: 'object', properties: { name: { type: 'string' } } },
          strict: false
        },
        { type: 'web_search' }
      ],
      tool_choice: 'auto',
      reasoning: { effort: 'low' }
    })
  })

  it("omits reasoning for 'auto', web_search when disabled and tools when there are none", async () => {
    server.enqueue(ROUTE, sse(new ResponsesStream().text('ok').completed()))
    await provider()
      .createSession(options({ effort: 'auto', webSearch: false, tools: [] }))
      .step({ signal: signal() })
    const body = server.requestsTo(ROUTE)[0].json()
    expect(body).not.toHaveProperty('reasoning')
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
    expect(body.include).toEqual(['reasoning.encrypted_content'])
  })

  it('exposes our browser web_search function under another name next to the built-in tool', async () => {
    server.enqueue(
      ROUTE,
      sse(new ResponsesStream().functionCall('call_ws', 'open_web_search', { query: 'погода' }).completed())
    )
    const result = await provider()
      .createSession(options({ tools: [toolSpec('web_search', { query: { type: 'string' } })] }))
      .step({ signal: signal() })
    const tools = server.requestsTo(ROUTE)[0].json().tools
    expect(tools.map((t: { name?: string; type: string }) => t.name ?? t.type)).toEqual(['open_web_search', 'web_search'])
    expect(result.toolCalls).toEqual([{ id: 'call_ws', name: 'web_search', arguments: '{"query":"погода"}' }])
  })
})

describe('ResponsesProvider tool loop', () => {
  it('replays reasoning + function_call items verbatim, then outputs and tool images', async () => {
    const first = new ResponsesStream('resp_1')
      .reasoning('rs_1', 'gAAAAA-encrypted-reasoning')
      .functionCall('call_1', 'take_screenshot', { display: 'cursor' })
      .completed()
    server.enqueue(ROUTE, sse(first))
    server.enqueue(ROUTE, sse(new ResponsesStream('resp_2').reasoning('rs_2', 'gAAAAA-2').text('Вопрос 1 — B.').completed()))

    const session = provider().createSession(options())
    const step1 = await session.step({ signal: signal() })
    expect(step1.finishReason).toBe('tool_calls')
    expect(step1.toolCalls).toEqual([{ id: 'call_1', name: 'take_screenshot', arguments: '{"display":"cursor"}' }])

    session.addToolResults([
      { callId: 'call_1', name: 'take_screenshot', output: 'Screenshot 1280x800 px.', images: [{ url: IMG, detail: 'high' }] }
    ])
    const step2 = await session.step({ signal: signal() })
    expect(step2).toEqual({ text: 'Вопрос 1 — B.', toolCalls: [], finishReason: 'stop' })

    const input = server.requestsTo(ROUTE)[1].json().input
    expect(input).toHaveLength(7)
    expect(input.slice(3)).toEqual([
      { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'gAAAAA-encrypted-reasoning' },
      {
        id: 'fc_1',
        type: 'function_call',
        status: 'completed',
        arguments: '{"display":"cursor"}',
        call_id: 'call_1',
        name: 'take_screenshot'
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'Screenshot 1280x800 px.' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Снимок экрана (результат take_screenshot):' },
          { type: 'input_image', image_url: IMG, detail: 'high' }
        ]
      }
    ])
  })

  it('returns parallel tool calls in output order', async () => {
    server.enqueue(
      ROUTE,
      sse(
        new ResponsesStream()
          .functionCall('call_a', 'open_application', { name: 'Telegram' })
          .functionCall('call_b', 'open_application', { name: 'Safari' })
          .completed()
      )
    )
    const session = provider().createSession(options())
    const result = await session.step({ signal: signal() })
    expect(result.toolCalls.map((c) => [c.id, JSON.parse(c.arguments).name])).toEqual([
      ['call_a', 'Telegram'],
      ['call_b', 'Safari']
    ])
    session.addToolResults([
      { callId: 'call_a', name: 'open_application', output: 'Opened Telegram', images: [] },
      { callId: 'call_b', name: 'open_application', output: 'Opened Safari', images: [] }
    ])
    server.enqueue(ROUTE, sse(new ResponsesStream().text('Готово, сэр.').completed()))
    await session.step({ signal: signal() })
    const input = server.requestsTo(ROUTE)[1].json().input
    expect(input.filter((i: { type?: string }) => i.type === 'function_call_output').map((i: { call_id: string }) => i.call_id)).toEqual([
      'call_a',
      'call_b'
    ])
    // no tool images: nothing is appended after the outputs
    expect(input[input.length - 1]).toEqual({ type: 'function_call_output', call_id: 'call_b', output: 'Opened Safari' })
  })

  it('sends tool_choice none on the final step but keeps the tools declared', async () => {
    server.enqueue(ROUTE, sse(new ResponsesStream().text('Итог.').completed()))
    await provider().createSession(options()).step({ signal: signal(), noTools: true })
    const body = server.requestsTo(ROUTE)[0].json()
    expect(body.tool_choice).toBe('none')
    expect(body.tools).toHaveLength(3)
  })

  it('reports web search activity', async () => {
    server.enqueue(ROUTE, sse(new ResponsesStream().webSearch().text('В Алматы +5 °C.').completed()))
    let searched = 0
    const result = await provider()
      .createSession(options())
      .step({ signal: signal(), onActivity: () => searched++ })
    expect(searched).toBe(1)
    expect(result.text).toBe('В Алматы +5 °C.')
  })
})

describe('ResponsesProvider adaptive 400 fallbacks', () => {
  it('drops reasoning once and remembers it for the model', async () => {
    server.enqueue(
      ROUTE,
      openAiError(400, "Unsupported parameter: 'reasoning.effort' is not supported with this model.", 'unsupported_parameter', 'invalid_request_error', 'reasoning.effort')
    )
    server.on(ROUTE, sse(new ResponsesStream().text('ok').completed()))
    const p = provider()
    await p.createSession(options()).step({ signal: signal() })
    const [bad, good] = server.requestsTo(ROUTE).map((r) => r.json())
    expect(bad.reasoning).toEqual({ effort: 'low' })
    expect(good).not.toHaveProperty('reasoning')
    await p.createSession(options()).step({ signal: signal() })
    expect(server.requestsTo(ROUTE)).toHaveLength(3)
    expect(server.requestsTo(ROUTE)[2].json()).not.toHaveProperty('reasoning')
    // another model is not affected
    await p.createSession(options({ model: 'gpt-6-sol' })).step({ signal: signal() })
    expect(server.requestsTo(ROUTE)[3].json().reasoning).toEqual({ effort: 'low' })
  })

  it('downgrades an unsupported effort to the closest supported value', async () => {
    server.enqueue(
      ROUTE,
      openAiError(
        400,
        "Unsupported value: 'max' is not supported with the 'gpt-6-terra' model. Supported values are: 'low', 'medium', and 'high'.",
        'unsupported_value',
        'invalid_request_error',
        'reasoning.effort'
      )
    )
    server.on(ROUTE, sse(new ResponsesStream().text('ok').completed()))
    await provider().createSession(options({ effort: 'max' })).step({ signal: signal() })
    expect(server.requestsTo(ROUTE).map((r) => r.json().reasoning)).toEqual([{ effort: 'max' }, { effort: 'high' }])
  })

  it('drops web_search, include and original detail when rejected', async () => {
    server.enqueue(ROUTE, openAiError(400, "Tool 'web_search' is not supported with gpt-6-terra.", null, 'invalid_request_error', 'tools'))
    server.enqueue(ROUTE, openAiError(400, 'Encrypted content is not supported with this model.', null, 'invalid_request_error', 'include'))
    server.enqueue(
      ROUTE,
      openAiError(400, "Invalid value: 'original'. Supported values are: 'low', 'high', and 'auto'.", 'invalid_value', 'invalid_request_error', 'input[2].content[1].detail')
    )
    server.on(ROUTE, sse(new ResponsesStream().text('ok').completed()))
    const messages = options().messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => (p.type === 'image' ? { ...p, detail: 'original' as const } : p))
    }))
    const result = await provider().createSession(options({ messages })).step({ signal: signal() })
    expect(result.text).toBe('ok')
    const bodies = server.requestsTo(ROUTE).map((r) => r.json())
    expect(bodies).toHaveLength(4)
    const last = bodies[3]
    expect(last.tools.some((t: { type: string }) => t.type === 'web_search')).toBe(false)
    expect(last).not.toHaveProperty('include')
    expect(last.input[2].content[1].detail).toBe('high')
  })

  it('does not loop on an unrelated 400', async () => {
    server.on(ROUTE, openAiError(400, "Invalid 'input[0].content': empty array.", null))
    await expect(provider().createSession(options()).step({ signal: signal() })).rejects.toThrow(/Сервер отклонил запрос \(400\)/)
    expect(server.requestsTo(ROUTE)).toHaveLength(1)
  })

  it('strips a replayed item id the server cannot find (store: false)', async () => {
    server.enqueue(ROUTE, sse(new ResponsesStream().functionCall('call_1', 'take_screenshot', {}).completed()))
    server.enqueue(
      ROUTE,
      openAiError(400, "Item with id 'fc_0' not found. Items are not persisted when `store` is set to false.", null)
    )
    server.enqueue(ROUTE, sse(new ResponsesStream().text('ok').completed()))
    const session = provider().createSession(options())
    await session.step({ signal: signal() })
    session.addToolResults([{ callId: 'call_1', name: 'take_screenshot', output: 'done', images: [] }])
    await session.step({ signal: signal() })
    const retried = server.requestsTo(ROUTE)[2].json().input
    const call = retried.find((i: { type?: string }) => i.type === 'function_call')
    expect(call).toMatchObject({ call_id: 'call_1', name: 'take_screenshot' })
    expect(call).not.toHaveProperty('id')
  })
})

describe('ResponsesProvider stream outcomes', () => {
  it('retries a response.failed server_error that happened before any text', async () => {
    server.enqueue(ROUTE, sse(new ResponsesStream().failed('server_error', 'The model failed to generate a response.')))
    server.enqueue(ROUTE, sse(new ResponsesStream().text('ok').completed()))
    const result = await provider().createSession(options()).step({ signal: signal() })
    expect(result.text).toBe('ok')
    expect(server.requestsTo(ROUTE)).toHaveLength(2)
  })

  it('maps an error event to a Russian error', async () => {
    server.on(
      ROUTE,
      sse([{ event: 'error', data: { type: 'error', code: 'insufficient_quota', message: 'You exceeded your current quota', param: null, sequence_number: 1 } }])
    )
    await expect(provider().createSession(options()).step({ signal: signal() })).rejects.toThrow(/Квота OpenAI исчерпана/)
  })

  it('reports response.incomplete as a length stop without tool calls', async () => {
    server.enqueue(ROUTE, sse(new ResponsesStream().text('Начало ответа').incomplete('max_output_tokens')))
    const result = await provider().createSession(options()).step({ signal: signal() })
    expect(result).toEqual({ text: 'Начало ответа', toolCalls: [], finishReason: 'length' })
  })

  it('accepts a stream that ends without response.completed when output exists', async () => {
    server.enqueue(ROUTE, sse(new ResponsesStream().text('Частичный ответ.').partial()))
    const result = await provider().createSession(options()).step({ signal: signal() })
    expect(result.text).toBe('Частичный ответ.')
  })

  it('fails with a clear message when the stream breaks before any output', async () => {
    server.on(ROUTE, sse([{ event: 'response.created', data: { type: 'response.created', response: { id: 'r' } } }]))
    await expect(provider().createSession(options()).step({ signal: signal() })).rejects.toThrow('Ответ модели оборвался')
    expect(server.requestsTo(ROUTE)).toHaveLength(3)
  })

  it('handles a non-streamed JSON response', async () => {
    server.enqueue(
      ROUTE,
      json(200, {
        id: 'resp_json',
        object: 'response',
        status: 'completed',
        output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Из JSON.', annotations: [] }] }]
      })
    )
    const deltas: string[] = []
    const result = await provider()
      .createSession(options())
      .step({ signal: signal(), onTextDelta: (d) => deltas.push(d) })
    expect(result.text).toBe('Из JSON.')
    expect(deltas).toEqual(['Из JSON.'])
  })

  it('stops promptly when the signal aborts mid-stream', async () => {
    const frames = new ResponsesStream().partial()
    server.on(ROUTE, sse([...frames, { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Сейчас' } }], { hang: true }))
    const ctrl = new AbortController()
    const started = Date.now()
    await expect(
      provider()
        .createSession(options())
        .step({ signal: ctrl.signal, onTextDelta: () => ctrl.abort() })
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(Date.now() - started).toBeLessThan(1500)
  })
})
