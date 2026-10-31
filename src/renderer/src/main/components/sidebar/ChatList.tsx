import { useMemo } from 'react'
import { groupChats } from '../../../common/format'
import { S } from '../../../common/strings'
import { useChats } from '../../state/chats'
import { ChatItem } from './ChatItem'

/** Arrow keys move focus between chat rows. */
function onListKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
  const target = e.target as HTMLElement
  if (!target.classList.contains('sb-item-main')) return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('.sb-item-main')]
  const i = items.indexOf(target)
  let next = i
  if (e.key === 'ArrowDown') next = Math.min(items.length - 1, i + 1)
  if (e.key === 'ArrowUp') next = i - 1
  if (e.key === 'Home') next = 0
  if (e.key === 'End') next = items.length - 1
  e.preventDefault()
  if (next < 0) document.getElementById('chat-search')?.focus()
  else items[next]?.focus()
}

export function ChatList(): React.JSX.Element {
  const summaries = useChats((s) => s.summaries)
  const results = useChats((s) => s.searchResults)
  const searching = useChats((s) => s.search.trim().length > 0)
  const currentId = useChats((s) => s.currentId)
  const live = useChats((s) => s.live)

  const streamingIds = useMemo(() => new Set(Object.values(live).map((t) => t.chatId)), [live])
  const groups = useMemo(() => groupChats(summaries), [summaries])

  if (searching) {
    return (
      <nav className="sb-list" aria-label={S.sidebar.groups.results} onKeyDown={onListKeyDown}>
        {results && results.length === 0 && <div className="sb-empty">{S.sidebar.nothingFound}</div>}
        {results && results.length > 0 && (
          <section className="sb-group">
            <div className="sb-group-label">{S.sidebar.groups.results}</div>
            {results.map((chat) => (
              <ChatItem key={chat.id} chat={chat} active={chat.id === currentId} streaming={streamingIds.has(chat.id)} />
            ))}
          </section>
        )}
      </nav>
    )
  }

  if (!summaries.length) {
    return (
      <nav className="sb-list" aria-label={S.sidebar.search}>
        <div className="sb-empty">
          <div className="sb-empty-title">{S.sidebar.emptyTitle}</div>
          {S.sidebar.emptyHint}
        </div>
      </nav>
    )
  }

  return (
    <nav className="sb-list" aria-label={S.sidebar.search} onKeyDown={onListKeyDown}>
      {groups.map((group) => (
        <section key={group.key} className="sb-group" aria-label={S.sidebar.groups[group.key]}>
          <div className="sb-group-label" aria-hidden="true">
            {S.sidebar.groups[group.key]}
          </div>
          {group.chats.map((chat) => (
            <ChatItem key={chat.id} chat={chat} active={chat.id === currentId} streaming={streamingIds.has(chat.id)} />
          ))}
        </section>
      ))}
    </nav>
  )
}
