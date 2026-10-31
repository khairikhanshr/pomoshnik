// Pure helpers for chat persistence: parsing stored chats, summaries, previews and search snippets.
import { TIERS } from '@shared/types'
import type { Chat, ChatMessage, ChatSummary, ImageRef, Tier, ToolCallRecord } from '@shared/types'

export const NEW_CHAT_TITLE = 'Новый чат'
export const CHAT_ID_RE = /^[a-z0-9]{1,64}$/
export const MAX_TITLE_LENGTH = 200
const PREVIEW_LENGTH = 120

type Raw = Record<string, unknown>

const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value)
}

export function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') return ''
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}

function parseImage(raw: unknown): ImageRef | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const image: ImageRef = {
    id: raw.id,
    url: typeof raw.url === 'string' && raw.url ? raw.url : `jarvis-media://image/${raw.id}`,
    kind: raw.kind === 'screenshot' ? 'screenshot' : 'upload'
  }
  if (isFiniteNumber(raw.width)) image.width = raw.width
  if (isFiniteNumber(raw.height)) image.height = raw.height
  return image
}

function parseToolCall(raw: unknown, stale: boolean): ToolCallRecord | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  const status = raw.status === 'ok' || raw.status === 'error' || raw.status === 'denied' ? raw.status : 'running'
  const call: ToolCallRecord = {
    id: raw.id,
    name: raw.name,
    title: typeof raw.title === 'string' ? raw.title : raw.name,
    args: isRecord(raw.args) ? raw.args : {},
    status: stale && status === 'running' ? 'error' : status,
    startedAt: isFiniteNumber(raw.startedAt) ? raw.startedAt : 0
  }
  if (typeof raw.summary === 'string') call.summary = raw.summary
  else if (stale && status === 'running') call.summary = 'Прервано'
  if (isFiniteNumber(raw.endedAt)) call.endedAt = raw.endedAt
  return call
}

/**
 * Validates one stored message. Messages that were still streaming when a previous session ended
 * (createdAt < sessionStart) are marked cancelled so the UI does not show an endless spinner.
 */
export function parseMessage(raw: unknown, sessionStart: number): ChatMessage | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  if (raw.role !== 'user' && raw.role !== 'assistant') return null
  const createdAt = isFiniteNumber(raw.createdAt) ? raw.createdAt : 0
  const stale = createdAt < sessionStart
  const msg: ChatMessage = { id: raw.id, role: raw.role, text: typeof raw.text === 'string' ? raw.text : '', createdAt }
  if (Array.isArray(raw.images)) {
    const images = raw.images.map(parseImage).filter((i): i is ImageRef => i !== null)
    if (images.length) msg.images = images
  }
  if (Array.isArray(raw.toolCalls)) {
    const calls = raw.toolCalls.map((c) => parseToolCall(c, stale)).filter((c): c is ToolCallRecord => c !== null)
    if (calls.length) msg.toolCalls = calls
  }
  if (isTier(raw.tier)) msg.tier = raw.tier
  if (typeof raw.model === 'string') msg.model = raw.model
  if (raw.source === 'text' || raw.source === 'voice') msg.source = raw.source
  if (raw.status === 'streaming' || raw.status === 'done' || raw.status === 'error' || raw.status === 'cancelled') {
    msg.status = raw.status === 'streaming' && stale ? 'cancelled' : raw.status
  }
  if (typeof raw.error === 'string') msg.error = raw.error
  return msg
}

/** Parses a stored chat file; null when it is not a chat at all. */
export function parseChat(raw: unknown, id: string, fallbackTier: Tier, sessionStart: number): Chat | null {
  if (!isRecord(raw) || !Array.isArray(raw.messages)) return null
  if (raw.id !== undefined && raw.id !== id) return null
  const messages = raw.messages
    .map((m) => parseMessage(m, sessionStart))
    .filter((m): m is ChatMessage => m !== null)
  const createdAt = isFiniteNumber(raw.createdAt) ? raw.createdAt : (messages[0]?.createdAt ?? 0)
  const lastAt = messages.length ? messages[messages.length - 1].createdAt : createdAt
  const chat: Chat = {
    id,
    title: normalizeTitle(raw.title) || NEW_CHAT_TITLE,
    createdAt,
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : lastAt,
    tier: isTier(raw.tier) ? raw.tier : fallbackTier,
    source: raw.source === 'voice' ? 'voice' : 'text',
    messageCount: messages.length,
    preview: '',
    messages
  }
  if (raw.pinned === true) chat.pinned = true
  chat.preview = previewOf(chat.messages)
  return chat
}

/** Parses an index entry; null when invalid. */
export function parseSummary(raw: unknown, fallbackTier: Tier): (ChatSummary & { media: string[] }) | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !CHAT_ID_RE.test(raw.id)) return null
  const summary: ChatSummary & { media: string[] } = {
    id: raw.id,
    title: normalizeTitle(raw.title) || NEW_CHAT_TITLE,
    createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: isFiniteNumber(raw.updatedAt) ? raw.updatedAt : 0,
    tier: isTier(raw.tier) ? raw.tier : fallbackTier,
    source: raw.source === 'voice' ? 'voice' : 'text',
    messageCount: isFiniteNumber(raw.messageCount) ? raw.messageCount : 0,
    preview: typeof raw.preview === 'string' ? raw.preview : '',
    media: Array.isArray(raw.media) ? raw.media.filter((m): m is string => typeof m === 'string') : []
  }
  if (raw.pinned === true) summary.pinned = true
  return summary
}

/** Plain-text excerpt of markdown for list previews. */
export function plainExcerpt(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' [код] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)[#>]+\s/g, '$1')
    .replace(/[*~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Preview of the last message that has content. */
export function previewOf(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const text = plainExcerpt(msg.text)
    if (text) return truncate(text, PREVIEW_LENGTH)
    if (msg.images?.length) return '[изображение]'
  }
  return ''
}

export function mediaIdsOf(messages: ChatMessage[]): string[] {
  const ids = new Set<string>()
  for (const msg of messages) for (const img of msg.images ?? []) ids.add(img.id)
  return [...ids]
}

export function summaryOf(chat: Chat): ChatSummary {
  const summary: ChatSummary = {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    tier: chat.tier,
    source: chat.source,
    messageCount: chat.messages.length,
    preview: previewOf(chat.messages)
  }
  if (chat.pinned) summary.pinned = true
  return summary
}

/** Case-insensitive matcher that treats "е" and "ё" as the same letter. */
export function createMatcher(query: string): RegExp | null {
  const q = query.replace(/\s+/g, ' ').trim()
  if (!q) return null
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/gi, '[её]')
  return new RegExp(escaped, 'iu')
}

/** ~120 chars of text around the first match. */
export function snippetAround(text: string, matcher: RegExp): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const m = matcher.exec(flat)
  if (!m) return truncate(flat, PREVIEW_LENGTH)
  const start = Math.max(0, m.index - 40)
  const end = Math.min(flat.length, start + PREVIEW_LENGTH)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}
