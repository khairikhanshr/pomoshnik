import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FALLBACK_TIER_MODELS, LIMITS } from '@shared/defaults'
import { toSpeakableText } from '@shared/speech-text'
import type { ChatEvent, ChatMessage } from '@shared/types'
import { TINY_PNG, toolSpec, type FakeTool } from './helpers/fakes'
import { ChatStream, MockServer, ResponsesStream, json, openAiError, sse, type Handler } from './helpers/mock-server'
import { createTestAi, waitFor, waitTurnEnd, type TestAi } from './helpers/setup'

let server: MockServer
let t: TestAi | null = null
// A fresh server per test: background title requests of one test can never reach the next one.
beforeEach(async () => {
  delete process.env.JARVIS_OPENAI_BASE_URL
  server = await MockServer.start()
  server.on(RESPONSES, titleAware())
})
afterEach(async () => {
  t?.cleanup()
  t = null
  await server.close()
})

const RESPONSES = 'POST /v1/responses'
const CHAT = 'POST /v1/chat/completions'
const TERRA = FALLBACK_TIER_MODELS.terra
const LUNA = FALLBACK_TIER_MODELS.luna

/** Answers title requests (Luna, title instructions) and falls back to `handler` for everything else. */
function titleAware(handler?: Handler, title = '«Ответы на тест».'): Handler {
  return async (req, res) => {
    const body = req.json()
    if (String(body.instructions ?? body.messages?.[0]?.content ?? '').startsWith('You name chat conversations')) {
      const frames = body.messages ? new ChatStream().text(title).done('stop') : new ResponsesStream().text(title).completed()
      return sse(frames)(req, res)
    }
    return (handler ?? sse(new ResponsesStream().text('ok').completed()))(req, res)
  }
}

/** Requests of the turn (title requests excluded). */
function turnBodies(route = RESPONSES): any[] {
  return server
    .requestsTo(route)
    .map((r) => r.json())
    .filter((b) => !String(b.instructions ?? b.messages?.[0]?.content ?? '').startsWith('You name chat conversations'))
}

function expectOrder(timeline: string[], expected: string[]): void {
  let from = 0
  for (const item of expected) {
    const at = timeline.indexOf(item, from)
    if (at < 0) throw new Error(`"${item}" not found after position ${from} in:\n${timeline.join(', ')}`)
    from = at + 1
  }
}

const screenshotTool = (t: () => TestAi): FakeTool => ({
  spec: toolSpec('take_screenshot', { display: { type: 'string' } }),
  title: () => 'Делаю снимок экрана',
  run: () => {
    const image = t().media.save(TINY_PNG, { kind: 'screenshot', mime: 'image/png', width: 1, height: 1 })
    return { ok: true, output: 'Screenshot of the primary display, 1×1 px.', summary: 'Снимок готов', images: [image] }
  }
})

describe('AssistantService — text turn', () => {
  it('streams a reply, persists it at the end and titles the chat with Luna', async () => {
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Добрый вечер, сэр. Чем могу помочь?').completed(), { delayMs: 2, maxChunk: 120 }))
    t = createTestAi(server)
    const { chatId, turnId } = await t.ai.assistant.send({ text: '  Привет, Джарвис  ', source: 'text' })
    expect(t.ai.assistant.currentTurn()).toEqual({ chatId, turnId })

    const end = (await waitTurnEnd(t, turnId)) as Extract<ChatEvent, { type: 'turn-end' }>
    expect(end.type).toBe('turn-end')
    expect(end.message).toMatchObject({ role: 'assistant', status: 'done', text: 'Добрый вечер, сэр. Чем могу помочь?', tier: 'terra', model: TERRA })
    expect(t.ai.assistant.currentTurn()).toBeNull()

    const start = t.chatEvents.find((e) => e.type === 'turn-start') as Extract<ChatEvent, { type: 'turn-start' }>
    expect(start.userMessage).toMatchObject({ role: 'user', text: 'Привет, Джарвис', source: 'text' })
    expect(start.assistantMessage).toMatchObject({ role: 'assistant', status: 'streaming', text: '' })
    const deltas = t.chatEvents.filter((e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta')
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map((d) => d.text).join('')).toBe('Добрый вечер, сэр. Чем могу помочь?')
    expect(t.chatEvents.map((e) => e.type).filter((x) => x !== 'delta')).toEqual(['turn-start', 'turn-end'])

    const chat = t.chats.raw(chatId)
    expect(chat.source).toBe('text')
    expect(chat.tier).toBe('terra')
    expect(chat.messages.map((m: ChatMessage) => [m.role, m.status ?? null, m.text])).toEqual([
      ['user', null, 'Привет, Джарвис'],
      ['assistant', 'done', 'Добрый вечер, сэр. Чем могу помочь?']
    ])

    // state: thinking with transcript → throttled response updates → idle
    expect(t.states[0]).toMatchObject({ phase: 'thinking', transcript: 'Привет, Джарвис', response: '', chatId, turnId })
    const last = t.states[t.states.length - 1]
    expect(last).toMatchObject({ phase: 'idle', response: 'Добрый вечер, сэр. Чем могу помочь?' })
    expect(t.speak).toEqual([])

    const body = turnBodies()[0]
    expect(body.model).toBe(TERRA)
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'Привет, Джарвис' }] }])
    expect(body.instructions).toContain('J.A.R.V.I.S.')
    expect(body.instructions).toContain('"сэр"')
    expect(body.instructions).toContain('Cmd')
    expect(body.instructions).toContain('## Text reply')

    await waitFor(() => t!.chats.raw(chatId).title !== 'Новый чат', 3000, 'title')
    expect(t.chats.raw(chatId).title).toBe('Ответы на тест')
    const titleReq = server
      .requestsTo(RESPONSES)
      .map((r) => r.json())
      .find((b) => String(b.instructions).startsWith('You name chat conversations'))
    expect(titleReq.model).toBe(LUNA)
    expect(titleReq).not.toHaveProperty('tools')
    expect(titleReq.reasoning).toEqual({ effort: 'low' })
    expect(titleReq.input[0].content[0].text).toContain('Привет, Джарвис')
  })

  it('uses the requested tier, updates the chat tier and keeps history in later turns', async () => {
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Первый ответ.').completed()))
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Второй ответ.').completed()))
    t = createTestAi(server, { settings: { tiers: { sol: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } } } })
    const first = await t.ai.assistant.send({ text: 'Первый вопрос', source: 'text' })
    await waitTurnEnd(t, first.turnId)
    const second = await t.ai.assistant.send({ chatId: first.chatId, text: 'Второй вопрос', source: 'text', tier: 'sol' })
    expect(second.chatId).toBe(first.chatId)
    await waitTurnEnd(t, second.turnId)
    expect(t.chats.raw(first.chatId).tier).toBe('sol')
    const body = turnBodies()[1]
    expect(body.model).toBe('gpt-6.1-sol')
    expect(body.reasoning).toEqual({ effort: 'high' })
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Первый вопрос' }] },
      { role: 'assistant', content: 'Первый ответ.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Второй вопрос' }] }
    ])
  })

  it('rejects an empty request', async () => {
    t = createTestAi(server)
    await expect(t.ai.assistant.send({ text: '   ', source: 'text' })).rejects.toThrow(/Пустой запрос/)
    expect(t.chats.chats.size).toBe(0)
  })

  it('throttles streaming response state updates', async () => {
    const long = Array.from({ length: 80 }, (_, i) => `слово${i}`).join(' ')
    // paced over ~300 ms so that several throttle windows elapse
    server.enqueue(RESPONSES, sse(new ResponsesStream().text(long).completed(), { delayMs: 2, maxChunk: 200 }))
    t = createTestAi(server, { tuning: { stateThrottleMs: 40 } })
    const { turnId } = await t.ai.assistant.send({ text: 'Скажи много слов', source: 'text' })
    await waitTurnEnd(t, turnId)
    const deltas = t.chatEvents.filter((e) => e.type === 'delta').length
    const updates = t.states.filter((s) => s.phase === 'thinking' && s.response).length
    expect(deltas).toBe(80)
    expect(updates).toBeGreaterThanOrEqual(1)
    expect(updates).toBeLessThan(deltas / 4)
    expect(t.bus.getState().response).toBe(long)
  })

  it('sends attached images with the configured detail', async () => {
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Это график.').completed()))
    t = createTestAi(server, { settings: { imageDetail: 'low' } })
    const image = t.media.save(TINY_PNG, { kind: 'upload', mime: 'image/png' })
    const { turnId, chatId } = await t.ai.assistant.send({ text: 'Что это?', images: [image.id, 'missing'], source: 'text' })
    await waitTurnEnd(t, turnId)
    expect(t.chats.raw(chatId).messages[0].images).toEqual([image])
    expect(turnBodies()[0].input[0].content).toEqual([
      { type: 'input_text', text: 'Что это?' },
      { type: 'input_image', image_url: `data:image/png;base64,${TINY_PNG.toString('base64')}`, detail: 'low' }
    ])
    expect(t.media.dataUrlCalls[0]).toEqual({ id: image.id, maxSide: LIMITS.screenshotMaxSide })
  })
})

describe('AssistantService — voice turn with tools', () => {
  it('runs screenshot → answer, emits tool events, images and speak chunks in order', async () => {
    const answer =
      'Вопрос 1 — B: Париж, столица Франции. Вопрос 2 — C: четыре, так как два плюс два. Вопрос 3 — A: вода кипит при ста градусах.'
    server.enqueue(
      RESPONSES,
      sse(
        new ResponsesStream('resp_1')
          .reasoning('rs_1', 'enc-1')
          .text('Сейчас посмотрю, сэр.')
          .functionCall('call_shot', 'take_screenshot', { display: 'cursor' })
          .completed()
      )
    )
    server.enqueue(RESPONSES, sse(new ResponsesStream('resp_2').text(answer).completed(), { delayMs: 2, maxChunk: 160 }))
    t = createTestAi(server, { tools: [screenshotTool(() => t!)], settings: { voiceTier: 'sol' } })

    const { chatId, turnId } = await t.ai.assistant.send({ text: 'Сделай скриншот и ответь на вопросы теста', source: 'voice' })
    const end = (await waitTurnEnd(t, turnId)) as Extract<ChatEvent, { type: 'turn-end' }>
    expect(end.type).toBe('turn-end')

    const chat = t.chats.raw(chatId)
    expect(chat.source).toBe('voice')
    expect(chat.tier).toBe('sol')
    const message = chat.messages[1]
    expect(message.status).toBe('done')
    expect(message.model).toBe(FALLBACK_TIER_MODELS.sol)
    expect(message.text).toBe(`Сейчас посмотрю, сэр.\n\n${answer}`)
    expect(message.toolCalls).toMatchObject([
      { id: 'call_shot', name: 'take_screenshot', title: 'Делаю снимок экрана', status: 'ok', summary: 'Снимок готов', args: { display: 'cursor' } }
    ])
    expect(message.images).toHaveLength(1)

    expectOrder(t.timeline, [
      'chat:turn-start',
      'state:thinking',
      'chat:delta',
      'speak',
      'chat:tool-start',
      'state:acting',
      'chat:image',
      'chat:tool-end',
      'state:thinking',
      'chat:delta',
      'chat:turn-end',
      'speak',
      'state:speaking'
    ])
    const acting = t.states.find((s) => s.phase === 'acting')
    expect(acting?.toolTitle).toBe('Делаю снимок экрана')

    // speak chunks: seq order, early first chunk, a single final chunk, text = speakable reply
    expect(t.speak.map((c) => c.seq)).toEqual(t.speak.map((_c, i) => i))
    expect(t.speak.every((c) => c.turnId === turnId)).toBe(true)
    expect(t.speak[0].text).toBe('Сейчас посмотрю, сэр.')
    expect(t.speak.filter((c) => c.final)).toHaveLength(1)
    expect(t.speak[t.speak.length - 1].final).toBe(true)
    expect(t.speak.map((c) => c.text).filter(Boolean).join(' ')).toBe(toSpeakableText(message.text).replace(/\n/g, ' '))

    // tool context
    expect(t.tools.calls[0]).toMatchObject({ name: 'take_screenshot', args: { display: 'cursor' } })
    expect(t.tools.calls[0].ctx).toMatchObject({ chatId, turnId, source: 'voice' })
    expect(t.tools.calls[0].ctx.signal).toBeInstanceOf(AbortSignal)

    // second model call: replayed items, tool output and the screenshot as a user message
    const second = turnBodies()[1]
    expect(second.instructions).toContain('Spoken reply')
    expect(second.input.slice(1)).toEqual([
      { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc-1' },
      {
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', annotations: [], logprobs: [], text: 'Сейчас посмотрю, сэр.' }]
      },
      {
        id: 'fc_2',
        type: 'function_call',
        status: 'completed',
        arguments: '{"display":"cursor"}',
        call_id: 'call_shot',
        name: 'take_screenshot'
      },
      { type: 'function_call_output', call_id: 'call_shot', output: 'Screenshot of the primary display, 1×1 px.' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Снимок экрана (результат take_screenshot):' },
          { type: 'input_image', image_url: `data:image/png;base64,${TINY_PNG.toString('base64')}`, detail: 'high' }
        ]
      }
    ])

    // the voice window reports speech-done: state stays as the voice window sets it
    expect(t.bus.getState().phase).toBe('speaking')
    t.bus.emit('speech-done', { turnId, interrupted: false })
  })

  it('reuses the recent voice chat and summarizes earlier tool calls into history', async () => {
    server.enqueue(RESPONSES, sse(new ResponsesStream().functionCall('call_1', 'take_screenshot', {}).completed()))
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('На экране тест.').completed()))
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Второй вопрос — C.').completed()))
    t = createTestAi(server, { tools: [screenshotTool(() => t!)], settings: { speakMode: 'never' } })
    const first = await t.ai.assistant.send({ text: 'Что на экране?', source: 'voice' })
    await waitTurnEnd(t, first.turnId)
    const second = await t.ai.assistant.send({ text: 'А второй вопрос?', source: 'voice' })
    expect(second.chatId).toBe(first.chatId)
    await waitTurnEnd(t, second.turnId)
    expect(t.speak).toEqual([])

    const input = turnBodies()[2].input
    expect(input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'Что на экране?' }] })
    // tool screenshot of the earlier reply is still among the last image messages: sent before that reply
    expect(input[1].role).toBe('user')
    expect(input[1].content[1].type).toBe('input_image')
    expect(input[2]).toEqual({
      role: 'assistant',
      content: '[Действия: Делаю снимок экрана — Снимок готов ✓]\n\nНа экране тест.'
    })
    expect(input[3]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'А второй вопрос?' }] })
    expect(input.some((i: { type?: string }) => i.type === 'function_call')).toBe(false)
  })

  it('starts a new voice chat once the reuse window has passed', async () => {
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Первый.').completed()))
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Второй.').completed()))
    t = createTestAi(server, { settings: { speakMode: 'never' }, tuning: { voiceChatMaxAgeMs: 30 } })
    const first = await t.ai.assistant.send({ text: 'Раз', source: 'voice' })
    await waitTurnEnd(t, first.turnId)
    await new Promise((r) => setTimeout(r, 60))
    const second = await t.ai.assistant.send({ text: 'Два', source: 'voice' })
    await waitTurnEnd(t, second.turnId)
    expect(second.chatId).not.toBe(first.chatId)
    expect(t.chats.raw(second.chatId).source).toBe('voice')
    // cancel without an active turn is a no-op
    t.ai.assistant.cancel()
    expect(t.ai.assistant.currentTurn()).toBeNull()
  })

  it('returns errors to the model for invalid JSON, unknown tools and denials', async () => {
    server.enqueue(
      RESPONSES,
      sse(
        new ResponsesStream()
          .functionCall('call_bad', 'take_screenshot', '{"display": ')
          .functionCall('call_unknown', 'format_disk', {})
          .functionCall('call_denied', 'system_power', { action: 'shutdown' })
          .completed()
      )
    )
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Не получилось, сэр.').completed()))
    const power: FakeTool = {
      spec: toolSpec('system_power', { action: { type: 'string' } }),
      title: () => 'Выключаю компьютер',
      run: () => ({ ok: false, output: 'User denied the action: shutdown.' })
    }
    t = createTestAi(server, { tools: [screenshotTool(() => t!), power] })
    const { turnId, chatId } = await t.ai.assistant.send({ text: 'Выключи компьютер', source: 'text' })
    await waitTurnEnd(t, turnId)
    const outputs = turnBodies()[1].input.filter((i: { type?: string }) => i.type === 'function_call_output')
    expect(outputs[0].output).toMatch(/^Error: invalid JSON arguments for take_screenshot/)
    expect(outputs[1].output).toMatch(/^Error: unknown tool "format_disk"/)
    expect(outputs[2].output).toBe('User denied the action: shutdown.')
    expect(t.tools.calls.map((c) => c.name)).toEqual(['system_power'])
    const calls = t.chats.raw(chatId).messages[1].toolCalls!
    expect(calls.map((c) => c.status)).toEqual(['error', 'error', 'denied'])
  })

  it('truncates long tool output for the model', async () => {
    server.enqueue(RESPONSES, sse(new ResponsesStream().functionCall('call_1', 'read_text_file', { path: '~/a.txt' }).completed()))
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Прочитал.').completed()))
    const reader: FakeTool = { spec: toolSpec('read_text_file'), run: () => ({ ok: true, output: 'x'.repeat(20_000) }) }
    t = createTestAi(server, { tools: [reader] })
    const { turnId } = await t.ai.assistant.send({ text: 'Прочитай файл', source: 'text' })
    await waitTurnEnd(t, turnId)
    const output = turnBodies()[1].input.find((i: { type?: string }) => i.type === 'function_call_output').output
    expect(output.length).toBeLessThan(LIMITS.maxToolOutputChars + 100)
    expect(output).toContain('[truncated: 12000 more characters]')
  })

  it('stops after LIMITS.maxToolSteps model calls', async () => {
    let n = 0
    server.on(
      RESPONSES,
      titleAware(async (req, res) => sse(new ResponsesStream().functionCall(`call_${n++}`, 'take_screenshot', {}).completed())(req, res))
    )
    t = createTestAi(server, { tools: [screenshotTool(() => t!)] })
    const { turnId, chatId } = await t.ai.assistant.send({ text: 'Делай скриншоты', source: 'text' })
    await waitTurnEnd(t, turnId, 10_000)
    const bodies = turnBodies()
    expect(bodies).toHaveLength(LIMITS.maxToolSteps)
    expect(bodies[bodies.length - 1].tool_choice).toBe('none')
    expect(bodies.slice(0, -1).every((b) => b.tool_choice === 'auto')).toBe(true)
    // in-turn screenshots are bounded: older ones are replaced by a note
    const last = bodies[bodies.length - 1]
    const images = JSON.stringify(last.input).match(/input_image/g) ?? []
    expect(images.length).toBe(3)
    const message = t.chats.raw(chatId).messages[1]
    expect(message.status).toBe('done')
    expect(message.toolCalls).toHaveLength(LIMITS.maxToolSteps - 1)
    expect(message.text).toMatch(/Не успел завершить задачу/)
  })
})

describe('AssistantService — browser search alias', () => {
  it('maps open_web_search back to web_search for describe(), execute() and the tool chip', async () => {
    server.enqueue(
      RESPONSES,
      sse(new ResponsesStream('resp_1').functionCall('call_ws', 'open_web_search', { query: 'погода в Алматы' }).completed())
    )
    server.enqueue(RESPONSES, sse(new ResponsesStream('resp_2').text('Открыл поиск, сэр.').completed()))
    const searchTool: FakeTool = {
      spec: toolSpec('web_search', { query: { type: 'string' } }),
      title: (args) => `Открываю поиск «${String(args.query)}»`,
      run: () => ({ ok: true, output: 'Opened google search results.', summary: 'Поиск: погода в Алматы' })
    }
    t = createTestAi(server, { tools: [searchTool], settings: { webSearch: true } })
    const described: string[] = []
    const describe = t.tools.describe.bind(t.tools)
    t.tools.describe = (name, args) => {
      described.push(name)
      return describe(name, args)
    }

    const { turnId } = await t.ai.assistant.send({ text: 'Открой поиск погоды в Алматы', source: 'text' })
    const end = (await waitTurnEnd(t, turnId)) as Extract<ChatEvent, { type: 'turn-end' }>

    // The model sees the alias next to the built-in search…
    const first = turnBodies()[0]
    expect(first.tools.map((tool: { name?: string; type: string }) => tool.name ?? tool.type)).toEqual(['open_web_search', 'web_search'])
    expect(first.instructions).toContain('open_web_search only opens a search page')
    // …but the registry and the UI only ever see the real tool name.
    expect(described).toEqual(['web_search'])
    expect(t.tools.calls.map((c) => c.name)).toEqual(['web_search'])
    const starts = t.chatEvents.filter((e): e is Extract<ChatEvent, { type: 'tool-start' }> => e.type === 'tool-start')
    expect(starts.map((e) => [e.call.name, e.call.title])).toEqual([['web_search', 'Открываю поиск «погода в Алматы»']])
    expect(end.message.toolCalls).toMatchObject([
      { id: 'call_ws', name: 'web_search', title: 'Открываю поиск «погода в Алматы»', status: 'ok', summary: 'Поиск: погода в Алматы' }
    ])
    // The function call is answered under the call id the model used.
    expect(turnBodies()[1].input).toContainEqual({ type: 'function_call_output', call_id: 'call_ws', output: 'Opened google search results.' })
  })
})

describe('AssistantService — cancellation', () => {
  it('cancel() aborts the stream, marks the message cancelled and stops speaking', async () => {
    let closed = false
    server.enqueue(RESPONSES, async (req, res) => {
      res.on('close', () => (closed = true))
      const frames = new ResponsesStream().partial()
      frames.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'Начинаю длинный ответ' } })
      await sse(frames, { hang: true })(req, res)
    })
    t = createTestAi(server, { settings: { speakMode: 'always' } })
    const { turnId, chatId } = await t.ai.assistant.send({ text: 'Расскажи длинную историю', source: 'text' })
    await waitFor(() => t!.chatEvents.some((e) => e.type === 'delta'), 3000, 'first delta')
    t.ai.assistant.cancel('other-turn')
    expect(t.ai.assistant.currentTurn()?.turnId).toBe(turnId)
    t.ai.assistant.cancel(turnId)

    const end = t.chatEvents.find((e) => e.type === 'turn-end') as Extract<ChatEvent, { type: 'turn-end' }>
    expect(end.message).toMatchObject({ status: 'cancelled', text: 'Начинаю длинный ответ' })
    expect(t.chats.raw(chatId).messages[1]).toMatchObject({ status: 'cancelled', text: 'Начинаю длинный ответ' })
    expect(t.timeline).toContain('stop-speaking')
    expect(t.bus.getState().phase).toBe('idle')
    expect(t.ai.assistant.currentTurn()).toBeNull()
    await waitFor(() => closed, 3000, 'aborted connection')
    expect(t.speak.some((c) => c.final)).toBe(false)
    // nothing else arrives for the cancelled turn
    const count = t.chatEvents.length
    await new Promise((r) => setTimeout(r, 50))
    expect(t.chatEvents.length).toBe(count)
  })

  it('a new send cancels the running turn first, and tools see the abort', async () => {
    let toolSignal: AbortSignal | null = null
    const slow: FakeTool = {
      spec: toolSpec('wait_long'),
      title: () => 'Жду',
      run: (_args, ctx) =>
        new Promise((resolve) => {
          toolSignal = ctx.signal
          ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: 'Error: aborted' }))
        })
    }
    server.enqueue(RESPONSES, sse(new ResponsesStream().functionCall('call_w', 'wait_long', {}).completed()))
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Новый ответ.').completed()))
    t = createTestAi(server, { tools: [slow] })
    const first = await t.ai.assistant.send({ text: 'Подожди', source: 'text' })
    await waitFor(() => toolSignal, 3000, 'tool start')
    const second = await t.ai.assistant.send({ chatId: first.chatId, text: 'Отмена, новый вопрос', source: 'text' })
    expect(toolSignal!.aborted).toBe(true)
    await waitTurnEnd(t, second.turnId)

    const types = t.chatEvents.map((e) => `${e.type}:${'turnId' in e ? e.turnId : ''}`)
    const firstEnd = types.indexOf(`turn-end:${first.turnId}`)
    const secondStart = types.indexOf(`turn-start:${second.turnId}`)
    expect(firstEnd).toBeGreaterThanOrEqual(0)
    expect(firstEnd).toBeLessThan(secondStart)
    const messages = t.chats.raw(first.chatId).messages
    expect(messages[1]).toMatchObject({ status: 'cancelled' })
    expect(messages[1].toolCalls?.[0]).toMatchObject({ status: 'error', summary: 'Отменено' })
    expect(messages[3]).toMatchObject({ status: 'done', text: 'Новый ответ.' })
  })
})

describe('AssistantService — errors', () => {
  it('maps API errors to turn-error, error state and a spoken short error', async () => {
    server.enqueue(RESPONSES, openAiError(401, 'Incorrect API key provided: sk-test***.', 'invalid_api_key'))
    t = createTestAi(server)
    const { turnId, chatId } = await t.ai.assistant.send({ text: 'Который час?', source: 'voice' })
    const ev = (await waitTurnEnd(t, turnId)) as Extract<ChatEvent, { type: 'turn-error' }>
    expect(ev.type).toBe('turn-error')
    expect(ev.error).toBe('API-ключ OpenAI недействителен или отозван (401). Проверьте ключ в Настройках → ИИ.')
    expect(t.chats.raw(chatId).messages[1]).toMatchObject({ status: 'error', error: ev.error })
    expect(t.bus.getState()).toMatchObject({ phase: 'error', error: ev.error })
    expect(t.speak).toEqual([
      { turnId, seq: 0, text: 'Прошу прощения, сэр. API-ключ OpenAI недействителен или отозван (401).', final: true }
    ])
    await waitFor(() => t!.bus.getState().phase === 'idle', 2000, 'error reset')
    // title falls back to the user text without another request
    await waitFor(() => t!.chats.raw(chatId).title === 'Который час?', 2000, 'fallback title')
    expect(server.requestsTo(RESPONSES)).toHaveLength(1)
  })

  it('reports a missing API key without any request', async () => {
    t = createTestAi(server, { apiKey: null })
    const { turnId } = await t.ai.assistant.send({ text: 'Привет', source: 'text' })
    const ev = (await waitTurnEnd(t, turnId)) as Extract<ChatEvent, { type: 'turn-error' }>
    expect(ev.error).toBe('Не задан API-ключ OpenAI. Откройте Настройки → ИИ.')
    expect(server.requests).toHaveLength(0)
  })

  it('retries a 500 and succeeds within the same turn', async () => {
    server.enqueue(RESPONSES, openAiError(500, 'The server had an error while processing your request.', null, 'server_error'))
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Получилось.').completed()))
    t = createTestAi(server)
    const { turnId } = await t.ai.assistant.send({ text: 'Привет', source: 'text' })
    const ev = await waitTurnEnd(t, turnId)
    expect(ev.type).toBe('turn-end')
    expect(turnBodies()).toHaveLength(2)
  })
})

describe('AssistantService — Chat Completions mode', () => {
  it('runs a tool loop through /chat/completions', async () => {
    server.enqueue(CHAT, sse(new ChatStream().toolCall(0, 'call_1', 'open_application', { name: 'Telegram' }).done('tool_calls')))
    server.enqueue(CHAT, sse(new ChatStream().text('Открыл Telegram, сэр.').done('stop')))
    server.on(CHAT, titleAware(undefined, 'Открытие Telegram'))
    const open: FakeTool = {
      spec: toolSpec('open_application', { name: { type: 'string' } }),
      title: (a) => `Открываю «${String(a.name)}»`,
      run: () => ({ ok: true, output: 'Opened Telegram', summary: 'Открыто: Telegram' })
    }
    t = createTestAi(server, { tools: [open], settings: { apiMode: 'chat', webSearch: true } })
    const { turnId, chatId } = await t.ai.assistant.send({ text: 'Открой телеграм', source: 'text' })
    await waitTurnEnd(t, turnId)
    const bodies = turnBodies(CHAT)
    expect(bodies[0].messages[0].role).toBe('system')
    expect(bodies[0].tools.map((x: { function: { name: string } }) => x.function.name)).toEqual(['open_application'])
    expect(bodies[0].reasoning_effort).toBe('low')
    expect(bodies[1].messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'open_application', arguments: '{"name":"Telegram"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Opened Telegram' }
    ])
    expect(t.chats.raw(chatId).messages[1]).toMatchObject({ status: 'done', text: 'Открыл Telegram, сэр.' })
    await waitFor(() => t!.chats.raw(chatId).title === 'Открытие Telegram', 3000, 'title')
    expect(server.requestsTo(RESPONSES)).toHaveLength(0)
  })
})

describe('AssistantService — speaking state', () => {
  it('resets a stale speaking state when the voice window never reports speech-done', async () => {
    server.enqueue(RESPONSES, sse(new ResponsesStream().text('Готово, сэр.').completed()))
    t = createTestAi(server, { settings: { speakMode: 'always' } })
    const { turnId } = await t.ai.assistant.send({ text: 'Открой заметки', source: 'text' })
    await waitTurnEnd(t, turnId)
    expect(t.bus.getState().phase).toBe('speaking')
    expect(t.speak).toEqual([{ turnId, seq: 0, text: 'Готово, сэр.', final: true }])
    await waitFor(() => t!.bus.getState().phase === 'idle', 2000, 'watchdog')
  })
})

describe('testConnection', () => {
  it('reports the model count from GET /models', async () => {
    server.on('GET /v1/models', json(200, { data: [{ id: 'a' }, { id: 'b' }, { id: 'gpt-6-sol' }] }))
    t = createTestAi(server)
    expect(await t.ai.assistant.testConnection()).toEqual({ ok: true, message: 'Подключение работает. Доступно моделей: 3' })
  })

  it('falls back to a tiny Luna request when /models is missing', async () => {
    server.on('GET /v1/models', json(404, { error: { message: 'Not found' } }))
    t = createTestAi(server)
    const result = await t.ai.assistant.testConnection()
    expect(result.ok).toBe(true)
    expect(result.message).toContain(LUNA)
    const ping = server.requestsTo(RESPONSES)[0].json()
    expect(ping).toMatchObject({ model: LUNA, max_output_tokens: 16 })
  })

  it('returns Russian errors', async () => {
    server.on('GET /v1/models', openAiError(401, 'Incorrect API key provided', 'invalid_api_key'))
    t = createTestAi(server)
    expect(await t.ai.assistant.testConnection()).toEqual({ ok: false, message: 'API-ключ OpenAI недействителен или отозван (401). Проверьте ключ в Настройках → ИИ.' })
    const noKey = createTestAi(server, { apiKey: null })
    expect(await noKey.ai.assistant.testConnection()).toEqual({ ok: false, message: 'Не задан API-ключ OpenAI. Откройте Настройки → ИИ.' })
    noKey.cleanup()
  })
})
