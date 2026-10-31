// OpenAI Responses API provider (POST /responses, stream, store: false).
// Within a turn every output item (reasoning with encrypted content, function calls, messages) is replayed
// verbatim, followed by function_call_output items and an extra user message with tool images.
import type { Logger } from '../log'
import { AiError, OPENAI_MESSAGES, openAiStreamError } from './errors'
import { backoffDelay, sleep, type OpenAiClient } from './http'
import {
  MAX_TURN_IMAGE_MESSAGES,
  OMITTED_IMAGE_NOTE,
  QuirkMemory,
  adaptEffort,
  asString,
  effectiveEffort,
  exposedToolName,
  isObject,
  lowerErrorText,
  parseJsonObject,
  toolImageLabel,
  toolNameMap,
  type ConvMessage,
  type JsonObject,
  type ModelProvider,
  type ModelQuirks,
  type ModelSession,
  type SessionOptions,
  type StepOptions,
  type StepResult,
  type ToolCallRequest,
  type ToolResultInput
} from './provider'

/** Retries of a step whose stream failed before any text was shown. */
const MAX_STREAM_RETRIES = 2
const MAX_ADAPTATIONS = 6

export class ResponsesProvider implements ModelProvider {
  readonly api = 'responses' as const
  readonly quirks = new QuirkMemory()

  constructor(
    readonly http: OpenAiClient,
    readonly log: Logger
  ) {}

  createSession(opts: SessionOptions): ModelSession {
    return new ResponsesSession(this, opts)
  }
}

export function toResponsesInput(message: ConvMessage): JsonObject {
  if (message.role === 'assistant') {
    return { role: 'assistant', content: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }
  }
  return {
    role: 'user',
    content: message.parts.map((p) =>
      p.type === 'text'
        ? { type: 'input_text', text: p.text }
        : { type: 'input_image', image_url: p.url, detail: p.detail }
    )
  }
}

function withDetail(item: JsonObject, from: string, to: string): JsonObject {
  if (item.role !== 'user' || !Array.isArray(item.content)) return item
  return {
    ...item,
    content: item.content.map((part: unknown) =>
      isObject(part) && part.type === 'input_image' && part.detail === from ? { ...part, detail: to } : part
    )
  }
}

function usesDetail(input: unknown, detail: string): boolean {
  if (!Array.isArray(input)) return false
  return input.some(
    (item) =>
      isObject(item) &&
      Array.isArray(item.content) &&
      item.content.some((p: unknown) => isObject(p) && p.type === 'input_image' && p.detail === detail)
  )
}

function hasBuiltinSearch(body: JsonObject): boolean {
  return Array.isArray(body.tools) && body.tools.some((t: unknown) => isObject(t) && t.type === 'web_search')
}

/** Text of message items (used when a server sends no deltas). */
function outputText(output: JsonObject[]): string {
  let text = ''
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!isObject(part)) continue
      if (part.type === 'output_text' && typeof part.text === 'string') text += part.text
      else if (part.type === 'refusal' && typeof part.refusal === 'string') text += part.refusal
    }
  }
  return text
}

interface Progress {
  opened: boolean
  emitted: boolean
}

class ResponsesSession implements ModelSession {
  private readonly input: JsonObject[]
  private readonly builtinSearch: boolean
  private readonly names: Map<string, string>
  private readonly imageMessages: JsonObject[] = []

  constructor(
    private readonly provider: ResponsesProvider,
    private readonly opts: SessionOptions
  ) {
    this.input = opts.messages.map(toResponsesInput)
    this.builtinSearch = opts.webSearch && !provider.quirks.get(opts.model).noWebSearch
    this.names = toolNameMap(opts.tools, this.builtinSearch)
  }

  async step(step: StepOptions): Promise<StepResult> {
    const quirks = this.provider.quirks.get(this.opts.model)
    const adapted = new Set<string>()
    let streamRetries = 0
    for (;;) {
      const body = this.buildBody(quirks, step.noTools === true)
      const progress: Progress = { opened: false, emitted: false }
      try {
        return await this.run(body, step, progress)
      } catch (err) {
        if (step.signal.aborted || !(err instanceof AiError)) throw err
        if (err.status === 400 && adapted.size < MAX_ADAPTATIONS) {
          const fix = this.adapt(err, body, quirks)
          if (fix && !adapted.has(fix)) {
            adapted.add(fix)
            this.provider.log.warn(`responses: 400 for ${this.opts.model} (${err.detail ?? ''}) → retry with ${fix}`)
            continue
          }
        }
        if (progress.opened && !progress.emitted && err.retryable && streamRetries < MAX_STREAM_RETRIES) {
          this.provider.log.warn(`responses: stream failed (${err.detail ?? err.message}), retrying`)
          await sleep(backoffDelay(streamRetries, this.provider.http.tuning.retryBaseDelayMs), step.signal)
          streamRetries++
          continue
        }
        throw err
      }
    }
  }

  addToolResults(results: ToolResultInput[]): void {
    for (const r of results) this.input.push({ type: 'function_call_output', call_id: r.callId, output: r.output })
    const parts: JsonObject[] = []
    for (const r of results) {
      for (const image of r.images) {
        parts.push({ type: 'input_text', text: toolImageLabel(r.name) })
        parts.push({ type: 'input_image', image_url: image.url, detail: image.detail })
      }
    }
    if (parts.length === 0) return
    const message: JsonObject = { role: 'user', content: parts }
    this.input.push(message)
    this.imageMessages.push(message)
    while (this.imageMessages.length > MAX_TURN_IMAGE_MESSAGES) {
      const old = this.imageMessages.shift()
      if (old && Array.isArray(old.content)) {
        old.content = old.content.map((p: unknown) =>
          isObject(p) && p.type === 'input_image' ? { type: 'input_text', text: OMITTED_IMAGE_NOTE } : p
        )
      }
    }
  }

  private buildBody(quirks: ModelQuirks, noTools: boolean): JsonObject {
    const body: JsonObject = {
      model: this.opts.model,
      instructions: this.opts.instructions,
      input: quirks.detailHigh ? this.input.map((item) => withDetail(item, 'original', 'high')) : this.input,
      stream: true,
      store: false
    }
    if (!quirks.noInclude) body.include = ['reasoning.encrypted_content']
    const tools: JsonObject[] = this.opts.tools.map((t) => ({
      type: 'function',
      name: exposedToolName(t.name, this.builtinSearch),
      description: t.description,
      parameters: t.parameters,
      strict: false
    }))
    if (this.builtinSearch && !quirks.noWebSearch) tools.push({ type: 'web_search' })
    if (tools.length) {
      body.tools = tools
      body.tool_choice = noTools ? 'none' : 'auto'
    }
    const effort = effectiveEffort(quirks, this.opts.effort)
    if (effort) body.reasoning = { effort }
    if (this.opts.maxOutputTokens) body.max_output_tokens = this.opts.maxOutputTokens
    return body
  }

  /** Applies a fix for a 400 response; returns its key or null when nothing applies. */
  private adapt(err: AiError, body: JsonObject, quirks: ModelQuirks): string | null {
    const missing = /item with id '([^']+)' not found/i.exec(err.detail ?? '')
    if (missing) return this.dropItemId(missing[1]) ? `item:${missing[1]}` : null
    const text = lowerErrorText(err)
    const param = (err.param ?? '').toLowerCase()
    if (
      body.include &&
      (param === 'include' || param.startsWith('include[') || /encrypted.content|'include'|include\[/.test(text))
    ) {
      quirks.noInclude = true
      return 'no-include'
    }
    if (body.reasoning && (param.startsWith('reasoning') || /reasoning|effort/.test(text))) {
      return adaptEffort(quirks, this.opts.effort, err.detail ?? '')
    }
    if (
      hasBuiltinSearch(body) &&
      (param.startsWith('tools') || /web_search|web search|tool type|hosted tool|unsupported tool/.test(text))
    ) {
      quirks.noWebSearch = true
      return 'no-web-search'
    }
    if (usesDetail(body.input, 'original') && (param.endsWith('detail') || /detail|'original'/.test(text))) {
      quirks.detailHigh = true
      return 'detail-high'
    }
    return null
  }

  /** store:false servers may not know replayed ids: drop the id (or the whole item for reasoning). */
  private dropItemId(id: string): boolean {
    const index = this.input.findIndex((item) => item.id === id)
    if (index < 0) return false
    const item = this.input[index]
    if (item.type === 'reasoning') this.input.splice(index, 1)
    else delete item.id
    return true
  }

  private async run(body: JsonObject, step: StepOptions, progress: Progress): Promise<StepResult> {
    const model = this.opts.model
    const items = new Map<number, JsonObject>()
    let final: JsonObject | null = null
    let terminal: 'completed' | 'incomplete' | null = null
    let text = ''
    const emit = (delta: string): void => {
      if (!delta) return
      text += delta
      progress.emitted = true
      step.onTextDelta?.(delta)
    }

    for await (const ev of this.provider.http.stream('/responses', body, { signal: step.signal, model })) {
      progress.opened = true
      if (ev.data === '[DONE]') break
      const data = parseJsonObject(ev.data)
      if (!data) {
        this.provider.log.warn(`responses: unparsable event ${ev.event}`)
        continue
      }
      if (ev.event === 'json') {
        if (data.error) throw openAiStreamError(data.error, { model })
        final = data
        terminal = data.status === 'incomplete' ? 'incomplete' : 'completed'
        break
      }
      const type = asString(data.type) ?? ev.event
      switch (type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          if (typeof data.delta === 'string') emit(data.delta)
          break
        case 'response.output_item.added':
          if (isObject(data.item) && data.item.type === 'web_search_call') step.onActivity?.('web_search')
          break
        case 'response.output_item.done':
          if (isObject(data.item)) {
            items.set(typeof data.output_index === 'number' ? data.output_index : items.size, data.item)
          }
          break
        case 'response.completed':
        case 'response.incomplete':
          terminal = type === 'response.completed' ? 'completed' : 'incomplete'
          final = isObject(data.response) ? data.response : null
          break
        case 'response.failed':
          throw openAiStreamError(isObject(data.response) ? data.response.error : data, { model })
        case 'error':
          throw openAiStreamError(data, { model })
        default:
          break
      }
      if (terminal) break
    }

    const finalOutput = Array.isArray(final?.output) ? final.output.filter(isObject) : []
    const output = finalOutput.length ? finalOutput : [...items.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
    if (!terminal) {
      if (output.length === 0 && !text) throw new AiError('model_error', OPENAI_MESSAGES.streamBroken, { retryable: true })
      this.provider.log.warn('responses: stream ended without response.completed')
    }
    if (!text) emit(outputText(output))
    this.input.push(...output)

    const incomplete = terminal === 'incomplete'
    const details = isObject(final?.incomplete_details) ? final.incomplete_details : null
    const toolCalls: ToolCallRequest[] = incomplete
      ? []
      : output
          .filter((item) => item.type === 'function_call')
          .map((item, i) => {
            const name = asString(item.name) ?? ''
            return {
              id: asString(item.call_id) ?? asString(item.id) ?? `call_${i}`,
              name: this.names.get(name) ?? name,
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
            }
          })
    if (incomplete) {
      return { text, toolCalls, finishReason: details?.reason === 'content_filter' ? 'content_filter' : 'length' }
    }
    return { text, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' }
  }
}
