// In-memory fakes of the main-process services used by the AI module.
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type {
  Chat,
  ChatMessage,
  ChatSummary,
  ImageRef,
  MessageSource,
  Settings,
  SettingsPatch,
  Tier
} from '@shared/types'
import type { Logger } from '../../../src/main/log'
import type { ChatStore, MediaStore, SecretStore, SettingsStore } from '../../../src/main/services'
import type { ToolContext, ToolRegistry, ToolResult, ToolSpec } from '../../../src/main/tools/types'

function merge(base: Settings, patch: SettingsPatch): Settings {
  const { tiers, ...rest } = patch
  const next = { ...base, ...rest } as Settings
  next.tiers = structuredClone(base.tiers)
  if (tiers) {
    for (const tier of Object.keys(tiers) as Tier[]) next.tiers[tier] = { ...next.tiers[tier], ...tiers[tier] }
  }
  return next
}

export class FakeSettings implements SettingsStore {
  private value: Settings
  private readonly listeners = new Set<(next: Settings, prev: Settings) => void>()

  constructor(patch: SettingsPatch = {}) {
    this.value = merge(structuredClone(DEFAULT_SETTINGS), patch)
  }

  get(): Settings {
    return this.value
  }

  update(patch: SettingsPatch): Settings {
    const prev = this.value
    this.value = merge(prev, patch)
    for (const cb of this.listeners) cb(this.value, prev)
    return this.value
  }

  reset(): Settings {
    this.value = structuredClone(DEFAULT_SETTINGS)
    return this.value
  }

  onChange(cb: (next: Settings, prev: Settings) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

export class FakeSecrets implements SecretStore {
  constructor(
    public apiKey: string | null = 'sk-test-0123456789abcdef',
    public elevenKey: string | null = null
  ) {}
  getApiKey(): string | null {
    return this.apiKey
  }
  setApiKey(key: string | null): void {
    this.apiKey = key || null
  }
  apiKeyHint(): string {
    return this.apiKey ? `sk-…${this.apiKey.slice(-4)}` : ''
  }
  getElevenLabsKey(): string | null {
    return this.elevenKey
  }
  setElevenLabsKey(key: string | null): void {
    this.elevenKey = key || null
  }
  elevenLabsKeyHint(): string {
    return this.elevenKey ? `…${this.elevenKey.slice(-4)}` : ''
  }
  onChange(): () => void {
    return () => undefined
  }
}

export class MemoryChats implements ChatStore {
  readonly chats = new Map<string, Chat>()
  private seq = 0

  private toSummary(chat: Chat): ChatSummary {
    const { messages: _messages, ...summary } = chat
    return structuredClone(summary)
  }

  private touch(chat: Chat): void {
    chat.updatedAt = Date.now()
    chat.messageCount = chat.messages.length
    const last = chat.messages[chat.messages.length - 1]
    chat.preview = last ? last.text.slice(0, 120) : ''
  }

  list(): ChatSummary[] {
    return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => this.toSummary(c))
  }

  get(id: string): Chat | null {
    const chat = this.chats.get(id)
    return chat ? structuredClone(chat) : null
  }

  summary(id: string): ChatSummary | null {
    const chat = this.chats.get(id)
    return chat ? this.toSummary(chat) : null
  }

  create(init: { tier?: Tier; source?: MessageSource; title?: string } = {}): Chat {
    const now = Date.now()
    const chat: Chat = {
      id: `chat${++this.seq}`,
      title: init.title ?? 'Новый чат',
      createdAt: now,
      updatedAt: now,
      tier: init.tier ?? 'terra',
      source: init.source ?? 'text',
      messageCount: 0,
      preview: '',
      messages: []
    }
    this.chats.set(chat.id, chat)
    return structuredClone(chat)
  }

  appendMessage(chatId: string, message: ChatMessage): void {
    const chat = this.chats.get(chatId)
    if (!chat) throw new Error(`no chat ${chatId}`)
    chat.messages.push(structuredClone(message))
    this.touch(chat)
  }

  updateMessage(chatId: string, messageId: string, patch: Partial<ChatMessage>): void {
    const chat = this.chats.get(chatId)
    const message = chat?.messages.find((m) => m.id === messageId)
    if (!chat || !message) return
    Object.assign(message, structuredClone(patch))
    this.touch(chat)
  }

  rename(chatId: string, title: string): void {
    const chat = this.chats.get(chatId)
    if (chat) chat.title = title
  }

  setTier(chatId: string, tier: Tier): void {
    const chat = this.chats.get(chatId)
    if (chat) chat.tier = tier
  }

  remove(chatId: string): void {
    this.chats.delete(chatId)
  }

  clearAll(): void {
    this.chats.clear()
  }

  search(query: string): ChatSummary[] {
    const q = query.toLowerCase()
    return this.list().filter((s) => {
      const chat = this.chats.get(s.id)
      return s.title.toLowerCase().includes(q) || chat?.messages.some((m) => m.text.toLowerCase().includes(q))
    })
  }

  findRecentVoiceChat(maxAgeMs: number): Chat | null {
    const recent = [...this.chats.values()]
      .filter((c) => c.source === 'voice' && Date.now() - c.updatedAt < maxAgeMs)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return recent ? structuredClone(recent) : null
  }

  flush(): void {}

  /** Raw stored chat (no clone) for assertions. */
  raw(id: string): Chat {
    const chat = this.chats.get(id)
    if (!chat) throw new Error(`no chat ${id}`)
    return chat
  }
}

/** 1×1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

export class MemoryMedia implements MediaStore {
  readonly items = new Map<string, { ref: ImageRef; data: Buffer; mime: string }>()
  readonly dataUrlCalls: Array<{ id: string; maxSide?: number }> = []
  private seq = 0

  save(
    data: Buffer,
    opts: { kind: ImageRef['kind']; mime: 'image/png' | 'image/jpeg'; width?: number; height?: number }
  ): ImageRef {
    const id = `img${++this.seq}`
    const ref: ImageRef = { id, url: `jarvis-media://image/${id}`, kind: opts.kind, width: opts.width, height: opts.height }
    this.items.set(id, { ref, data, mime: opts.mime })
    return ref
  }

  ref(id: string): ImageRef | null {
    return this.items.get(id)?.ref ?? null
  }

  path(id: string): string | null {
    return this.items.has(id) ? `/media/${id}.png` : null
  }

  async dataUrl(id: string, opts?: { maxSide?: number }): Promise<string | null> {
    this.dataUrlCalls.push({ id, maxSide: opts?.maxSide })
    const item = this.items.get(id)
    return item ? `data:${item.mime};base64,${item.data.toString('base64')}` : null
  }

  remove(id: string): void {
    this.items.delete(id)
  }
}

export interface FakeTool {
  spec: ToolSpec
  title?: (args: Record<string, unknown>) => string
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult
}

export function toolSpec(name: string, properties: Record<string, unknown> = {}): ToolSpec {
  return { name, description: `Test tool ${name}`, parameters: { type: 'object', properties } }
}

export class FakeTools implements ToolRegistry {
  readonly calls: Array<{ name: string; args: Record<string, unknown>; ctx: ToolContext }> = []

  constructor(public tools: FakeTool[] = []) {}

  specs(): ToolSpec[] {
    return this.tools.map((t) => t.spec)
  }

  describe(name: string, args: Record<string, unknown>): string {
    return this.tools.find((t) => t.spec.name === name)?.title?.(args) ?? `Выполняю ${name}`
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    this.calls.push({ name, args, ctx })
    const tool = this.tools.find((t) => t.spec.name === name)
    if (!tool) return { ok: false, output: `Error: unknown tool ${name}` }
    return tool.run(args, ctx)
  }
}

export const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Collects log lines for assertions. */
export function memoryLog(): Logger & { lines: string[] } {
  const lines: string[] = []
  const add = (...args: unknown[]): void => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  }
  return { lines, debug: add, info: add, warn: add, error: add }
}
