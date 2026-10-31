// ChatStore: userData/chats/index.json (summaries) + userData/chats/<id>.json (full chats).
// Writes are atomic and coalesced (at most `debounceMs` after a change); flush() writes synchronously.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Chat, ChatEvent, ChatMessage, ChatSummary, MessageSource, Tier } from '@shared/types'
import { createLogger } from '../log'
import type { ChatStore } from '../services'
import { newId, writeJsonAtomic } from '../util/fs'
import {
  CHAT_ID_RE,
  createMatcher,
  isTier,
  mediaIdsOf,
  NEW_CHAT_TITLE,
  normalizeTitle,
  parseChat,
  parseSummary,
  snippetAround,
  summaryOf
} from './chat-format'

const log = createLogger('chats')

const INDEX_VERSION = 1
const MAX_SEARCH_RESULTS = 200
const RETRY_DELAY_MS = 2000

export interface ChatStoreOptions {
  /** Summary changes for the UI ('chat-updated' / 'chats-changed'). */
  onEvent?: (ev: ChatEvent) => void
  /** Media ids no longer referenced by any chat after remove() / clearAll(). */
  onRemoveMedia?: (ids: string[]) => void
  /** Tier for chats created without one. */
  defaultTier?: () => Tier
  /** Max delay between a change and its write. */
  debounceMs?: number
  now?: () => number
  /** Max number of full chats kept in memory (chats with unsaved changes are never evicted). */
  cacheSize?: number
}

interface Entry {
  summary: ChatSummary
  media: string[]
}

type ReadResult = { kind: 'ok'; chat: Chat } | { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'error' }

export function createChatStore(dir: string, opts: ChatStoreOptions = {}): ChatStore {
  const clock = opts.now ?? Date.now
  const debounceMs = opts.debounceMs ?? 300
  const cacheSize = Math.max(1, opts.cacheSize ?? 100)
  const defaultTier = (): Tier => {
    const t = opts.defaultTier?.()
    return isTier(t) ? t : 'terra'
  }
  const sessionStart = clock()
  const indexFile = join(dir, 'index.json')
  const chatFile = (id: string): string => join(dir, `${id}.json`)

  const entries = new Map<string, Entry>()
  const cache = new Map<string, Chat>()
  const dirty = new Set<string>()
  const changedSummaries = new Set<string>()
  const emitted = new Map<string, string>()
  let indexDirty = false
  let timer: NodeJS.Timeout | null = null

  function emit(ev: ChatEvent): void {
    try {
      opts.onEvent?.(ev)
    } catch (err) {
      log.error('chat event listener failed', err)
    }
  }

  function emitSummary(id: string): void {
    const entry = entries.get(id)
    if (!entry) return
    const json = JSON.stringify(entry.summary)
    if (emitted.get(id) === json) return
    emitted.set(id, json)
    emit({ type: 'chat-updated', chat: structuredClone(entry.summary) })
  }

  function removeMedia(ids: string[]): void {
    if (!ids.length || !opts.onRemoveMedia) return
    try {
      opts.onRemoveMedia(ids)
    } catch (err) {
      log.warn('media cleanup failed', err)
    }
  }

  function readChatFile(id: string): ReadResult {
    let text: string
    try {
      text = readFileSync(chatFile(id), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      log.warn(`chat ${id} is unreadable`, err)
      return { kind: 'error' }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      raw = undefined
    }
    const chat = parseChat(raw, id, defaultTier(), sessionStart)
    if (!chat) {
      log.warn(`chat ${id} is corrupt, moved aside`)
      try {
        renameSync(chatFile(id), join(dir, `${id}.corrupt-${Date.now()}.json`))
      } catch {
        // best effort
      }
      return { kind: 'corrupt' }
    }
    return { kind: 'ok', chat }
  }

  function setEntry(chat: Chat): boolean {
    const summary = summaryOf(chat)
    const media = mediaIdsOf(chat.messages)
    const prev = entries.get(chat.id)
    entries.set(chat.id, { summary, media })
    const changed =
      !prev || JSON.stringify(prev.summary) !== JSON.stringify(summary) || prev.media.join() !== media.join()
    if (changed) indexDirty = true
    return changed
  }

  function cachePut(chat: Chat): void {
    cache.delete(chat.id)
    cache.set(chat.id, chat)
    if (cache.size <= cacheSize) return
    for (const id of cache.keys()) {
      if (cache.size <= cacheSize) break
      if (!dirty.has(id) && id !== chat.id) cache.delete(id)
    }
  }

  function dropEntry(id: string): void {
    if (!entries.delete(id)) return
    cache.delete(id)
    dirty.delete(id)
    emitted.delete(id)
    indexDirty = true
    schedule()
    emit({ type: 'chats-changed' })
  }

  /** Full chat for read-only use (search) without polluting the cache. */
  function peekChat(id: string): Chat | null {
    const cached = cache.get(id)
    if (cached) return cached
    const res = readChatFile(id)
    if (res.kind === 'ok') return res.chat
    if (res.kind === 'missing' || res.kind === 'corrupt') dropEntry(id)
    return null
  }

  function loadChat(id: string): Chat | null {
    if (typeof id !== 'string' || !CHAT_ID_RE.test(id)) return null
    const cached = cache.get(id)
    if (cached) {
      cachePut(cached)
      return cached
    }
    if (!entries.has(id)) return null
    const res = readChatFile(id)
    if (res.kind === 'ok') {
      cachePut(res.chat)
      // The index may lag behind the chat file after a crash between the two writes.
      if (setEntry(res.chat)) {
        schedule()
        emitSummary(id)
      }
      return res.chat
    }
    if (res.kind === 'missing' || res.kind === 'corrupt') dropEntry(id)
    return null
  }

  function schedule(delay = debounceMs): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      writePending()
    }, delay)
    timer.unref?.()
  }

  function markChanged(chat: Chat): void {
    setEntry(chat)
    dirty.add(chat.id)
    changedSummaries.add(chat.id)
    schedule()
  }

  function writePending(): void {
    let failed = false
    for (const id of [...dirty]) {
      const chat = cache.get(id)
      if (!chat || !entries.has(id)) {
        dirty.delete(id)
        continue
      }
      try {
        writeJsonAtomic(chatFile(id), chat)
        dirty.delete(id)
      } catch (err) {
        failed = true
        log.error(`failed to save chat ${id}`, err)
      }
    }
    if (indexDirty) {
      try {
        const chats = [...entries.values()].map((e) => ({ ...e.summary, media: e.media }))
        writeJsonAtomic(indexFile, { version: INDEX_VERSION, chats })
        indexDirty = false
      } catch (err) {
        failed = true
        log.error('failed to save chat index', err)
      }
    }
    for (const id of [...changedSummaries]) emitSummary(id)
    changedSummaries.clear()
    if (failed) schedule(RETRY_DELAY_MS)
  }

  function sortedEntries(): Entry[] {
    return [...entries.values()].sort(
      (a, b) => Number(!!b.summary.pinned) - Number(!!a.summary.pinned) || b.summary.updatedAt - a.summary.updatedAt
    )
  }

  function load(): void {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      log.error('cannot create chats directory', err)
    }
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(indexFile, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('chat index is corrupt, rebuilding', err)
    }
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { chats?: unknown })?.chats) ? (raw as { chats: unknown[] }).chats : []
    for (const item of list) {
      const parsed = parseSummary(item, defaultTier())
      if (!parsed) continue
      const { media, ...summary } = parsed
      entries.set(summary.id, { summary, media })
    }

    let files: Set<string>
    try {
      files = new Set(
        readdirSync(dir)
          .map((f) => /^([a-z0-9]{1,64})\.json$/.exec(f)?.[1])
          .filter((id): id is string => !!id && id !== 'index')
      )
    } catch (err) {
      log.error('cannot list chats directory', err)
      return
    }
    for (const id of [...entries.keys()]) {
      if (!files.has(id)) {
        entries.delete(id)
        indexDirty = true
      }
    }
    for (const id of files) {
      if (entries.has(id)) continue
      const res = readChatFile(id)
      if (res.kind === 'ok') setEntry(res.chat)
    }
    for (const [id, entry] of entries) emitted.set(id, JSON.stringify(entry.summary))
    if (indexDirty) writePending()
  }

  load()

  return {
    list: () => sortedEntries().map((e) => structuredClone(e.summary)),

    get(id) {
      const chat = loadChat(id)
      return chat ? structuredClone(chat) : null
    },

    summary(id) {
      const entry = typeof id === 'string' ? entries.get(id) : undefined
      return entry ? structuredClone(entry.summary) : null
    },

    create(init?: { tier?: Tier; source?: MessageSource; title?: string }) {
      const now = clock()
      const tier = init?.tier
      const chat: Chat = {
        id: newId(),
        title: normalizeTitle(init?.title) || NEW_CHAT_TITLE,
        createdAt: now,
        updatedAt: now,
        tier: isTier(tier) ? tier : defaultTier(),
        source: init?.source === 'voice' ? 'voice' : 'text',
        messageCount: 0,
        preview: '',
        messages: []
      }
      cachePut(chat)
      setEntry(chat)
      dirty.add(chat.id)
      schedule()
      emitSummary(chat.id)
      return structuredClone(chat)
    },

    appendMessage(chatId: string, message: ChatMessage) {
      const chat = loadChat(chatId)
      if (!chat) return log.warn(`appendMessage: chat ${chatId} not found`)
      if (!message || typeof message.id !== 'string' || (message.role !== 'user' && message.role !== 'assistant')) {
        return log.warn('appendMessage: invalid message ignored')
      }
      const copy = structuredClone(message)
      const existing = chat.messages.findIndex((m) => m.id === message.id)
      if (existing >= 0) chat.messages[existing] = copy
      else chat.messages.push(copy)
      chat.updatedAt = Math.max(clock(), chat.updatedAt)
      markChanged(chat)
    },

    updateMessage(chatId: string, messageId: string, patch: Partial<ChatMessage>) {
      const chat = loadChat(chatId)
      const msg = chat?.messages.find((m) => m.id === messageId)
      if (!chat || !msg) return log.debug(`updateMessage: ${chatId}/${messageId} not found`)
      const target = msg as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(structuredClone(patch ?? {}))) {
        if (key === 'id') continue
        if (value === undefined) delete target[key]
        else target[key] = value
      }
      chat.updatedAt = Math.max(clock(), chat.updatedAt)
      markChanged(chat)
    },

    rename(chatId: string, title: string) {
      const chat = loadChat(chatId)
      const next = normalizeTitle(title)
      if (!chat || !next || next === chat.title) return
      chat.title = next
      markChanged(chat)
      emitSummary(chat.id)
    },

    setTier(chatId: string, tier: Tier) {
      const chat = loadChat(chatId)
      if (!chat || !isTier(tier) || chat.tier === tier) return
      chat.tier = tier
      markChanged(chat)
      emitSummary(chat.id)
    },

    remove(chatId: string) {
      const entry = typeof chatId === 'string' ? entries.get(chatId) : undefined
      if (!entry) return
      try {
        rmSync(chatFile(chatId), { force: true })
      } catch (err) {
        log.warn(`failed to delete chat file ${chatId}`, err)
      }
      dropEntry(chatId)
      const referenced = new Set([...entries.values()].flatMap((e) => e.media))
      removeMedia(entry.media.filter((id) => !referenced.has(id)))
    },

    clearAll() {
      const media = [...new Set([...entries.values()].flatMap((e) => e.media))]
      const ids = [...entries.keys()]
      entries.clear()
      cache.clear()
      dirty.clear()
      changedSummaries.clear()
      emitted.clear()
      for (const id of ids) {
        try {
          rmSync(chatFile(id), { force: true })
        } catch (err) {
          log.warn(`failed to delete chat file ${id}`, err)
        }
      }
      indexDirty = true
      if (timer) clearTimeout(timer)
      timer = null
      writePending()
      emit({ type: 'chats-changed' })
      removeMedia(media)
    },

    search(query: string) {
      const matcher = typeof query === 'string' ? createMatcher(query) : null
      if (!matcher) return sortedEntries().map((e) => structuredClone(e.summary))
      const results: ChatSummary[] = []
      for (const entry of sortedEntries()) {
        if (results.length >= MAX_SEARCH_RESULTS) break
        if (matcher.test(entry.summary.title)) {
          results.push(structuredClone(entry.summary))
          continue
        }
        const chat = peekChat(entry.summary.id)
        if (!chat) continue
        const hit = [...chat.messages].reverse().find((m) => matcher.test(m.text))
        if (hit) results.push({ ...structuredClone(entry.summary), preview: snippetAround(hit.text, matcher) })
      }
      return results
    },

    findRecentVoiceChat(maxAgeMs: number) {
      if (!(maxAgeMs > 0)) return null
      let best: Entry | undefined
      for (const entry of entries.values()) {
        if (entry.summary.source !== 'voice') continue
        if (!best || entry.summary.updatedAt > best.summary.updatedAt) best = entry
      }
      if (!best || clock() - best.summary.updatedAt >= maxAgeMs) return null
      const chat = loadChat(best.summary.id)
      return chat ? structuredClone(chat) : null
    },

    flush() {
      if (timer) clearTimeout(timer)
      timer = null
      writePending()
    }
  }
}
