import { useRef, useState } from 'react'
import { AudioLines, ImagePlus, LoaderCircle, RotateCcw, Square } from 'lucide-react'
import { api } from '../../../common/api'
import { S } from '../../../common/strings'
import { useAssistant } from '../../state/assistant'
import { useChats } from '../../state/chats'
import { useComposer } from '../../state/composer'
import { useCurrentChat } from '../../state/selectors'
import { useLoadedSettings } from '../../state/settings'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { EmptyState } from './EmptyState'
import { MessageList } from './MessageList'
import { Onboarding } from './Onboarding'

function hasFiles(e: React.DragEvent): boolean {
  return [...e.dataTransfer.types].includes('Files')
}

function SpeakingBar(): React.JSX.Element | null {
  const phase = useAssistant((s) => s.state.phase)
  if (phase !== 'speaking') return null
  return (
    <div className="speaking-bar" role="status">
      <AudioLines size={15} className="speaking-bar-icon" aria-hidden="true" />
      <span>{S.messages.speakingNow}</span>
      <button type="button" className="speaking-bar-stop" onClick={() => void api.speech.stop()}>
        <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
        {S.messages.stopSpeaking}
      </button>
    </div>
  )
}

export function ChatView(): React.JSX.Element {
  const settings = useLoadedSettings()
  const { currentId, chat, summary, messages, turn, loading, loadError } = useCurrentChat()
  const send = useChats((s) => s.send)
  const loadChat = useChats((s) => s.loadChat)
  const importFiles = useComposer((s) => s.importFiles)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  const title = chat?.title ?? summary?.title ?? S.header.untitled
  const empty = messages.length === 0
  const onboarding = empty && !settings.hasApiKey && !loading

  let body: React.ReactNode
  if (loadError && currentId && !chat) {
    body = (
      <div className="empty">
        <div className="load-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn btn--sm" onClick={() => void loadChat(currentId)}>
            <RotateCcw size={14} aria-hidden="true" />
            {S.common.retry}
          </button>
        </div>
      </div>
    )
  } else if (loading && empty) {
    body = (
      <div className="empty">
        <LoaderCircle size={22} className="spin empty-loader" aria-label={S.app.loading} />
      </div>
    )
  } else if (onboarding) {
    body = <Onboarding />
  } else if (empty) {
    body = <EmptyState onExample={(text) => void send(text, [])} />
  } else {
    body = <MessageList chatId={currentId} messages={messages} hasApiKey={settings.hasApiKey} />
  }

  return (
    <main
      className="main"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        void importFiles([...e.dataTransfer.files])
      }}
    >
      <ChatHeader chatId={currentId} title={title} />
      {body}
      <SpeakingBar />
      {!onboarding && <Composer streaming={!!turn} chatId={currentId} />}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">
            <ImagePlus size={28} />
            <span>{S.composer.dropHere}</span>
          </div>
        </div>
      )}
    </main>
  )
}
