// Pure reconciliation of ChatEvents into renderer state (no DOM; unit-tested in tests/ui).
import type { Chat, ChatEvent, ChatMessage, ChatSummary, ToolCallRecord } from '@shared/types'

/**
 * A turn tracked from its turn-start event. It is the source of truth for the streaming assistant
 * message until turn-end, so a chat snapshot fetched mid-stream never loses or duplicates deltas.
 */
export interface LiveTurn {
  chatId: string
  turnId: string
  userMessage?: ChatMessage
  message: ChatMessage
}

export interface ChatData {
  summaries: ChatSummary[]
  /** Fully loaded chats by id. */
  chats: Record<string, Chat>
  /** Live turns by assistant message id. */
  live: Record<string, LiveTurn>
}

export const EMPTY_CHAT_DATA: ChatData = { summaries: [], chats: {}, live: {} }

export function sortSummaries(list: ChatSummary[]): ChatSummary[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function upsertSummary(list: ChatSummary[], summary: ChatSummary): ChatSummary[] {
  const rest = list.filter((s) => s.id !== summary.id)
  return sortSummaries([...rest, summary])
}

function upsertCall(calls: ToolCallRecord[] | undefined, call: ToolCallRecord): ToolCallRecord[] {
  const list = calls ?? []
  const i = list.findIndex((c) => c.id === call.id)
  if (i < 0) return [...list, call]
  const next = [...list]
  next[i] = { ...list[i], ...call }
  return next
}

function replaceMessage(chat: Chat, messageId: string, fn: (m: ChatMessage) => ChatMessage): Chat {
  let found = false
  const messages = chat.messages.map((m) => {
    if (m.id !== messageId) return m
    found = true
    return fn(m)
  })
  return found ? { ...chat, messages } : chat
}

function hasMessage(chat: Chat, id: string): boolean {
  return chat.messages.some((m) => m.id === id)
}

/** Appends the live user/assistant pair when a snapshot predates them. */
function ensureLiveMessages(chat: Chat, turn: LiveTurn): Chat {
  let messages = chat.messages
  if (turn.userMessage && !hasMessage(chat, turn.userMessage.id)) messages = [...messages, turn.userMessage]
  if (!messages.some((m) => m.id === turn.message.id)) messages = [...messages, turn.message]
  return messages === chat.messages ? chat : { ...chat, messages }
}

/** Writes a live turn's message into its chat (if loaded). */
function syncLive(chats: Record<string, Chat>, turn: LiveTurn): Record<string, Chat> {
  const chat = chats[turn.chatId]
  if (!chat) return chats
  const withPair = ensureLiveMessages(chat, turn)
  return { ...chats, [turn.chatId]: replaceMessage(withPair, turn.message.id, () => turn.message) }
}

function liveFor(data: ChatData, chatId: string, turnId: string, messageId: string): LiveTurn {
  const existing = data.live[messageId]
  if (existing) return existing
  // Turn started before this window subscribed: continue from the snapshot (if any).
  const snapshot = data.chats[chatId]?.messages.find((m) => m.id === messageId)
  return {
    chatId,
    turnId,
    message: snapshot ?? { id: messageId, role: 'assistant', text: '', createdAt: Date.now(), status: 'streaming' }
  }
}

function withLive(data: ChatData, turn: LiveTurn): ChatData {
  return { ...data, live: { ...data.live, [turn.message.id]: turn }, chats: syncLive(data.chats, turn) }
}

function withoutLive(live: Record<string, LiveTurn>, messageId: string): Record<string, LiveTurn> {
  if (!live[messageId]) return live
  const next = { ...live }
  delete next[messageId]
  return next
}

export function applyChatEvent(data: ChatData, ev: ChatEvent): ChatData {
  switch (ev.type) {
    case 'turn-start': {
      const turn: LiveTurn = {
        chatId: ev.chatId,
        turnId: ev.turnId,
        userMessage: ev.userMessage,
        message: { ...ev.assistantMessage, status: ev.assistantMessage.status ?? 'streaming' }
      }
      return withLive(data, turn)
    }
    case 'delta': {
      const turn = liveFor(data, ev.chatId, ev.turnId, ev.messageId)
      return withLive(data, { ...turn, message: { ...turn.message, text: turn.message.text + ev.text } })
    }
    case 'tool-start':
    case 'tool-end': {
      const turn = liveFor(data, ev.chatId, ev.turnId, ev.messageId)
      return withLive(data, { ...turn, message: { ...turn.message, toolCalls: upsertCall(turn.message.toolCalls, ev.call) } })
    }
    case 'image': {
      const turn = liveFor(data, ev.chatId, ev.turnId, ev.messageId)
      const images = turn.message.images ?? []
      if (images.some((i) => i.id === ev.image.id)) return data
      return withLive(data, { ...turn, message: { ...turn.message, images: [...images, ev.image] } })
    }
    case 'turn-end': {
      const turn = data.live[ev.message.id]
      let chats = data.chats
      const chat = chats[ev.chatId]
      if (chat) {
        const base = turn ? ensureLiveMessages(chat, turn) : hasMessage(chat, ev.message.id) ? chat : { ...chat, messages: [...chat.messages, ev.message] }
        chats = { ...chats, [ev.chatId]: replaceMessage(base, ev.message.id, () => ev.message) }
      }
      return { ...data, chats, live: withoutLive(data.live, ev.message.id) }
    }
    case 'turn-error': {
      const turn = liveFor(data, ev.chatId, ev.turnId, ev.messageId)
      const failed: LiveTurn = { ...turn, message: { ...turn.message, status: 'error', error: ev.error } }
      return { ...data, chats: syncLive(data.chats, failed), live: withoutLive(data.live, ev.messageId) }
    }
    case 'chat-updated': {
      const summaries = upsertSummary(data.summaries, ev.chat)
      const chat = data.chats[ev.chat.id]
      if (!chat) return { ...data, summaries }
      return { ...data, summaries, chats: { ...data.chats, [ev.chat.id]: { ...chat, ...ev.chat, messages: chat.messages } } }
    }
    case 'chats-changed':
      return data
  }
}

/** Overlays live turns onto a freshly fetched chat snapshot. */
export function mergeSnapshot(chat: Chat, live: Record<string, LiveTurn>): Chat {
  let merged = chat
  for (const turn of Object.values(live)) {
    if (turn.chatId !== chat.id) continue
    merged = replaceMessage(ensureLiveMessages(merged, turn), turn.message.id, () => turn.message)
  }
  return merged
}

/** Messages known only from live turns (chat not loaded yet), in turn order. */
export function liveMessages(live: Record<string, LiveTurn>, chatId: string): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const turn of Object.values(live)) {
    if (turn.chatId !== chatId) continue
    if (turn.userMessage) out.push(turn.userMessage)
    out.push(turn.message)
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

export function activeTurn(live: Record<string, LiveTurn>, chatId: string | null): LiveTurn | undefined {
  if (!chatId) return undefined
  return Object.values(live).find((t) => t.chatId === chatId)
}

/** Drops chats that no longer exist after a list refresh. */
export function pruneChats(data: ChatData, summaries: ChatSummary[]): ChatData {
  const ids = new Set(summaries.map((s) => s.id))
  const chats: Record<string, Chat> = {}
  for (const [id, chat] of Object.entries(data.chats)) if (ids.has(id)) chats[id] = chat
  return { ...data, summaries: sortSummaries(summaries), chats }
}
