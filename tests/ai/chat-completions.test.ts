import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChatCompletionsProvider, accumulateToolCall } from '../../src/main/ai/chat-completions'
import { DEFAULT_HTTP_TUNING, OpenAiClient } from '../../src/main/ai/http'
import type { SessionOptions } from '../../src/main/ai/provider'
import { FakeSecrets, FakeSettings, memoryLog, toolSpec } from './helpers/fakes'
import { ChatStream, MockServer, openAiError, sse, type SseFrame } from './helpers/mock-server'

let server: MockServer
beforeAll(async () => {
  server = await MockServer.start()
})
afterAll(() => server.close())
beforeEach(() => server.reset())

const ROUTE = 'POST /v1/chat/completions'
const IMG = 'data:image/png;base64,AAAA'
const signal = (): AbortSignal => new AbortController().signal

function provider(): ChatCompletionsProvider {
  const http = new OpenAiClient({
    settings: new FakeSettings({ baseUrl: `${server.url}/v1` }),
    secrets: new FakeSecrets(),
    tuning: { ...DEFAULT_HTTP_TUNING, retryBaseDelayMs: 5 },
    log: memoryLog()
  })
  return new ChatCompletionsProvider(http, memoryLog())
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
          { type: 'text', text: 'Что тут?' },
          { type: 'image', url: IMG, detail: 'high' }
        ]
      }
    ],
    tools: [toolSpec('open_application', { name: { type: 'string' } })],
    webSearch: true,
    effort: 'medium',
    ...patch
  }
}

describe('ChatCompletionsProvider', () => {
  it('sends system persona, image parts, function tools and reasoning_effort', async () => {
    server.enqueue(ROUTE, sse(new ChatStream().text('Это окно Finder.').done('stop')))
    const deltas: string[] = []
    const result = await provider()
      .createSession(options())
      .step({ signal: signal(), onTextDelta: (d) => deltas.push(d) })
    expect(result).toEqual({ text: 'Это окно Finder.', toolCalls: [], finishReason: 'stop' })
    expect(deltas.join('')).toBe('Это окно Finder.')
    expect(server.requestsTo(ROUTE)[0].json()).toEqual({
      model: 'gpt-6-terra',
      messages: [
        { role: 'system', content: 'You are Jarvis.' },
        { role: 'user', content: 'Привет' },
        { role: 'assistant', content: 'Добрый день, сэр.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Что тут?' },
            { type: 'image_url', image_url: { url: IMG, detail: 'high' } }
          ]
        }
      ],
      stream: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'open_application',
            description: 'Test tool open_application',
            parameters: { type: 'object', properties: { name: { type: 'string' } } }
          }
        }
      ],
      tool_choice: 'auto',
      reasoning_effort: 'medium'
    })
  })

  it('accumulates streamed tool calls by index and replays them in the next step', async () => {
    // Two parallel calls with interleaved argument fragments.
    const head = new ChatStream().text('Открываю. ')
    const frames = head.done('tool_calls').slice(0, -2)
    const chunk = (delta: Record<string, unknown>, finish: string | null = null): SseFrame => ({
      data: { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }
    })
    frames.push(
      chunk({ tool_calls: [{ index: 0, id: 'call_tg', type: 'function', function: { name: 'open_application', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"na' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_sf', type: 'function', function: { name: 'open_application', arguments: '{"name"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'me": "Telegram"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: ': "Safari"}' } }] }),
      chunk({}, 'tool_calls'),
      { data: '[DONE]' }
    )
    server.enqueue(ROUTE, sse(frames))
    server.enqueue(ROUTE, sse(new ChatStream().text('Готово, сэр.').done('stop')))

    const session = provider().createSession(options())
    const step1 = await session.step({ signal: signal() })
    expect(step1.finishReason).toBe('tool_calls')
    expect(step1.text).toBe('Открываю. ')
    expect(step1.toolCalls).toEqual([
      { id: 'call_tg', name: 'open_application', arguments: '{"name": "Telegram"}' },
      { id: 'call_sf', name: 'open_application', arguments: '{"name": "Safari"}' }
    ])
    session.addToolResults([
      { callId: 'call_tg', name: 'open_application', output: 'Opened Telegram', images: [] },
      { callId: 'call_sf', name: 'open_application', output: 'Opened Safari', images: [{ url: IMG, detail: 'low' }] }
    ])
    const step2 = await session.step({ signal: signal() })
    expect(step2.text).toBe('Готово, сэр.')

    const messages = server.requestsTo(ROUTE)[1].json().messages
    expect(messages.slice(4)).toEqual([
      {
        role: 'assistant',
        content: 'Открываю. ',
        tool_calls: [
          { id: 'call_tg', type: 'function', function: { name: 'open_application', arguments: '{"name": "Telegram"}' } },
          { id: 'call_sf', type: 'function', function: { name: 'open_application', arguments: '{"name": "Safari"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call_tg', content: 'Opened Telegram' },
      { role: 'tool', tool_call_id: 'call_sf', content: 'Opened Safari' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Изображение (результат open_application):' },
          { type: 'image_url', image_url: { url: IMG, detail: 'low' } }
        ]
      }
    ])
  })

  it('uses content null for an assistant message with only tool calls', async () => {
    server.enqueue(ROUTE, sse(new ChatStream().toolCall(0, 'call_1', 'open_application', { name: 'Notes' }).done('tool_calls')))
    server.enqueue(ROUTE, sse(new ChatStream().text('ok').done('stop')))
    const session = provider().createSession(options())
    await session.step({ signal: signal() })
    session.addToolResults([{ callId: 'call_1', name: 'open_application', output: 'ok', images: [] }])
    await session.step({ signal: signal() })
    const assistant = server.requestsTo(ROUTE)[1].json().messages[4]
    expect(assistant.content).toBeNull()
    expect(assistant.tool_calls[0].function.arguments).toBe('{"name":"Notes"}')
  })

  it('drops reasoning_effort after a 400 and remembers it', async () => {
    server.enqueue(
      ROUTE,
      openAiError(400, "Unrecognized request argument supplied: reasoning_effort", null, 'invalid_request_error', 'reasoning_effort')
    )
    server.on(ROUTE, sse(new ChatStream().text('ok').done('stop')))
    const p = provider()
    await p.createSession(options()).step({ signal: signal() })
    await p.createSession(options()).step({ signal: signal() })
    const bodies = server.requestsTo(ROUTE).map((r) => r.json())
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(['medium', undefined, undefined])
  })

  it('drops tools for proxies that reject them', async () => {
    server.enqueue(ROUTE, openAiError(400, 'tools is not supported by this model', null, 'invalid_request_error', 'tools'))
    server.on(ROUTE, sse(new ChatStream().text('ok').done('stop')))
    await provider().createSession(options({ effort: 'auto' })).step({ signal: signal() })
    const bodies = server.requestsTo(ROUTE).map((r) => r.json())
    expect(bodies[0].tools).toHaveLength(1)
    expect(bodies[1]).not.toHaveProperty('tools')
  })

  it("omits reasoning_effort for 'auto' and reports length stops without tool calls", async () => {
    server.enqueue(ROUTE, sse(new ChatStream().text('Обрезанный').toolCall(0, 'c1', 'open_application', '{"na').done('length')))
    const result = await provider().createSession(options({ effort: 'auto' })).step({ signal: signal() })
    expect(server.requestsTo(ROUTE)[0].json()).not.toHaveProperty('reasoning_effort')
    expect(result).toEqual({ text: 'Обрезанный', toolCalls: [], finishReason: 'length' })
  })

  it('maps an error object inside the stream', async () => {
    server.on(ROUTE, sse([{ data: { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } } }]))
    await expect(provider().createSession(options()).step({ signal: signal() })).rejects.toThrow(/Слишком много запросов/)
  })
})

describe('accumulateToolCall', () => {
  it('copes with servers that omit index or repeat the name', () => {
    const calls = new Map()
    accumulateToolCall(calls, { id: 'a', function: { name: 'open_application', arguments: '{"name":' } })
    accumulateToolCall(calls, { function: { name: 'open_application', arguments: '"Zoom"}' } })
    accumulateToolCall(calls, { id: 'b', function: { name: 'set_', arguments: '' } })
    accumulateToolCall(calls, { id: 'b', function: { name: 'volume', arguments: '{"level":30}' } })
    expect([...calls.values()]).toEqual([
      { id: 'a', name: 'open_application', args: '{"name":"Zoom"}' },
      { id: 'b', name: 'set_volume', args: '{"level":30}' }
    ])
  })
})
