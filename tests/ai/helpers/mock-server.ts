// Local node:http server for AI-module tests: scripted per-route handlers, recorded requests and
// helpers that stream genuine-looking SSE in small, irregular chunks.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  /** Path including the query string. */
  url: string
  pathname: string
  headers: IncomingMessage['headers']
  body: Buffer
  text: string
  json(): any
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>

export interface SseFrame {
  event?: string
  data: unknown
}

export class MockServer {
  readonly requests: RecordedRequest[] = []
  url = ''
  private readonly queues = new Map<string, Handler[]>()
  private readonly defaults = new Map<string, Handler>()
  private readonly open = new Set<ServerResponse>()
  private server: Server | null = null

  static async start(): Promise<MockServer> {
    const mock = new MockServer()
    await mock.listen()
    return mock
  }

  private listen(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    return new Promise((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const { port } = this.server!.address() as AddressInfo
        this.url = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  }

  /** One-shot handlers for `METHOD /path`, used in order. */
  enqueue(route: string, ...handlers: Handler[]): void {
    const queue = this.queues.get(route) ?? []
    queue.push(...handlers)
    this.queues.set(route, queue)
  }

  /** Handler used when the route's queue is empty. */
  on(route: string, handler: Handler): void {
    this.defaults.set(route, handler)
  }

  requestsTo(route: string): RecordedRequest[] {
    const [method, path] = route.split(' ')
    return this.requests.filter((r) => r.method === method && r.pathname === path)
  }

  reset(): void {
    this.requests.length = 0
    this.queues.clear()
    this.defaults.clear()
  }

  async close(): Promise<void> {
    for (const res of this.open) res.destroy()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.open.add(res)
    res.on('close', () => this.open.delete(res))
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      pathname: url.pathname,
      headers: req.headers,
      body,
      text: body.toString('utf8'),
      json: () => JSON.parse(body.toString('utf8'))
    }
    this.requests.push(recorded)
    const route = `${recorded.method} ${recorded.pathname}`
    const handler = this.queues.get(route)?.shift() ?? this.defaults.get(route)
    try {
      if (handler) await handler(recorded, res)
      else sendJson(res, 404, { error: { message: `no mock for ${route}`, type: 'invalid_request_error' } })
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } })
      else res.destroy()
    }
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_req, res) =>
    sendJson(res, status, body, headers)

export function openAiError(status: number, message: string, code: string | null, type = 'invalid_request_error', param: string | null = null): Handler {
  return json(status, { error: { message, type, param, code } })
}

export function sseText(frames: SseFrame[]): string {
  return frames
    .map((f) => {
      const data = typeof f.data === 'string' ? f.data : JSON.stringify(f.data)
      return `${f.event ? `event: ${f.event}\n` : ''}data: ${data}\n\n`
    })
    .join('')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Writes `text` in byte chunks of irregular size (splits lines, CRLF and UTF-8 sequences). */
export async function writeIrregular(
  res: ServerResponse,
  text: string,
  opts: { maxChunk?: number; delayMs?: number } = {}
): Promise<void> {
  const bytes = Buffer.from(text, 'utf8')
  const max = opts.maxChunk ?? 23
  let i = 0
  let n = 0
  while (i < bytes.length) {
    const size = 1 + ((n * 7 + 3) % max)
    res.write(bytes.subarray(i, i + size))
    i += size
    n++
    if (opts.delayMs) await sleep(opts.delayMs)
  }
}

export interface SseOptions {
  maxChunk?: number
  delayMs?: number
  /** Leave the connection open after the frames (for cancellation / idle tests). */
  hang?: boolean
  /** Destroy the socket after the frames (connection drop). */
  drop?: boolean
}

export function sse(frames: SseFrame[], opts: SseOptions = {}): Handler {
  return async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.flushHeaders()
    await writeIrregular(res, sseText(frames), opts)
    if (opts.drop) {
      res.destroy()
      return
    }
    if (!opts.hang) res.end()
  }
}

/** Builds Responses API streaming events the way the real API emits them. */
export class ResponsesStream {
  private readonly frames: SseFrame[] = []
  private readonly output: Record<string, unknown>[] = []
  private seq = 0

  constructor(
    private readonly id = 'resp_test',
    private readonly model = 'gpt-test'
  ) {
    const response = this.response('in_progress', [])
    this.push('response.created', { response })
    this.push('response.in_progress', { response })
  }

  private push(type: string, payload: Record<string, unknown>): void {
    this.frames.push({ event: type, data: { type, sequence_number: this.seq++, ...payload } })
  }

  private response(status: string, output: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: this.id,
      object: 'response',
      created_at: 1760000000,
      status,
      model: this.model,
      output,
      parallel_tool_calls: true,
      store: false,
      ...extra
    }
  }

  reasoning(id: string, encrypted: string): this {
    const index = this.output.length
    this.push('response.output_item.added', { output_index: index, item: { id, type: 'reasoning', summary: [] } })
    const item = { id, type: 'reasoning', summary: [], encrypted_content: encrypted }
    this.push('response.output_item.done', { output_index: index, item })
    this.output.push(item)
    return this
  }

  text(text: string, pieces?: string[], id = `msg_${this.output.length}`): this {
    const index = this.output.length
    this.push('response.output_item.added', {
      output_index: index,
      item: { id, type: 'message', status: 'in_progress', content: [], role: 'assistant' }
    })
    this.push('response.content_part.added', {
      item_id: id,
      output_index: index,
      content_index: 0,
      part: { type: 'output_text', annotations: [], logprobs: [], text: '' }
    })
    for (const delta of pieces ?? splitWords(text)) {
      this.push('response.output_text.delta', { item_id: id, output_index: index, content_index: 0, delta, logprobs: [] })
    }
    this.push('response.output_text.done', { item_id: id, output_index: index, content_index: 0, text, logprobs: [] })
    const part = { type: 'output_text', annotations: [], logprobs: [], text }
    this.push('response.content_part.done', { item_id: id, output_index: index, content_index: 0, part })
    const item = { id, type: 'message', status: 'completed', content: [part], role: 'assistant' }
    this.push('response.output_item.done', { output_index: index, item })
    this.output.push(item)
    return this
  }

  functionCall(callId: string, name: string, args: unknown, id = `fc_${this.output.length}`): this {
    const index = this.output.length
    const argText = typeof args === 'string' ? args : JSON.stringify(args)
    this.push('response.output_item.added', {
      output_index: index,
      item: { id, type: 'function_call', status: 'in_progress', arguments: '', call_id: callId, name }
    })
    const half = Math.ceil(argText.length / 2)
    for (const delta of [argText.slice(0, half), argText.slice(half)].filter(Boolean)) {
      this.push('response.function_call_arguments.delta', { item_id: id, output_index: index, delta })
    }
    this.push('response.function_call_arguments.done', { item_id: id, output_index: index, arguments: argText })
    const item = { id, type: 'function_call', status: 'completed', arguments: argText, call_id: callId, name }
    this.push('response.output_item.done', { output_index: index, item })
    this.output.push(item)
    return this
  }

  webSearch(id = `ws_${this.output.length}`): this {
    const index = this.output.length
    this.push('response.output_item.added', { output_index: index, item: { id, type: 'web_search_call', status: 'in_progress' } })
    this.push('response.web_search_call.in_progress', { output_index: index, item_id: id })
    this.push('response.web_search_call.searching', { output_index: index, item_id: id })
    this.push('response.web_search_call.completed', { output_index: index, item_id: id })
    const item = { id, type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'weather' } }
    this.push('response.output_item.done', { output_index: index, item })
    this.output.push(item)
    return this
  }

  completed(): SseFrame[] {
    this.push('response.completed', {
      response: this.response('completed', this.output, {
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
      })
    })
    return this.frames
  }

  incomplete(reason: 'max_output_tokens' | 'content_filter'): SseFrame[] {
    this.push('response.incomplete', {
      response: this.response('incomplete', this.output, { incomplete_details: { reason } })
    })
    return this.frames
  }

  failed(code: string, message: string): SseFrame[] {
    this.push('response.failed', { response: this.response('failed', this.output, { error: { code, message } }) })
    return this.frames
  }

  /** Frames so far (no terminal event). */
  partial(): SseFrame[] {
    return this.frames
  }
}

function splitWords(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text]
}

/** Builds Chat Completions streaming chunks. */
export class ChatStream {
  private readonly frames: SseFrame[] = []

  constructor(private readonly model = 'gpt-test') {
    this.chunk({ role: 'assistant', content: '', refusal: null }, null)
  }

  private chunk(delta: Record<string, unknown>, finish: string | null): void {
    this.frames.push({
      data: {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1760000000,
        model: this.model,
        system_fingerprint: 'fp_test',
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }]
      }
    })
  }

  text(text: string): this {
    for (const piece of splitWords(text)) this.chunk({ content: piece }, null)
    return this
  }

  /** Streams a tool call the way OpenAI does: id + name first, then argument fragments. */
  toolCall(index: number, id: string, name: string, args: unknown, fragments = 3): this {
    const argText = typeof args === 'string' ? args : JSON.stringify(args)
    this.chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }, null)
    const size = Math.ceil(argText.length / fragments)
    for (let i = 0; i < argText.length; i += size) {
      this.chunk({ tool_calls: [{ index, function: { arguments: argText.slice(i, i + size) } }] }, null)
    }
    return this
  }

  done(finish: 'stop' | 'tool_calls' | 'length' | 'content_filter'): SseFrame[] {
    this.chunk({}, finish)
    this.frames.push({ data: '[DONE]' })
    return this.frames
  }
}
