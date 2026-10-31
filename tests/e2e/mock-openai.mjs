// Mock OpenAI + ElevenLabs server for end-to-end tests.
// Usage: const srv = await startMockServer(); srv.url -> 'http://127.0.0.1:<port>'; srv.requests; srv.config; await srv.close()
// Scenarios (by the last user text of a /responses or /chat/completions request):
//   contains "врем" / "time" -> first step calls get_datetime, second step answers with the tool output
//   request has no tools (title generation) -> "Проверка связи"
//   anything else -> echo answer
// config: transcript (STT result), badKeys (Bearer keys answered with 401 invalid_api_key),
//         sseDelayMs (pause between SSE events, to make streaming observable).
import { createServer } from 'node:http'

const MODELS = [
  'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol',
  'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1', 'gpt-4o-mini-tts', 'tts-1'
]

function wavTone(seconds = 0.4, rate = 24000) {
  const n = Math.floor(seconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000), 44 + i * 2)
  return buf
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function sse(res, events, delayMs = 0) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const e of events) {
    if (e === '[DONE]') res.write('data: [DONE]\n\n')
    else res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    if (delayMs) await pause(delayMs)
  }
  res.end()
}

/** Text fields of a multipart/form-data body (file parts are skipped). */
function multipartFields(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!boundary) return {}
  const fields = {}
  for (const part of body.toString('latin1').split(`--${boundary[1] ?? boundary[2]}`)) {
    const head = /^\r\nContent-Disposition: form-data; name="([^"]+)"(; filename="([^"]*)")?/i.exec(part)
    if (!head) continue
    const start = part.indexOf('\r\n\r\n')
    if (head[2]) {
      fields[head[1]] = { filename: head[3], bytes: part.length - start - 6 }
      continue
    }
    fields[head[1]] = Buffer.from(part.slice(start + 4, part.length - 2), 'latin1').toString('utf8')
  }
  return fields
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join(' ')
  return ''
}

function lastUserText(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it && it.role === 'user') return textOf(it.content)
  }
  return ''
}

function planReply(userText, hasToolOutput, toolOutput, hasTools) {
  if (!hasTools) return { text: 'Проверка связи' }
  if (/врем|time/i.test(userText)) {
    if (!hasToolOutput) return { call: { name: 'get_datetime', args: '{}' } }
    return { text: `Сейчас ${String(toolOutput).slice(0, 60)}, сэр.` }
  }
  return { text: `Тестовый ответ Джарвиса: ${userText.slice(0, 80)}` }
}

function responsesEvents(plan, n) {
  const respId = `resp_${n}`
  const reasoning = { id: `rs_${n}`, type: 'reasoning', summary: [], encrypted_content: `enc_${n}` }
  const events = [{ type: 'response.created', response: { id: respId, object: 'response', status: 'in_progress', output: [] } }]
  events.push({ type: 'response.output_item.added', output_index: 0, item: reasoning })
  events.push({ type: 'response.output_item.done', output_index: 0, item: reasoning })
  let item
  if (plan.call) {
    item = { id: `fc_${n}`, type: 'function_call', status: 'completed', call_id: `call_${n}`, name: plan.call.name, arguments: plan.call.args }
    events.push({ type: 'response.output_item.added', output_index: 1, item: { ...item, status: 'in_progress', arguments: '' } })
    events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 1, delta: plan.call.args })
    events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 1, arguments: plan.call.args })
  } else {
    item = { id: `msg_${n}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: plan.text, annotations: [] }] }
    events.push({ type: 'response.output_item.added', output_index: 1, item: { ...item, status: 'in_progress', content: [] } })
    for (const piece of plan.text.match(/.{1,12}/gsu) ?? []) {
      events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: 1, content_index: 0, delta: piece })
    }
    events.push({ type: 'response.output_text.done', item_id: item.id, output_index: 1, content_index: 0, text: plan.text })
  }
  events.push({ type: 'response.output_item.done', output_index: 1, item })
  events.push({ type: 'response.completed', response: { id: respId, object: 'response', status: 'completed', output: [reasoning, item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
  return events
}

function chatEvents(plan, n) {
  const base = { id: `chatcmpl_${n}`, object: 'chat.completion.chunk', model: 'mock' }
  const chunk = (delta, finish = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })
  const out = []
  if (plan.call) {
    out.push(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: plan.call.name, arguments: '' } }] }))
    out.push(chunk({ tool_calls: [{ index: 0, function: { arguments: plan.call.args } }] }))
    out.push(chunk({}, 'tool_calls'))
  } else {
    out.push(chunk({ role: 'assistant', content: '' }))
    for (const piece of plan.text.match(/.{1,12}/gsu) ?? []) out.push(chunk({ content: piece }))
    out.push(chunk({}, 'stop'))
  }
  out.push('[DONE]')
  return out
}

export async function startMockServer() {
  const requests = []
  const config = { transcript: 'Джарвис, сколько сейчас времени?', badKeys: [], sseDelayMs: 0 }
  let counter = 0

  const server = createServer(async (req, res) => {
    const body = await readBody(req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/^\/v1/, '')
    let json = null
    if ((req.headers['content-type'] ?? '').includes('application/json')) {
      try { json = JSON.parse(body.toString('utf8')) } catch { json = null }
    }
    const entry = { method: req.method, path: url.pathname, search: url.search, headers: req.headers, json, bytes: body.length, at: Date.now() }
    requests.push(entry)

    if (url.pathname === '/__log') return res.end(JSON.stringify(requests.map(({ headers, ...r }) => r)))
    if (url.pathname === '/__config' && req.method === 'POST') { Object.assign(config, JSON.parse(body.toString('utf8'))); return res.end('{}') }

    const auth = String(req.headers.authorization ?? '')
    const xiKey = String(req.headers['xi-api-key'] ?? '')
    const isEleven = path.startsWith('/text-to-speech') || path === '/voices'
    if (!isEleven && !auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'Missing key', type: 'invalid_request_error', code: 'invalid_api_key' } }))
    }
    if (!isEleven && config.badKeys.includes(auth.slice('Bearer '.length))) {
      entry.status = 401
      res.writeHead(401, { 'content-type': 'application/json' })
      const message = `Incorrect API key provided: ${auth.slice(7, 12)}****. You can find your API key at https://platform.openai.com/account/api-keys.`
      return res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }))
    }
    if (isEleven && !xiKey) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }))
    }

    if (req.method === 'GET' && path === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'openai' })) }))
    }
    if (req.method === 'POST' && path === '/responses' && json) {
      counter += 1
      const items = Array.isArray(json.input) ? json.input : [{ role: 'user', content: String(json.input ?? '') }]
      const outputs = items.filter((i) => i && i.type === 'function_call_output')
      const plan = planReply(lastUserText(items), outputs.length > 0, outputs.at(-1)?.output, Array.isArray(json.tools) && json.tools.length > 0)
      entry.plan = plan
      if (json.stream === false || json.stream === undefined) {
        res.writeHead(200, { 'content-type': 'application/json' })
        const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: plan.text ?? '' }] }]
        return res.end(JSON.stringify({ id: `resp_${counter}`, status: 'completed', output, output_text: plan.text ?? '' }))
      }
      return sse(res, responsesEvents(plan, counter), config.sseDelayMs)
    }
    if (req.method === 'POST' && path === '/chat/completions' && json) {
      counter += 1
      const msgs = Array.isArray(json.messages) ? json.messages : []
      const toolMsgs = msgs.filter((m) => m.role === 'tool')
      const plan = planReply(lastUserText(msgs), toolMsgs.length > 0, toolMsgs.at(-1)?.content, Array.isArray(json.tools) && json.tools.length > 0)
      entry.plan = plan
      if (!json.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: `chatcmpl_${counter}`, choices: [{ index: 0, message: { role: 'assistant', content: plan.text ?? '' }, finish_reason: 'stop' }] }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const e of chatEvents(plan, counter)) {
        res.write(e === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(e)}\n\n`)
        if (config.sseDelayMs) await pause(config.sseDelayMs)
      }
      return res.end()
    }
    if (req.method === 'POST' && path === '/audio/transcriptions') {
      entry.transcript = config.transcript
      entry.fields = multipartFields(body, String(req.headers['content-type'] ?? ''))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: config.transcript }))
    }
    if (req.method === 'POST' && (path === '/audio/speech' || path.startsWith('/text-to-speech/'))) {
      res.writeHead(200, { 'content-type': 'audio/wav' })
      return res.end(wavTone())
    }
    if (req.method === 'GET' && path === '/voices') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ voices: [{ voice_id: 'voice123', name: 'Test Butler', labels: { gender: 'male', accent: 'british' }, preview_url: '' }] }))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Unknown route ${req.method} ${url.pathname}`, code: 'not_found' } }))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    config,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}
