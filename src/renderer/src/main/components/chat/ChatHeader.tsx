import { useEffect, useRef, useState } from 'react'
import { Pencil, Volume2, VolumeX } from 'lucide-react'
import type { SpeakMode } from '@shared/types'
import { S } from '../../../common/strings'
import { useChats } from '../../state/chats'
import { useCurrentTier } from '../../state/selectors'
import { useLoadedSettings, useSettings } from '../../state/settings'
import { IconButton } from '../ui/IconButton'
import { TierSwitch } from './TierSwitch'

function TitleEditor({ chatId, title }: { chatId: string | null; title: string }): React.JSX.Element {
  const rename = useChats((s) => s.rename)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setEditing(false), [chatId])
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  if (!chatId) return <h1 className="chat-title chat-title--static">{S.header.untitled}</h1>

  if (editing) {
    const commit = (value: string): void => {
      setEditing(false)
      void rename(chatId, value)
    }
    return (
      <input
        ref={inputRef}
        className="input chat-title-input"
        defaultValue={title}
        maxLength={120}
        aria-label={S.header.titleInput}
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
    )
  }

  return (
    <h1 className="chat-title">
      <button type="button" className="chat-title-btn" title={S.header.editTitle} onClick={() => setEditing(true)}>
        <span className="chat-title-text">{title || S.header.untitled}</span>
        <Pencil size={13} className="chat-title-pen" aria-hidden="true" />
      </button>
    </h1>
  )
}

/** Toggles settings.speakMode between 'always' and the previous non-always mode. */
function SpeakToggle(): React.JSX.Element {
  const speakMode = useLoadedSettings().speakMode
  const update = useSettings((s) => s.update)
  const lastQuiet = useRef<SpeakMode>(speakMode === 'always' ? 'voice' : speakMode)
  if (speakMode !== 'always') lastQuiet.current = speakMode
  const on = speakMode === 'always'
  const label = on ? S.header.speakOn : S.header.speakOff
  return (
    <IconButton label={label} active={on} onClick={() => void update({ speakMode: on ? lastQuiet.current : 'always' })}>
      {on ? <Volume2 size={18} /> : <VolumeX size={18} />}
    </IconButton>
  )
}

export function ChatHeader({ chatId, title }: { chatId: string | null; title: string }): React.JSX.Element {
  const settings = useLoadedSettings()
  const tier = useCurrentTier()
  const setTier = useChats((s) => s.setTier)

  return (
    <header className="chat-header drag">
      <div className="chat-header-title">
        <TitleEditor chatId={chatId} title={title} />
      </div>
      <div className="chat-header-tools">
        <TierSwitch value={tier} resolved={settings.resolvedModels} onChange={(t) => void setTier(t)} />
        <span className="chat-header-sep" aria-hidden="true" />
        <SpeakToggle />
      </div>
    </header>
  )
}
