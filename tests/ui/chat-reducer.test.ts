import { describe, expect, it } from 'vitest'
import type { Chat, ChatMessage, ChatSummary, ToolCallRecord } from '@shared/types'
import {
  activeTurn,
  applyChatEvent,
  EMPTY_CHAT_DATA,
  liveMessages,
  mergeSnapshot,
  pruneChats,
  type ChatData
} from '../../src/renderer/src/main/state/chat-reducer'

const summary = (id: string, updatedAt: number, title = id): ChatSummary => ({
  id,
  title,
  createdAt: 0,
  updatedAt,
  tier: 'terra',
  source: 'text',
  messageCount: 0,
  preview: ''
})

const user: ChatMessage = { id: 'u1', role: 'user', text: 'Привет', createdAt: 1 }
const assistant: ChatMessage = { id: 'a1', role: 'assistant', text: '', createdAt: 2, status: 'streaming' }

function loaded(messages: ChatMessage[] = []): ChatData {
  const chat: Chat = { ...summary('c1', 1), messages }
  return { ...EMPTY_CHAT_DATA, summaries: [summary('c1', 1)], chats: { c1: chat } }
}

function start(data: ChatData): ChatData {
  return applyChatEvent(data, { type: 'turn-start', chatId: 'c1', turnId: 't1', userMessage: user, assistantMessage: assistant })
}

const call = (status: ToolCallRecord['status'], summaryText?: string): ToolCallRecord => ({
  id: 'call1',
  name: 'take_screenshot',
  title: 'Делаю снимок экрана',
  args: {},
  status,
  summary: summaryText,
  startedAt: 10
})

describe('applyChatEvent', () => {
  it('appends the turn pair and accumulates deltas', () => {
    let data = start(loaded())
    data = applyChatEvent(data, { type: 'delta', chatId: 'c1', turnId: 't1', messageId: 'a1', text: 'Добрый ' })
    data = applyChatEvent(data, { type: 'delta', chatId: 'c1', turnId: 't1', messageId: 'a1', text: 'день' })
    expect(data.chats.c1.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(data.chats.c1.messages[1].text).toBe('Добрый день')
    expect(activeTurn(data.live, 'c1')?.turnId).toBe('t1')
  })

  it('upserts tool calls by id and dedupes images', () => {
    let data = start(loaded())
    data = applyChatEvent(data, { type: 'tool-start', chatId: 'c1', turnId: 't1', messageId: 'a1', call: call('running') })
    data = applyChatEvent(data, { type: 'tool-end', chatId: 'c1', turnId: 't1', messageId: 'a1', call: call('ok', 'Готово') })
    const image = { id: 'img1', url: 'jarvis-media://image/img1', kind: 'screenshot' as const }
    data = applyChatEvent(data, { type: 'image', chatId: 'c1', turnId: 't1', messageId: 'a1', image })
    data = applyChatEvent(data, { type: 'image', chatId: 'c1', turnId: 't1', messageId: 'a1', image })
    const message = data.chats.c1.messages[1]
    expect(message.toolCalls).toHaveLength(1)
    expect(message.toolCalls?.[0]).toMatchObject({ status: 'ok', summary: 'Готово' })
    expect(message.images).toHaveLength(1)
  })

  it('replaces the message on turn-end and clears the live turn', () => {
    let data = start(loaded())
    data = applyChatEvent(data, { type: 'delta', chatId: 'c1', turnId: 't1', messageId: 'a1', text: 'черновик' })
    const final: ChatMessage = { ...assistant, text: 'Готово, сэр.', status: 'done' }
    data = applyChatEvent(data, { type: 'turn-end', chatId: 'c1', turnId: 't1', message: final })
    expect(data.chats.c1.messages[1]).toEqual(final)
    expect(data.live).toEqual({})
  })

  it('keeps partial text and marks the message on turn-error', () => {
    let data = start(loaded())
    data = applyChatEvent(data, { type: 'delta', chatId: 'c1', turnId: 't1', messageId: 'a1', text: 'Начал' })
    data = applyChatEvent(data, { type: 'turn-error', chatId: 'c1', turnId: 't1', messageId: 'a1', error: 'Сеть недоступна' })
    expect(data.chats.c1.messages[1]).toMatchObject({ text: 'Начал', status: 'error', error: 'Сеть недоступна' })
    expect(activeTurn(data.live, 'c1')).toBeUndefined()
  })

  it('tracks turns of chats that are not loaded', () => {
    let data = start({ ...EMPTY_CHAT_DATA })
    data = applyChatEvent(data, { type: 'delta', chatId: 'c1', turnId: 't1', messageId: 'a1', text: 'Да' })
    expect(data.chats).toEqual({})
    expect(liveMessages(data.live, 'c1').map((m) => [m.id, m.text])).toEqual([
      ['u1', 'Привет'],
      ['a1', 'Да']
    ])
  })

  it('continues a turn that started before the window subscribed', () => {
    const data = applyChatEvent(loaded([user, { ...assistant, text: 'Уже ' }]), {
      type: 'delta',
      chatId: 'c1',
      turnId: 't1',
      messageId: 'a1',
      text: 'есть'
    })
    expect(data.chats.c1.messages[1].text).toBe('Уже есть')
  })

  it('upserts summaries newest first and patches loaded chats', () => {
    let data: ChatData = { ...loaded(), summaries: [summary('c1', 1), summary('c2', 5)] }
    data = applyChatEvent(data, { type: 'chat-updated', chat: summary('c1', 9, 'Новое имя') })
    expect(data.summaries.map((s) => s.id)).toEqual(['c1', 'c2'])
    expect(data.chats.c1.title).toBe('Новое имя')
  })
})

describe('mergeSnapshot', () => {
  it('prefers live text over a stale snapshot and appends missing messages', () => {
    let data = start({ ...EMPTY_CHAT_DATA })
    data = applyChatEvent(data, { type: 'delta', chatId: 'c1', turnId: 't1', messageId: 'a1', text: 'Свежий текст' })
    const stale: Chat = { ...summary('c1', 1), messages: [user, { ...assistant, text: 'Свежий' }] }
    expect(mergeSnapshot(stale, data.live).messages[1].text).toBe('Свежий текст')
    const empty: Chat = { ...summary('c1', 1), messages: [] }
    expect(mergeSnapshot(empty, data.live).messages.map((m) => m.id)).toEqual(['u1', 'a1'])
  })
})

describe('pruneChats', () => {
  it('drops chats that no longer exist', () => {
    const data = pruneChats(loaded(), [summary('c2', 3)])
    expect(data.chats).toEqual({})
    expect(data.summaries.map((s) => s.id)).toEqual(['c2'])
  })
})
