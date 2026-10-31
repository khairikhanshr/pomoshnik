// AssistantService: the agent loop. One active turn at a time; a new send() cancels the running one.
// Progress goes through the bus (turn chat events, assistant state, speak chunks; the ChatStore itself
// announces chat-updated / chats-changed). The store is written at boundaries (turn start, tool
// start/end, turn end), never per text delta.
import { arch, release } from 'node:os'
import { LIMITS } from '@shared/defaults'
import { splitSentences, toSpeakableText } from '@shared/speech-text'
import type { AssistantState, ChatEvent, ChatMessage, ImageRef, MessageSource, Settings, Tier, ToolCallRecord } from '@shared/types'
import type { AppBus } from '../bus'
import type { Logger } from '../log'
import type {
  AssistantSendRequest,
  AssistantService,
  ChatStore,
  MediaStore,
  ModelCatalog,
  SettingsStore
} from '../services'
import type { ToolRegistry, ToolResult, ToolSpec } from '../tools/types'
import { newId } from '../util/fs'
import { buildConversation } from './context'
import { AiError, OPENAI_MESSAGES, abortError, isAbortError, userMessage } from './errors'
import type { OpenAiClient } from './http'
import { buildInstructions } from './persona'
import {
  exposedToolName,
  type FinishReason,
  type ModelProvider,
  type ToolCallRequest,
  type ToolImage,
  type ToolResultInput
} from './provider'
import { SpeechChunker } from './speech-chunker'
import { NEW_CHAT_TITLE, fallbackTitle, generateTitle } from './title'

export interface AssistantTuning {
  /** Voice requests reuse the latest voice chat updated within this window. */
  voiceChatMaxAgeMs: number
  /** Streaming `response` state updates are throttled to about this interval. */
  stateThrottleMs: number
  /** An error state returns to idle after this long. */
  errorResetMs: number
  /** Wait for the voice window's speech-done before a stale 'speaking' state is reset to idle… */
  speakingWatchdogMs: number
  /** …plus this much per spoken character. */
  speakingMsPerChar: number
  platform: NodeJS.Platform
}

export const DEFAULT_ASSISTANT_TUNING: AssistantTuning = {
  voiceChatMaxAgeMs: 15 * 60 * 1000,
  stateThrottleMs: 125,
  errorResetMs: 8000,
  speakingWatchdogMs: 30_000,
  speakingMsPerChar: 120,
  platform: process.platform
}

export interface AssistantDeps {
  settings: SettingsStore
  chats: ChatStore
  media: MediaStore
  tools: ToolRegistry
  bus: AppBus
  models: ModelCatalog
  http: OpenAiClient
  providers: { responses: ModelProvider; chat: ModelProvider }
  log: Logger
  tuning: AssistantTuning
}

const STATE_TEXT_MAX = 4000
const PING_TIMEOUT_MS = 60_000
/** testConnection falls back to a tiny model request when GET /models fails with these. */
const PING_FALLBACK = new Set(['not_found', 'bad_request', 'server', 'invalid_response', 'model_error'])
const DENIED_RE = /\buser denied\b|\bdenied by the user\b/i
const LENGTH_NOTE = '\n\n_(Ответ обрезан: достигнут лимит длины.)_'

interface Turn {
  id: string
  chatId: string
  messageId: string
  createdAt: number
  userText: string
  hasUserImages: boolean
  source: MessageSource
  tier: Tier
  model: string
  speak: boolean
  settings: Settings
  controller: AbortController
  text: string
  toolCalls: ToolCallRecord[]
  images: ImageRef[]
  chunker: SpeechChunker | null
  speakSeq: number
  done: boolean
  stateTimer: NodeJS.Timeout | null
  lastStateAt: number
  needsSeparator: boolean
  searching: boolean
  stepLimitHit: boolean
  finishReason: FinishReason
}

function stateText(text: string): string {
  return text.length > STATE_TEXT_MAX ? `…${text.slice(-STATE_TEXT_MAX)}` : text
}

function parseArgs(raw: string): { args: Record<string, unknown>; error?: string } {
  const text = raw.trim()
  if (!text) return { args: {} }
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return { args: value as Record<string, unknown> }
    return { args: {}, error: 'arguments must be a JSON object' }
  } catch (err) {
    return { args: { _raw: text.slice(0, 500) }, error: err instanceof Error ? err.message : String(err) }
  }
}

function truncateOutput(output: string, ok: boolean): string {
  const text = typeof output === 'string' ? output : String(output ?? '')
  if (!text) return ok ? 'Done.' : 'Error: the tool returned no output.'
  const max = LIMITS.maxToolOutputChars
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated: ${text.length - max} more characters]`
}

export function spokenError(message: string, userTitle: string): string {
  const first = splitSentences(toSpeakableText(message, { lang: 'ru' }))[0] ?? message
  return `Прошу прощения, ${userTitle.trim() || 'сэр'}. ${first}`
}

export class AssistantServiceImpl implements AssistantService {
  private active: Turn | null = null
  private readonly titling = new Set<string>()

  constructor(private readonly deps: AssistantDeps) {}

  async send(req: AssistantSendRequest): Promise<{ chatId: string; turnId: string }> {
    const { chats, media, models, bus } = this.deps
    const text = (req.text ?? '').trim()
    const images = (req.images ?? [])
      .map((id) => {
        const ref = media.ref(id)
        if (!ref) this.deps.log.warn(`unknown image id ${id} ignored`)
        return ref
      })
      .filter((ref): ref is ImageRef => ref !== null)
    if (!text && images.length === 0) throw new AiError('bad_request', OPENAI_MESSAGES.emptyRequest)

    if (this.active) this.finishCancelled(this.active)

    const settings = this.deps.settings.get()
    const chat = this.resolveChat(req, settings)
    const tier = req.tier ?? chat.tier
    if (req.tier && req.tier !== chat.tier) this.safe('setTier', () => chats.setTier(chat.id, tier))
    const model = models.resolve(tier)
    const speak =
      req.speak ?? (settings.speakMode === 'always' || (settings.speakMode === 'voice' && req.source === 'voice'))

    const userMessage: ChatMessage = {
      id: newId(),
      role: 'user',
      text,
      ...(images.length ? { images } : {}),
      source: req.source,
      createdAt: Date.now()
    }
    const assistantMessage: ChatMessage = {
      id: newId(),
      role: 'assistant',
      text: '',
      tier,
      model,
      source: req.source,
      createdAt: Date.now(),
      status: 'streaming'
    }
    chats.appendMessage(chat.id, userMessage)
    chats.appendMessage(chat.id, assistantMessage)

    const turn: Turn = {
      id: newId(),
      chatId: chat.id,
      messageId: assistantMessage.id,
      createdAt: assistantMessage.createdAt,
      userText: text,
      hasUserImages: images.length > 0,
      source: req.source,
      tier,
      model,
      speak,
      settings,
      controller: new AbortController(),
      text: '',
      toolCalls: [],
      images: [],
      chunker: null,
      speakSeq: 0,
      done: false,
      stateTimer: null,
      lastStateAt: 0,
      needsSeparator: false,
      searching: false,
      stepLimitHit: false,
      finishReason: 'stop'
    }
    if (speak) {
      turn.chunker = new SpeechChunker({
        maxChars: settings.maxSpokenChars,
        userTitle: settings.userTitle,
        emit: (chunk, final) => this.emitSpeak(turn, chunk, final)
      })
    }
    this.active = turn

    this.emitChat({ type: 'turn-start', chatId: chat.id, turnId: turn.id, userMessage, assistantMessage })
    bus.patchState({
      phase: 'thinking',
      transcript: text,
      response: '',
      toolTitle: undefined,
      error: undefined,
      chatId: chat.id,
      turnId: turn.id
    })
    void this.run(turn)
    return { chatId: chat.id, turnId: turn.id }
  }

  cancel(turnId?: string): void {
    const turn = this.active
    if (!turn || (turnId && turn.id !== turnId)) return
    this.finishCancelled(turn)
  }

  currentTurn(): { chatId: string; turnId: string } | null {
    return this.active ? { chatId: this.active.chatId, turnId: this.active.id } : null
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.deps.http.hasKey()) return { ok: false, message: OPENAI_MESSAGES.noKey }
    try {
      const list = await this.deps.models.list(true)
      return { ok: true, message: `Подключение работает. Доступно моделей: ${list.length}` }
    } catch (err) {
      if (!(err instanceof AiError) || !PING_FALLBACK.has(err.code)) return { ok: false, message: userMessage(err) }
      this.deps.log.warn(`GET /models failed (${err.message}); trying a tiny model request`)
    }
    const model = this.deps.models.resolve('luna')
    try {
      const session = this.provider().createSession({
        model,
        instructions: 'Reply with the single word: ok',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'ping' }] }],
        tools: [],
        webSearch: false,
        effort: 'auto',
        maxOutputTokens: 16
      })
      await session.step({ signal: AbortSignal.timeout(PING_TIMEOUT_MS) })
      return { ok: true, message: `Подключение работает. Модель ${model} отвечает (список моделей недоступен).` }
    } catch (err) {
      return { ok: false, message: userMessage(err) }
    }
  }

  // --- turn lifecycle ---

  /** Explicit chat, else (voice) the recent voice chat, else a new chat. The store announces new chats itself. */
  private resolveChat(req: AssistantSendRequest, settings: Settings): { id: string; tier: Tier } {
    const { chats } = this.deps
    if (req.chatId) {
      const existing = chats.get(req.chatId)
      if (existing) return existing
      this.deps.log.warn(`chat ${req.chatId} not found, starting a new one`)
    } else if (req.source === 'voice') {
      const recent = chats.findRecentVoiceChat(this.deps.tuning.voiceChatMaxAgeMs)
      if (recent) return recent
    }
    const tier = req.tier ?? (req.source === 'voice' ? settings.voiceTier : settings.defaultTier)
    return chats.create({ tier, source: req.source })
  }

  private provider(): ModelProvider {
    return this.deps.settings.get().apiMode === 'chat' ? this.deps.providers.chat : this.deps.providers.responses
  }

  private async run(turn: Turn): Promise<void> {
    try {
      await this.loop(turn)
      if (!turn.done) this.finishDone(turn)
    } catch (err) {
      if (turn.done) return
      if (turn.controller.signal.aborted || isAbortError(err)) this.finishCancelled(turn)
      else this.finishError(turn, err)
    }
  }

  private async loop(turn: Turn): Promise<void> {
    const { settings } = turn
    const chat = this.deps.chats.get(turn.chatId)
    if (!chat) throw new AiError('bad_request', 'Чат не найден.')
    const messages = await buildConversation(chat.messages, {
      media: this.deps.media,
      imageDetail: settings.imageDetail,
      excludeMessageId: turn.messageId
    })
    if (turn.done) return

    const provider = settings.apiMode === 'chat' ? this.deps.providers.chat : this.deps.providers.responses
    const webSearch = provider.api === 'responses' && settings.webSearch
    const specs = this.toolSpecs(settings)
    const known = new Set(specs.map((s) => s.name))
    const instructions = buildInstructions(settings, {
      now: new Date(),
      platform: this.deps.tuning.platform,
      osRelease: release(),
      arch: arch(),
      source: turn.source,
      spoken: turn.speak,
      toolNames: specs.map((s) => exposedToolName(s.name, webSearch)),
      webSearch
    })
    const session = provider.createSession({
      model: turn.model,
      instructions,
      messages,
      tools: specs,
      webSearch,
      effort: settings.tiers?.[turn.tier]?.reasoningEffort ?? 'auto'
    })

    const signal = turn.controller.signal
    for (let step = 0; step < LIMITS.maxToolSteps; step++) {
      const last = step === LIMITS.maxToolSteps - 1
      if (step > 0 && turn.text.trim()) turn.needsSeparator = true
      const result = await session.step({
        signal,
        noTools: last,
        onTextDelta: (delta) => this.onDelta(turn, delta, true),
        onActivity: () => this.onWebSearch(turn)
      })
      if (turn.done) return
      turn.finishReason = result.finishReason
      if (result.toolCalls.length === 0) return
      if (last) {
        turn.stepLimitHit = true
        return
      }
      turn.chunker?.flush()
      const outputs: ToolResultInput[] = []
      for (const call of result.toolCalls) {
        outputs.push(await this.runTool(turn, call, known))
        if (turn.done) return
      }
      session.addToolResults(outputs)
      this.patchState(turn, { phase: 'thinking', toolTitle: undefined })
    }
  }

  private toolSpecs(settings: Settings): ToolSpec[] {
    try {
      return this.deps.tools.specs(settings)
    } catch (err) {
      this.deps.log.error('tools.specs failed', err)
      return []
    }
  }

  private async runTool(turn: Turn, call: ToolCallRequest, known: Set<string>): Promise<ToolResultInput> {
    const { settings } = turn
    const signal = turn.controller.signal
    const { args, error: argsError } = parseArgs(call.arguments)
    const record: ToolCallRecord = {
      id: call.id,
      name: call.name,
      title: this.describe(call.name, args),
      args,
      status: 'running',
      startedAt: Date.now()
    }
    turn.toolCalls.push(record)
    this.persist(turn, { toolCalls: this.toolCallsCopy(turn) })
    this.emitChat({ type: 'tool-start', chatId: turn.chatId, turnId: turn.id, messageId: turn.messageId, call: { ...record } })
    this.patchState(turn, { phase: 'acting', toolTitle: record.title })

    let result: ToolResult
    if (argsError) {
      result = {
        ok: false,
        output: `Error: invalid JSON arguments for ${call.name}: ${argsError}. Call the tool again with a valid JSON object.`
      }
    } else if (!known.has(call.name)) {
      result = { ok: false, output: `Error: unknown tool "${call.name}". Available tools: ${[...known].join(', ') || 'none'}.` }
    } else {
      try {
        result = await this.deps.tools.execute(call.name, args, {
          chatId: turn.chatId,
          turnId: turn.id,
          source: turn.source,
          settings,
          signal
        })
      } catch (err) {
        if (signal.aborted) throw abortError()
        this.deps.log.error(`tool ${call.name} threw`, err)
        result = { ok: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    if (turn.done || signal.aborted) throw abortError()

    record.status = result.ok ? 'ok' : DENIED_RE.test(result.output ?? '') ? 'denied' : 'error'
    if (result.summary) record.summary = result.summary
    record.endedAt = Date.now()
    const images = (result.images ?? []).filter((img) => img && typeof img.id === 'string')
    for (const image of images) {
      turn.images.push(image)
      this.emitChat({ type: 'image', chatId: turn.chatId, turnId: turn.id, messageId: turn.messageId, image })
    }
    this.emitChat({ type: 'tool-end', chatId: turn.chatId, turnId: turn.id, messageId: turn.messageId, call: { ...record } })
    this.persist(turn, { toolCalls: this.toolCallsCopy(turn), ...(turn.images.length ? { images: [...turn.images] } : {}) })

    const modelImages: ToolImage[] = []
    for (const image of images) {
      const url = await this.deps.media.dataUrl(image.id, { maxSide: LIMITS.screenshotMaxSide }).catch(() => null)
      if (url) modelImages.push({ url, detail: settings.imageDetail })
    }
    if (turn.done) throw abortError()
    return { callId: call.id, name: call.name, output: truncateOutput(result.output, result.ok), images: modelImages }
  }

  private describe(name: string, args: Record<string, unknown>): string {
    try {
      return this.deps.tools.describe(name, args) || name
    } catch {
      return name
    }
  }

  private onDelta(turn: Turn, delta: string, speakable: boolean): void {
    if (turn.done || !delta) return
    let piece = delta
    if (turn.needsSeparator) {
      turn.needsSeparator = false
      piece = `${turn.text.endsWith('\n\n') ? '' : turn.text.endsWith('\n') ? '\n' : '\n\n'}${piece}`
    }
    turn.text += piece
    this.emitChat({ type: 'delta', chatId: turn.chatId, turnId: turn.id, messageId: turn.messageId, text: piece })
    if (speakable) turn.chunker?.push(piece)
    if (turn.searching) {
      turn.searching = false
      this.patchState(turn, { phase: 'thinking', toolTitle: undefined })
    }
    this.scheduleState(turn)
  }

  private onWebSearch(turn: Turn): void {
    if (turn.done || turn.searching) return
    turn.searching = true
    this.patchState(turn, { phase: 'acting', toolTitle: 'Ищу в интернете' })
  }

  private scheduleState(turn: Turn): void {
    if (turn.stateTimer) return
    const wait = Math.max(0, turn.lastStateAt + this.deps.tuning.stateThrottleMs - Date.now())
    turn.stateTimer = setTimeout(() => {
      turn.stateTimer = null
      turn.lastStateAt = Date.now()
      this.patchState(turn, { response: stateText(turn.text) })
    }, wait)
  }

  private finishDone(turn: Turn): void {
    if (!turn.text.trim()) {
      if (turn.finishReason === 'content_filter') {
        this.finishError(turn, new AiError('model_error', 'Ответ заблокирован фильтром безопасности OpenAI.'))
        return
      }
      if (turn.toolCalls.length === 0 && !turn.stepLimitHit) {
        this.finishError(turn, new AiError('model_error', 'Модель вернула пустой ответ. Попробуйте ещё раз.'))
        return
      }
      const title = turn.settings.userTitle.trim() || 'сэр'
      this.onDelta(
        turn,
        turn.stepLimitHit ? `Не успел завершить задачу за отведённое число шагов, ${title}.` : `Готово, ${title}.`,
        true
      )
    } else if (turn.stepLimitHit) {
      this.onDelta(turn, '\n\n_(Достигнут лимит шагов: задача могла быть выполнена не полностью.)_', false)
    }
    if (turn.finishReason === 'length') this.onDelta(turn, LENGTH_NOTE, false)

    this.close(turn)
    const message = this.finalMessage(turn, 'done')
    this.persist(turn, { text: message.text, status: 'done', toolCalls: message.toolCalls, images: message.images, model: turn.model })
    this.emitChat({ type: 'turn-end', chatId: turn.chatId, turnId: turn.id, message })
    turn.chunker?.finish()
    const spoke = turn.chunker?.hasSpoken ?? false
    if (!this.active) {
      this.deps.bus.patchState({
        phase: spoke ? 'speaking' : 'idle',
        response: stateText(turn.text),
        toolTitle: undefined,
        error: undefined
      })
      if (spoke) this.watchSpeaking(turn)
    }
    void this.maybeTitle(turn, turn.text, false)
  }

  private finishError(turn: Turn, err: unknown): void {
    const message = userMessage(err)
    this.deps.log.error(`turn ${turn.id} failed (${turn.model}): ${message}`, err instanceof AiError ? (err.detail ?? '') : err)
    this.close(turn)
    this.stopRunningTools(turn, 'error')
    const final = this.finalMessage(turn, 'error', message)
    this.persist(turn, { text: final.text, status: 'error', error: message, toolCalls: final.toolCalls, images: final.images })
    this.emitChat({ type: 'turn-error', chatId: turn.chatId, turnId: turn.id, messageId: turn.messageId, error: message })
    if (turn.chunker) {
      turn.chunker.cancel()
      this.emitSpeak(turn, spokenError(message, turn.settings.userTitle), true)
    }
    if (!this.active) {
      this.deps.bus.patchState({ phase: 'error', error: message, toolTitle: undefined, response: stateText(turn.text) })
      this.scheduleErrorReset(turn)
    }
    void this.maybeTitle(turn, '', true)
  }

  private finishCancelled(turn: Turn): void {
    if (turn.done) return
    this.close(turn)
    turn.controller.abort()
    turn.chunker?.cancel()
    this.stopRunningTools(turn, 'cancel')
    const message = this.finalMessage(turn, 'cancelled')
    this.persist(turn, { text: message.text, status: 'cancelled', toolCalls: message.toolCalls, images: message.images })
    this.emitChat({ type: 'turn-end', chatId: turn.chatId, turnId: turn.id, message })
    if (turn.speak) this.deps.bus.emit('stop-speaking')
    if (!this.active) {
      this.deps.bus.patchState({ phase: 'idle', toolTitle: undefined, error: undefined, response: stateText(turn.text) })
    }
    void this.maybeTitle(turn, '', true)
  }

  /** Marks the turn finished and releases the active slot. */
  private close(turn: Turn): void {
    turn.done = true
    if (this.active === turn) this.active = null
    if (turn.stateTimer) clearTimeout(turn.stateTimer)
    turn.stateTimer = null
  }

  private stopRunningTools(turn: Turn, reason: 'cancel' | 'error'): void {
    for (const call of turn.toolCalls) {
      if (call.status !== 'running') continue
      call.status = 'error'
      call.summary = reason === 'cancel' ? 'Отменено' : 'Прервано из-за ошибки'
      call.endedAt = Date.now()
      this.emitChat({ type: 'tool-end', chatId: turn.chatId, turnId: turn.id, messageId: turn.messageId, call: { ...call } })
    }
  }

  private finalMessage(turn: Turn, status: 'done' | 'error' | 'cancelled', error?: string): ChatMessage {
    return {
      id: turn.messageId,
      role: 'assistant',
      text: turn.text,
      ...(turn.images.length ? { images: [...turn.images] } : {}),
      ...(turn.toolCalls.length ? { toolCalls: this.toolCallsCopy(turn) } : {}),
      tier: turn.tier,
      model: turn.model,
      source: turn.source,
      createdAt: turn.createdAt,
      status,
      ...(error ? { error } : {})
    }
  }

  private toolCallsCopy(turn: Turn): ToolCallRecord[] {
    return turn.toolCalls.map((c) => ({ ...c }))
  }

  // --- side effects (never let a listener or the store break the loop) ---

  private emitSpeak(turn: Turn, text: string, final: boolean): void {
    try {
      this.deps.bus.emit('speak', { turnId: turn.id, seq: turn.speakSeq++, text, final })
    } catch (err) {
      this.deps.log.error('speak listener failed', err)
    }
  }

  private emitChat(ev: ChatEvent): void {
    try {
      this.deps.bus.emit('chat', ev)
    } catch (err) {
      this.deps.log.error('chat event listener failed', err)
    }
  }

  private patchState(turn: Turn, patch: Partial<AssistantState>): void {
    if (turn.done || this.active !== turn) return
    try {
      this.deps.bus.patchState(patch)
    } catch (err) {
      this.deps.log.error('state listener failed', err)
    }
  }

  private persist(turn: Turn, patch: Partial<ChatMessage>): void {
    this.safe('updateMessage', () => this.deps.chats.updateMessage(turn.chatId, turn.messageId, patch))
  }

  private safe<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn()
    } catch (err) {
      this.deps.log.error(`chat store ${what} failed`, err)
      return undefined
    }
  }

  private watchSpeaking(turn: Turn): void {
    const { bus, tuning } = this.deps
    const chars = Math.min(turn.text.length, turn.settings.maxSpokenChars)
    let off: (() => void) | null = null
    const timer = setTimeout(
      () => {
        off?.()
        const state = bus.getState()
        if (state.turnId === turn.id && state.phase === 'speaking') bus.patchState({ phase: 'idle' })
      },
      tuning.speakingWatchdogMs + chars * tuning.speakingMsPerChar
    )
    timer.unref?.()
    off = bus.on('speech-done', (report) => {
      if (report.turnId !== turn.id) return
      clearTimeout(timer)
      off?.()
    })
  }

  private scheduleErrorReset(turn: Turn): void {
    const timer = setTimeout(() => {
      const state = this.deps.bus.getState()
      if (state.turnId === turn.id && state.phase === 'error') this.deps.bus.patchState({ phase: 'idle', error: undefined })
    }, this.deps.tuning.errorResetMs)
    timer.unref?.()
  }

  private async maybeTitle(turn: Turn, reply: string, fallbackOnly: boolean): Promise<void> {
    const { chats } = this.deps
    if (this.titling.has(turn.chatId)) return
    if (this.safe('summary', () => chats.summary(turn.chatId))?.title !== NEW_CHAT_TITLE) return
    this.titling.add(turn.chatId)
    try {
      let title = fallbackTitle(turn.userText, turn.hasUserImages)
      if (!fallbackOnly && this.deps.http.hasKey()) {
        title = await generateTitle(
          {
            provider: this.provider(),
            model: this.deps.models.resolve('luna'),
            effort: 'low',
            userText: turn.userText,
            assistantText: reply,
            hasImages: turn.hasUserImages
          },
          this.deps.log
        )
      }
      if (title === NEW_CHAT_TITLE) return
      if (this.safe('summary', () => chats.summary(turn.chatId))?.title !== NEW_CHAT_TITLE) return
      this.safe('rename', () => chats.rename(turn.chatId, title))
      } catch (err) {
      this.deps.log.warn('chat title failed', err)
    } finally {
      this.titling.delete(turn.chatId)
    }
  }
}
