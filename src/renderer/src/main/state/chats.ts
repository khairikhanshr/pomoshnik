import { create } from 'zustand'
import type { Chat, ChatEvent, ChatMessage, ChatSummary, ImageRef, Tier } from '@shared/types'
import { api, errorMessage } from '../../common/api'
import { S } from '../../common/strings'
import { activeTurn, applyChatEvent, EMPTY_CHAT_DATA, mergeSnapshot, pruneChats, type ChatData } from './chat-reducer'
import { toast, useUi } from './ui'

interface ChatStore extends ChatData {
  /** null = a new, not yet created chat (draft). */
  currentId: string | null
  /** Tier picked in the header while in a draft; null = settings.defaultTier. */
  draftTier: Tier | null
  loading: Record<string, boolean>
  loadError: string | null
  search: string
  searchResults: ChatSummary[] | null
  sending: boolean

  refreshList(): Promise<void>
  openChat(id: string | null): Promise<void>
  loadChat(id: string): Promise<void>
  newChat(): void
  send(text: string, images: ImageRef[]): Promise<boolean>
  cancel(): Promise<void>
  retry(assistantMessageId: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  remove(id: string): Promise<void>
  setTier(tier: Tier): Promise<void>
  setSearch(query: string): void
  applyEvent(ev: ChatEvent): void
}

const SEARCH_DEBOUNCE_MS = 180
let searchTimer = 0
let searchSeq = 0
let listTimer = 0

export const useChats = create<ChatStore>((set, get) => {
  const runSearch = (query: string): void => {
    window.clearTimeout(searchTimer)
    const q = query.trim()
    if (!q) {
      set({ searchResults: null })
      return
    }
    const seq = ++searchSeq
    searchTimer = window.setTimeout(() => {
      api.chats
        .search(q)
        .then((results) => {
          if (seq === searchSeq) set({ searchResults: results })
        })
        .catch(() => {
          if (seq === searchSeq) set({ searchResults: [] })
        })
    }, SEARCH_DEBOUNCE_MS)
  }

  const scheduleListRefresh = (): void => {
    window.clearTimeout(listTimer)
    listTimer = window.setTimeout(() => void get().refreshList(), 120)
  }

  const patchChat = (id: string, patch: Partial<Chat>): void => {
    const s = get()
    const chat = s.chats[id]
    set({
      summaries: s.summaries.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      chats: chat ? { ...s.chats, [id]: { ...chat, ...patch } } : s.chats
    })
  }

  return {
    ...EMPTY_CHAT_DATA,
    currentId: null,
    draftTier: null,
    loading: {},
    loadError: null,
    search: '',
    searchResults: null,
    sending: false,

    async refreshList() {
      const summaries = await api.chats.list()
      const s = get()
      const current = s.currentId ? s.chats[s.currentId] : undefined
      const pruned = pruneChats(s, summaries)
      const keepCurrent = !!s.currentId && (summaries.some((c) => c.id === s.currentId) || !!activeTurn(s.live, s.currentId))
      set({
        summaries: pruned.summaries,
        chats: keepCurrent && current && s.currentId ? { ...pruned.chats, [s.currentId]: current } : pruned.chats,
        currentId: keepCurrent ? s.currentId : null
      })
      if (s.search.trim()) runSearch(s.search)
    },

    async openChat(id) {
      useUi.getState().openChatView()
      set({ currentId: id, loadError: null })
      if (id && !get().chats[id]) await get().loadChat(id)
    },

    async loadChat(id) {
      set({ loading: { ...get().loading, [id]: true } })
      try {
        const chat = await api.chats.get(id)
        if (!chat) {
          if (get().currentId === id && !activeTurn(get().live, id)) set({ currentId: null })
          return
        }
        set({ chats: { ...get().chats, [id]: mergeSnapshot(chat, get().live) }, loadError: null })
      } catch (err) {
        if (get().currentId === id) set({ loadError: errorMessage(err) || S.messages.loadFailed })
      } finally {
        const loading = { ...get().loading }
        delete loading[id]
        set({ loading })
      }
    },

    newChat() {
      useUi.getState().openChatView()
      set({ currentId: null, draftTier: null, loadError: null })
      useUi.getState().focusComposer()
    },

    async send(text, images) {
      const { currentId, draftTier } = get()
      set({ sending: true })
      try {
        const res = await api.chats.send({
          chatId: currentId ?? undefined,
          text,
          images: images.length ? images.map((i) => i.id) : undefined,
          tier: currentId ? undefined : (draftTier ?? undefined)
        })
        if (!currentId && get().currentId === null) {
          set({ currentId: res.chatId, draftTier: null })
          if (!get().chats[res.chatId]) void get().loadChat(res.chatId)
        }
        return true
      } catch (err) {
        toast(errorMessage(err) || S.composer.sendFailed, 'error')
        return false
      } finally {
        set({ sending: false })
      }
    },

    async cancel() {
      const turn = activeTurn(get().live, get().currentId)
      try {
        await api.chats.cancel(turn?.turnId)
      } catch (err) {
        toast(errorMessage(err) || S.common.unknownError, 'error')
      }
    },

    async retry(assistantMessageId) {
      const { currentId, chats } = get()
      const chat = currentId ? chats[currentId] : undefined
      if (!chat) return
      const index = chat.messages.findIndex((m) => m.id === assistantMessageId)
      let user: ChatMessage | undefined
      for (let i = index - 1; i >= 0; i--) {
        if (chat.messages[i].role === 'user') {
          user = chat.messages[i]
          break
        }
      }
      if (user) await get().send(user.text, user.images ?? [])
    },

    async rename(id, title) {
      const clean = title.trim()
      const before = get().summaries.find((c) => c.id === id)?.title ?? get().chats[id]?.title
      if (!clean || clean === before) return
      patchChat(id, { title: clean })
      try {
        await api.chats.rename(id, clean)
      } catch (err) {
        if (before !== undefined) patchChat(id, { title: before })
        toast(errorMessage(err) || S.common.unknownError, 'error')
      }
    },

    async remove(id) {
      try {
        await api.chats.remove(id)
      } catch (err) {
        toast(errorMessage(err) || S.common.unknownError, 'error')
        return
      }
      const s = get()
      const chats = { ...s.chats }
      delete chats[id]
      set({
        chats,
        summaries: s.summaries.filter((c) => c.id !== id),
        searchResults: s.searchResults?.filter((c) => c.id !== id) ?? null,
        currentId: s.currentId === id ? null : s.currentId
      })
      toast(S.sidebar.deleted, 'success')
    },

    async setTier(tier) {
      const { currentId, chats, summaries } = get()
      if (!currentId) {
        set({ draftTier: tier })
        return
      }
      const before = chats[currentId]?.tier ?? summaries.find((c) => c.id === currentId)?.tier
      if (before === tier) return
      patchChat(currentId, { tier })
      try {
        await api.chats.setTier(currentId, tier)
      } catch (err) {
        if (before) patchChat(currentId, { tier: before })
        toast(errorMessage(err) || S.common.unknownError, 'error')
      }
    },

    setSearch(query) {
      set({ search: query })
      runSearch(query)
    },

    applyEvent(ev) {
      const s = get()
      const next = applyChatEvent(s, ev)
      const patch: Partial<ChatStore> = { summaries: next.summaries, chats: next.chats, live: next.live }
      if (ev.type === 'turn-start') {
        if (!s.summaries.some((c) => c.id === ev.chatId)) scheduleListRefresh()
        // Follow a voice conversation when the window sits on an empty new chat.
        if (s.currentId === null && ev.userMessage.source === 'voice' && useUi.getState().view === 'chat') {
          patch.currentId = ev.chatId
        }
      }
      set(patch)
      if (ev.type === 'chats-changed') scheduleListRefresh()
      if (ev.type === 'chat-updated' && s.search.trim()) runSearch(s.search)
      if (patch.currentId && !next.chats[patch.currentId]) void get().loadChat(patch.currentId)
    }
  }
})
