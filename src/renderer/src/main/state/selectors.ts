import { useMemo } from 'react'
import type { Chat, ChatMessage, ChatSummary, Tier } from '@shared/types'
import { activeTurn, liveMessages, type LiveTurn } from './chat-reducer'
import { useChats } from './chats'
import { useSettings } from './settings'

export interface CurrentChat {
  currentId: string | null
  chat: Chat | undefined
  summary: ChatSummary | undefined
  messages: ChatMessage[]
  turn: LiveTurn | undefined
  loading: boolean
  loadError: string | null
}

export function useCurrentChat(): CurrentChat {
  const currentId = useChats((s) => s.currentId)
  const chat = useChats((s) => (s.currentId ? s.chats[s.currentId] : undefined))
  const summary = useChats((s) => (s.currentId ? s.summaries.find((c) => c.id === s.currentId) : undefined))
  const live = useChats((s) => s.live)
  const loading = useChats((s) => (s.currentId ? !!s.loading[s.currentId] : false))
  const loadError = useChats((s) => s.loadError)

  const messages = useMemo(
    () => chat?.messages ?? (currentId ? liveMessages(live, currentId) : []),
    [chat, live, currentId]
  )
  const turn = useMemo(() => activeTurn(live, currentId), [live, currentId])
  return { currentId, chat, summary, messages, turn, loading, loadError }
}

/** Tier shown in the header: the chat's tier, the draft pick, or the default tier. */
export function useCurrentTier(): Tier {
  const chatTier = useChats((s) =>
    s.currentId ? (s.chats[s.currentId]?.tier ?? s.summaries.find((c) => c.id === s.currentId)?.tier) : undefined
  )
  const draftTier = useChats((s) => s.draftTier)
  const currentId = useChats((s) => s.currentId)
  const defaultTier = useSettings((s) => s.settings?.defaultTier ?? 'terra')
  return (currentId ? chatTier : draftTier) ?? defaultTier
}
