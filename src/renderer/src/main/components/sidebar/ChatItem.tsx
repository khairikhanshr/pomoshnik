import { memo, useEffect, useRef, useState } from 'react'
import { AudioLines, MessageSquare, Pencil, Trash2 } from 'lucide-react'
import type { ChatSummary } from '@shared/types'
import { formatFullDate, formatListDate } from '../../../common/format'
import { S } from '../../../common/strings'
import { useChats } from '../../state/chats'
import { useUi } from '../../state/ui'
import { IconButton } from '../ui/IconButton'

interface ChatItemProps {
  chat: ChatSummary
  active: boolean
  streaming: boolean
}

export async function confirmDeleteChat(chat: { id: string; title: string }): Promise<void> {
  const ok = await useUi.getState().askConfirm({
    title: S.sidebar.deleteTitle,
    message: S.sidebar.deleteText(chat.title || S.header.untitled),
    confirmText: S.common.delete,
    danger: true
  })
  if (ok) await useChats.getState().remove(chat.id)
}

export const ChatItem = memo(function ChatItem({ chat, active, streaming }: ChatItemProps): React.JSX.Element {
  const openChat = useChats((s) => s.openChat)
  const rename = useChats((s) => s.rename)
  const openMenu = useUi((s) => s.openMenu)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const title = chat.title || S.header.untitled
  const voice = chat.source === 'voice'

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = (value: string): void => {
    setEditing(false)
    void rename(chat.id, value)
  }

  const showMenu = (x: number, y: number): void => {
    openMenu({
      x,
      y,
      items: [
        { label: S.common.rename, icon: <Pencil size={15} />, onSelect: () => setEditing(true) },
        { label: S.common.delete, icon: <Trash2 size={15} />, danger: true, onSelect: () => void confirmDeleteChat(chat) }
      ]
    })
  }

  if (editing) {
    return (
      <div className="sb-item is-editing">
        <input
          ref={inputRef}
          className="input sb-item-rename"
          defaultValue={title}
          aria-label={S.sidebar.renameLabel}
          maxLength={120}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit(e.currentTarget.value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setEditing(false)
            }
          }}
        />
      </div>
    )
  }

  return (
    <div
      className={`sb-item${active ? ' is-active' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        showMenu(e.clientX, e.clientY)
      }}
    >
      <button
        type="button"
        className="sb-item-main"
        aria-current={active ? 'page' : undefined}
        title={`${title}\n${formatFullDate(chat.updatedAt)}`}
        onClick={() => void openChat(chat.id)}
        onKeyDown={(e) => {
          if (e.key === 'F2') {
            e.preventDefault()
            setEditing(true)
          } else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault()
            void confirmDeleteChat(chat)
          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            showMenu(r.left + 24, r.bottom)
          }
        }}
      >
        {voice ? (
          <AudioLines size={15} className="sb-item-icon sb-item-icon--voice" aria-label={S.sidebar.voiceChat} />
        ) : (
          <MessageSquare size={15} className="sb-item-icon" aria-hidden="true" />
        )}
        <span className="sb-item-title">{title}</span>
        {streaming ? <span className="sb-item-streaming" aria-hidden="true" /> : <span className="sb-item-time">{formatListDate(chat.updatedAt)}</span>}
      </button>
      <div className="sb-item-actions">
        <IconButton label={S.common.rename} size="sm" onClick={() => setEditing(true)}>
          <Pencil size={14} />
        </IconButton>
        <IconButton label={S.common.delete} size="sm" tone="danger" onClick={() => void confirmDeleteChat(chat)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    </div>
  )
})
