// Chat Completions provider (POST /chat/completions, stream) for OpenAI-compatible proxies.
// Streamed tool_calls are accumulated by index; tool images go in an extra user message after the tool messages.
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
  isObject,
  lowerErrorText,
  parseJsonObject,
  toolImageLabel,
  type ConvMessage,
  type FinishReason,
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

const MAX_STREAM_RETRIES = 2
const MAX_ADAPTATIONS = 5

export class ChatCompletionsProvider implements ModelProvider {
  readonly api = 'chat' as const
  readonly quirks = new QuirkMemory()

  constructor(
    readonly http: OpenAiClient,
    readonly log: Logger
  ) {}

  createSession(opts: SessionOptions): ModelSession {
    return new ChatSession(this, opts)
  }
}

export function toChatMessage(message: ConvMessage): JsonObject {
  if (message.role === 'assistant') {
    return { role: 'assistant', content: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }
  }
  if (message.parts.every((p) => p.type === 'text')) {
    return { role: 'user', content: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n') }
  }
  return {
    role: 'user',
    content: message.parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'image_url', image_url: { url: p.url, detail: p.detail } }
    )
  }
}

function imageParts(message: JsonObject): JsonObject[] {
  if (!Array.isArray(message.content)) return []
  return message.content.filter((p: unknown): p is JsonObject => isObject(p) && p.type === 'image_url')
}

function usesOriginalDetail(messages: JsonObject[]): boolean {
  return messages.some((m) => imageParts(m).some((p) => isObject(p.image_url) && p.image_url.detail === 'original'))
}

function withHighDetail(message: JsonObject): JsonObject {
  if (!imageParts(message).length || !Array.isArray(message.content)) return message
  return {
    ...message,
    content: message.content.map((p: unknown) =>
      isObject(p) && p.type === 'image_url' && isObject(p.image_url) && p.image_url.detail === 'original'
        ? { ...p, image_url: { ...p.image_url, detail: 'high' } }
        : p
    )
  }
}

interface PartialCall {
  id: string
  name: string
  args: string
}

/** Merges one streamed `delta.tool_calls[]` entry into the per-index accumulator. */
export function accumulateToolCall(calls: Map<number, PartialCall>, raw: unknown): void {
  if (!isObject(raw)) return
  const id = asString(raw.id)
  let index = typeof raw.index === 'number' ? raw.index : -1
  if (index < 0) {
    // Non-compliant servers omit `index`: match by id, else continue the last call.
    const byId = id ? [...calls.entries()].find(([, c]) => c.id === id) : undefined
    index = byId ? byId[0] : id ? calls.size : Math.max(0, calls.size - 1)
  }
  let acc = calls.get(index)
  if (!acc) {
    acc = { id: '', name: '', args: '' }
    calls.set(index, acc)
  }
  if (id && !acc.id) acc.id = id
  const fn = isObject(raw.function) ? raw.function : null
  const name = asString(fn?.name)
  if (name && acc.name !== name) acc.name = acc.name && !name.startsWith(acc.name) ? acc.name + name : name
  const args = asString(fn?.arguments)
  if (args) acc.args += args
}

function finishCalls(calls: Map<number, PartialCall>): ToolCallRequest[] {
  return [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, c]) => c.name)
    .map(([index, c]) => ({ id: c.id || `call_${index}_${Date.now().toString(36)}`, name: c.name, arguments: c.args }))
}

interface Progress {
  opened: boolean
  emitted: boolean
}

class ChatSession implements ModelSession {
  private readonly messages: JsonObject[]
  private readonly imageMessages: JsonObject[] = []
  private dropMaxTokens = false

  constructor(
    private readonly provider: ChatCompletionsProvider,
    private readonly opts: SessionOptions
  ) {
    this.messages = [{ role: 'system', content: opts.instructions }, ...opts.messages.map(toChatMessage)]
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
            this.provider.log.warn(`chat: 400 for ${this.opts.model} (${err.detail ?? ''}) → retry with ${fix}`)
            continue
          }
        }
        if (progress.opened && !progress.emitted && err.retryable && streamRetries < MAX_STREAM_RETRIES) {
          this.provider.log.warn(`chat: stream failed (${err.detail ?? err.message}), retrying`)
          await sleep(backoffDelay(streamRetries, this.provider.http.tuning.retryBaseDelayMs), step.signal)
          streamRetries++
          continue
        }
        throw err
      }
    }
  }

  addToolResults(results: ToolResultInput[]): void {
    for (const r of results) this.messages.push({ role: 'tool', tool_call_id: r.callId, content: r.output })
    const parts: JsonObject[] = []
    for (const r of results) {
      for (const image of r.images) {
        parts.push({ type: 'text', text: toolImageLabel(r.name) })
        parts.push({ type: 'image_url', image_url: { url: image.url, detail: image.detail } })
      }
    }
    if (parts.length === 0) return
    const message: JsonObject = { role: 'user', content: parts }
    this.messages.push(message)
    this.imageMessages.push(message)
    while (this.imageMessages.length > MAX_TURN_IMAGE_MESSAGES) {
      const old = this.imageMessages.shift()
      if (old && Array.isArray(old.content)) {
        old.content = old.content.map((p: unknown) =>
          isObject(p) && p.type === 'image_url' ? { type: 'text', text: OMITTED_IMAGE_NOTE } : p
        )
      }
    }
  }

  private buildBody(quirks: ModelQuirks, noTools: boolean): JsonObject {
    const body: JsonObject = {
      model: this.opts.model,
      messages: quirks.detailHigh ? this.messages.map(withHighDetail) : this.messages,
      stream: true
    }
    if (!quirks.noTools && this.opts.tools.length) {
      body.tools = this.opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
      body.tool_choice = noTools ? 'none' : 'auto'
    }
    const effort = effectiveEffort(quirks, this.opts.effort)
    if (effort) body.reasoning_effort = effort
    if (this.opts.maxOutputTokens && !this.dropMaxTokens) body.max_completion_tokens = this.opts.maxOutputTokens
    return body
  }

  private adapt(err: AiError, body: JsonObject, quirks: ModelQuirks): string | null {
    const text = lowerErrorText(err)
    const param = (err.param ?? '').toLowerCase()
    if (body.reasoning_effort && (param.includes('reasoning') || /reasoning|effort/.test(text))) {
      return adaptEffort(quirks, this.opts.effort, err.detail ?? '')
    }
    if (body.max_completion_tokens && /max_completion_tokens/.test(text)) {
      this.dropMaxTokens = true
      return 'no-max-tokens'
    }
    if (usesOriginalDetail(this.messages) && !quirks.detailHigh && (param.endsWith('detail') || /detail|'original'/.test(text))) {
      quirks.detailHigh = true
      return 'detail-high'
    }
    if (body.tools && (param.startsWith('tool') || /\btools?\b|tool_choice|function calling/.test(text))) {
      quirks.noTools = true
      return 'no-tools'
    }
    return null
  }

  private async run(body: JsonObject, step: StepOptions, progress: Progress): Promise<StepResult> {
    const model = this.opts.model
    const calls = new Map<number, PartialCall>()
    let text = ''
    let finish: string | null = null
    let ended = false
    const emit = (delta: string): void => {
      if (!delta) return
      text += delta
      progress.emitted = true
      step.onTextDelta?.(delta)
    }

    for await (const ev of this.provider.http.stream('/chat/completions', body, { signal: step.signal, model })) {
      progress.opened = true
      if (ev.data === '[DONE]') {
        ended = true
        break
      }
      const data = parseJsonObject(ev.data)
      if (!data) {
        this.provider.log.warn('chat: unparsable stream chunk')
        continue
      }
      if (data.error) throw openAiStreamError(data.error, { model })
      const choices = Array.isArray(data.choices) ? data.choices.filter(isObject) : []
      const choice = choices.find((c) => c.index === undefined || c.index === 0)
      if (ev.event === 'json') {
        // Server ignored stream:true and returned a whole chat.completion.
        const message = isObject(choice?.message) ? choice.message : {}
        if (typeof message.content === 'string') emit(message.content)
        if (Array.isArray(message.tool_calls)) {
          message.tool_calls.forEach((tc: unknown, i: number) =>
            accumulateToolCall(calls, isObject(tc) ? { ...tc, index: i } : tc)
          )
        }
        finish = asString(choice?.finish_reason) ?? 'stop'
        ended = true
        break
      }
      if (!choice) continue
      const delta = isObject(choice.delta) ? choice.delta : {}
      if (typeof delta.content === 'string') emit(delta.content)
      if (typeof delta.refusal === 'string') emit(delta.refusal)
      if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) accumulateToolCall(calls, tc)
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason
    }

    if (!ended && finish === null) {
      if (!text && calls.size === 0) throw new AiError('model_error', OPENAI_MESSAGES.streamBroken, { retryable: true })
      this.provider.log.warn('chat: stream ended without [DONE]')
    }

    const truncated = finish === 'length'
    const toolCalls = truncated ? [] : finishCalls(calls)
    const assistant: JsonObject = { role: 'assistant', content: text || null }
    if (toolCalls.length) {
      assistant.tool_calls = toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments }
      }))
    }
    if (text || toolCalls.length) this.messages.push(assistant)

    let finishReason: FinishReason = toolCalls.length ? 'tool_calls' : 'stop'
    if (truncated) finishReason = 'length'
    else if (finish === 'content_filter') finishReason = 'content_filter'
    return { text, toolCalls, finishReason }
  }
}
