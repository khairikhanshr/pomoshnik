import { useRef } from 'react'
import { Search, Settings, SquarePen, X } from 'lucide-react'
import { Orb } from '../../../common/Orb'
import { S } from '../../../common/strings'
import { useAssistant } from '../../state/assistant'
import { useChats } from '../../state/chats'
import { useUi } from '../../state/ui'
import { IconButton } from '../ui/IconButton'
import { Kbd } from '../ui/Kbd'
import { ChatList } from './ChatList'
import { WakePill } from './WakePill'

function SearchBox(): React.JSX.Element {
  const search = useChats((s) => s.search)
  const setSearch = useChats((s) => s.setSearch)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="sb-search" role="search">
      <Search size={15} className="sb-search-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        id="chat-search"
        className="input"
        type="search"
        placeholder={S.sidebar.search}
        aria-label={S.sidebar.search}
        value={search}
        spellCheck={false}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && search) {
            e.preventDefault()
            setSearch('')
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            document.querySelector<HTMLElement>('.sb-list .sb-item-main')?.focus()
          }
        }}
      />
      {search && (
        <IconButton
          label={S.sidebar.clearSearch}
          size="sm"
          className="sb-search-clear"
          tip={false}
          onClick={() => {
            setSearch('')
            inputRef.current?.focus()
          }}
        >
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const newChat = useChats((s) => s.newChat)
  const openSettings = useUi((s) => s.openSettings)
  const phase = useAssistant((s) => s.state.phase)

  return (
    <aside className="sidebar" aria-label={S.app.name}>
      <div className="sb-head drag">
        <div className="sb-brand">
          <Orb size={26} phase={phase === 'idle' ? 'static' : phase} />
          <span className="sb-wordmark">{S.app.logo}</span>
        </div>
      </div>

      <div className="sb-actions">
        <button type="button" className="btn sb-new" onClick={newChat}>
          <SquarePen size={16} aria-hidden="true" />
          <span className="sb-new-label">{S.sidebar.newChat}</span>
          <Kbd accelerator="CommandOrControl+N" />
        </button>
        <SearchBox />
      </div>

      <ChatList />

      <div className="sb-foot">
        <WakePill />
        <IconButton label={S.sidebar.settings} tip={S.sidebar.settings} onClick={() => openSettings()}>
          <Settings size={18} />
        </IconButton>
      </div>
    </aside>
  )
}
