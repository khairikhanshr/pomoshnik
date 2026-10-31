import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatMessage } from '@shared/types'
import { createChatStore, type ChatStoreOptions } from '../../src/main/store/chats'

let dir: string
let now: number

const msg = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  text,
  createdAt: now,
  ...extra
})

function open(opts: ChatStoreOptions = {}) {
  return createChatStore(dir, { now: () => now, ...opts })
}

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'jarvis-chats-')), 'chats')
  now = 1_700_000_000_000
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

describe('createChatStore', () => {
  it('creates chats with defaults and emits chat-updated', () => {
    const events: ChatEvent[] = []
    const store = open({ onEvent: (e) => events.push(e), defaultTier: () => 'sol' })
    const chat = store.create()
    expect(chat).toMatchObject({ title: 'Новый чат', tier: 'sol', source: 'text', messageCount: 0, messages: [] })
    expect(chat.id).toMatch(/^[a-z0-9]+$/)
    expect(store.create({ tier: 'luna', source: 'voice', title: '  Мой   чат ' })).toMatchObject({
      tier: 'luna',
      source: 'voice',
      title: 'Мой чат'
    })
    expect(store.list()).toHaveLength(2)
    expect(events.filter((e) => e.type === 'chat-updated')).toHaveLength(2)
  })

  it('appends and updates messages, keeping summaries in sync', () => {
    const store = open()
    const { id } = store.create()
    now += 1000
    store.appendMessage(id, msg('m1', 'user', 'Привет, **Джарвис**'))
    store.appendMessage(id, msg('m2', 'assistant', '', { status: 'streaming' }))
    let summary = store.summary(id)!
    expect(summary.messageCount).toBe(2)
    expect(summary.preview).toBe('Привет, Джарвис')
    expect(summary.updatedAt).toBe(now)

    store.updateMessage(id, 'm2', { text: 'Добрый день, сэр.', status: 'done', error: undefined })
    summary = store.summary(id)!
    expect(summary.preview).toBe('Добрый день, сэр.')
    const chat = store.get(id)!
    expect(chat.messages[1]).toMatchObject({ text: 'Добрый день, сэр.', status: 'done' })
    expect(chat.messages[1]).not.toHaveProperty('error')

    // get() returns a copy
    chat.messages.push(msg('x', 'user', 'mutation'))
    expect(store.get(id)!.messages).toHaveLength(2)

    // appending a message with an existing id replaces it
    store.appendMessage(id, msg('m1', 'user', 'Исправлено'))
    expect(store.get(id)!.messages.map((m) => m.text)).toEqual(['Исправлено', 'Добрый день, сэр.'])

    // unknown chats / messages are ignored, not fatal
    expect(() => store.appendMessage('nope', msg('a', 'user', 'x'))).not.toThrow()
    expect(() => store.updateMessage(id, 'nope', { text: 'x' })).not.toThrow()
  })

  it('renames and changes tier with validation', () => {
    const events: ChatEvent[] = []
    const store = open({ onEvent: (e) => events.push(e) })
    const { id } = store.create()
    events.length = 0
    store.rename(id, '  Планы   на неделю ')
    store.rename(id, '   ')
    store.setTier(id, 'sol')
    store.setTier(id, 'mars' as never)
    expect(store.summary(id)).toMatchObject({ title: 'Планы на неделю', tier: 'sol' })
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.type === 'chat-updated')).toBe(true)
  })

  it('debounces writes and flushes on demand', () => {
    vi.useFakeTimers()
    const store = open()
    const { id } = store.create()
    store.appendMessage(id, msg('m1', 'user', 'Сохрани меня'))
    const file = join(dir, `${id}.json`)
    expect(existsSync(file)).toBe(false)
    vi.advanceTimersByTime(299)
    expect(existsSync(file)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).chats).toHaveLength(1)

    store.appendMessage(id, msg('m2', 'assistant', 'Сохранено'))
    store.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).messages).toHaveLength(2)
  })

  it('coalesces summary events from streaming updates', () => {
    vi.useFakeTimers()
    const events: ChatEvent[] = []
    const store = open({ onEvent: (e) => events.push(e) })
    const { id } = store.create()
    events.length = 0
    store.appendMessage(id, msg('m1', 'assistant', ''))
    for (let i = 0; i < 20; i++) store.updateMessage(id, 'm1', { text: `Ответ ${i}` })
    expect(events).toHaveLength(0)
    vi.advanceTimersByTime(300)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'chat-updated', chat: { preview: 'Ответ 19' } })
  })

  it('persists across instances', () => {
    const store = open()
    const a = store.create({ source: 'voice' })
    store.appendMessage(a.id, msg('m1', 'user', 'Открой Telegram', { source: 'voice' }))
    store.rename(a.id, 'Telegram')
    store.flush()

    const reopened = open()
    expect(reopened.list()).toEqual(store.list())
    expect(reopened.get(a.id)!.messages[0].text).toBe('Открой Telegram')
  })

  it('survives corrupt chat files and a corrupt index', () => {
    const store = open()
    const good = store.create()
    store.appendMessage(good.id, msg('m1', 'user', 'хорошо'))
    const bad = store.create()
    store.flush()
    writeFileSync(join(dir, `${bad.id}.json`), '{ broken')

    const events: ChatEvent[] = []
    const reopened = open({ onEvent: (e) => events.push(e) })
    expect(reopened.list()).toHaveLength(2)
    expect(reopened.get(bad.id)).toBeNull()
    expect(reopened.list().map((c) => c.id)).toEqual([good.id])
    expect(events).toContainEqual({ type: 'chats-changed' })
    expect(readdirSync(dir).some((f) => f.startsWith(`${bad.id}.corrupt-`))).toBe(true)

    writeFileSync(join(dir, 'index.json'), 'garbage')
    const rebuilt = open()
    expect(rebuilt.list().map((c) => c.id)).toEqual([good.id])
    expect(rebuilt.summary(good.id)!.messageCount).toBe(1)
  })

  it('reconciles the index with the files on disk', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'abc123.json'),
      JSON.stringify({ id: 'abc123', title: 'Потерянный', createdAt: 1, updatedAt: 2, tier: 'luna', messages: [] })
    )
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({ version: 1, chats: [{ id: 'gone1', title: 'Нет файла', createdAt: 1, updatedAt: 1 }] })
    )
    const store = open()
    expect(store.list().map((c) => c.id)).toEqual(['abc123'])
    expect(store.summary('abc123')).toMatchObject({ title: 'Потерянный', tier: 'luna' })
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).chats.map((c: { id: string }) => c.id)).toEqual([
      'abc123'
    ])
  })

  it('marks messages left streaming by a previous session as cancelled', () => {
    mkdirSync(dir, { recursive: true })
    const stale = {
      id: 'stale1',
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
      messages: [
        {
          id: 'a',
          role: 'assistant',
          text: 'Начал отвечать',
          createdAt: now - 10_000,
          status: 'streaming',
          toolCalls: [{ id: 'c1', name: 'take_screenshot', title: 'Снимок', args: {}, status: 'running', startedAt: 1 }]
        },
        { id: 'junk' },
        'garbage'
      ]
    }
    writeFileSync(join(dir, 'stale1.json'), JSON.stringify(stale))
    const chat = open().get('stale1')!
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0].status).toBe('cancelled')
    expect(chat.messages[0].toolCalls![0]).toMatchObject({ status: 'error', summary: 'Прервано' })
  })

  it('rejects ids that are not plain identifiers', () => {
    const store = open()
    expect(store.get('../settings')).toBeNull()
    expect(store.get('ABC')).toBeNull()
    expect(store.get(42 as unknown as string)).toBeNull()
    expect(store.summary('../x')).toBeNull()
  })

  it('searches titles and message text case-insensitively', () => {
    const store = open()
    const a = store.create({ title: 'Ёлка на Новый год' })
    now += 1
    const b = store.create()
    store.appendMessage(b.id, msg('m1', 'user', 'Сделай скриншот и ответь на ВОПРОСЫ теста'))
    store.appendMessage(b.id, msg('m2', 'assistant', 'Вопрос 1 — B. Вопрос 2 — A.'))
    now += 1
    store.create({ title: 'Другое' })

    expect(store.search('елка').map((c) => c.id)).toEqual([a.id])
    const hits = store.search('вопрос 2')
    expect(hits.map((c) => c.id)).toEqual([b.id])
    expect(hits[0].preview).toContain('Вопрос 2')
    expect(store.search('вопросы теста')[0].id).toBe(b.id)
    expect(store.search('   ')).toHaveLength(3)
    expect(store.search('(unbalanced[')).toEqual([])

    // chats not in the memory cache are searched on disk
    store.flush()
    const reopened = open({ cacheSize: 1 })
    expect(reopened.search('ответь').map((c) => c.id)).toEqual([b.id])
  })

  it('finds the most recent voice chat within the time window', () => {
    const store = open()
    const old = store.create({ source: 'voice' })
    now += 1000
    const recent = store.create({ source: 'voice' })
    now += 1000
    store.create({ source: 'text' })
    now += 60_000
    expect(store.findRecentVoiceChat(15 * 60_000)?.id).toBe(recent.id)
    now += 15 * 60_000
    expect(store.findRecentVoiceChat(15 * 60_000)).toBeNull()
    store.appendMessage(old.id, msg('m', 'user', 'снова'))
    expect(store.findRecentVoiceChat(15 * 60_000)?.id).toBe(old.id)
    expect(store.findRecentVoiceChat(0)).toBeNull()
  })

  it('removes chats and reports media no other chat references', () => {
    const removed: string[][] = []
    const events: ChatEvent[] = []
    const store = open({ onRemoveMedia: (ids) => removed.push(ids), onEvent: (e) => events.push(e) })
    const image = (id: string) => ({ id, url: `jarvis-media://image/${id}`, kind: 'upload' as const })
    const a = store.create()
    const b = store.create()
    store.appendMessage(a.id, msg('m1', 'user', 'фото', { images: [image('shared1'), image('own1')] }))
    store.appendMessage(b.id, msg('m1', 'user', 'фото', { images: [image('shared1')] }))
    store.flush()

    store.remove(a.id)
    expect(removed).toEqual([['own1']])
    expect(store.get(a.id)).toBeNull()
    expect(existsSync(join(dir, `${a.id}.json`))).toBe(false)
    expect(events).toContainEqual({ type: 'chats-changed' })

    store.clearAll()
    expect(removed[1]).toEqual(['shared1'])
    expect(store.list()).toEqual([])
    expect(readdirSync(dir).filter((f) => f !== 'index.json')).toEqual([])
    expect(open().list()).toEqual([])
  })
})
