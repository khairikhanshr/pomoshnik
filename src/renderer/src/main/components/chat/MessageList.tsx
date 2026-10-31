import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { api, errorMessage } from '../../../common/api'
import { S } from '../../../common/strings'
import { useAssistant } from '../../state/assistant'
import { useChats } from '../../state/chats'
import { toast } from '../../state/ui'
import { MessageItem } from './MessageItem'

const STICK_THRESHOLD = 64

interface MessageListProps {
  chatId: string | null
  messages: ChatMessage[]
  hasApiKey: boolean
}

export function MessageList({ chatId, messages, hasApiKey }: MessageListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** Follow new content only while the user is at the bottom. */
  const stick = useRef(true)
  const [showDown, setShowDown] = useState(false)
  const [replayId, setReplayId] = useState<string | null>(null)
  const phase = useAssistant((s) => s.state.phase)
  const retry = useChats((s) => s.retry)

  const toBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  useLayoutEffect(() => {
    stick.current = true
    setShowDown(false)
    toBottom()
  }, [chatId, toBottom])

  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [toBottom])

  // A new user message (sent here or by voice) always brings the view down.
  const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id
  useEffect(() => {
    if (!lastUserId) return
    stick.current = true
    setShowDown(false)
    toBottom()
  }, [lastUserId, toBottom])

  useEffect(() => {
    if (phase !== 'speaking') setReplayId(null)
  }, [phase])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
    stick.current = atBottom
    setShowDown(!atBottom)
  }

  const onSpeak = useCallback((id: string, text: string) => {
    setReplayId(id)
    api.speech.speak(text).catch((err: unknown) => {
      setReplayId(null)
      toast(errorMessage(err) || S.common.unknownError, 'error')
    })
  }, [])

  const onRetry = useCallback((id: string) => void retry(id), [retry])

  return (
    <div className="messages-wrap">
      <div ref={scrollRef} className="messages" onScroll={onScroll} role="log" aria-label={S.messages.listLabel}>
        <div ref={contentRef} className="messages-inner">
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              hasApiKey={hasApiKey}
              speaking={replayId === m.id && phase === 'speaking'}
              onRetry={onRetry}
              onSpeak={onSpeak}
            />
          ))}
        </div>
      </div>
      {showDown && (
        <button
          type="button"
          className="scroll-down"
          aria-label={S.messages.scrollDown}
          title={S.messages.scrollDown}
          onClick={() => {
            stick.current = true
            setShowDown(false)
            toBottom(true)
          }}
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  )
}
