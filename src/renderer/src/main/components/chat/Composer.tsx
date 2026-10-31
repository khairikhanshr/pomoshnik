import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Check, LoaderCircle, Mic, MonitorUp, Paperclip, Square, X } from 'lucide-react'
import { formatDuration } from '../../../common/format'
import { S } from '../../../common/strings'
import { useDictation } from '../../hooks/useDictation'
import { useChats } from '../../state/chats'
import { useComposer } from '../../state/composer'
import { useLoadedSettings } from '../../state/settings'
import { useUi } from '../../state/ui'
import { IconButton } from '../ui/IconButton'

const MAX_HEIGHT = 220
/** Per-bar height factors so the dictation meter looks like a waveform. */
const BAR_K = [0.55, 0.8, 1, 0.7, 0.9, 0.6, 1, 0.75, 0.5, 0.85, 0.65, 0.95]

function useTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [enabled])
  return now
}

export function Composer({ streaming, chatId }: { streaming: boolean; chatId: string | null }): React.JSX.Element {
  const settings = useLoadedSettings()
  const send = useChats((s) => s.send)
  const cancel = useChats((s) => s.cancel)
  const sending = useChats((s) => s.sending)
  const attachments = useComposer((s) => s.attachments)
  const pending = useComposer((s) => s.pending)
  const capturing = useComposer((s) => s.capturing)
  const composer = useComposer.getState
  const focusTick = useUi((s) => s.composerFocus)

  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const levelRef = useRef<HTMLDivElement>(null)

  const insertText = (spoken: string): void => {
    const ta = taRef.current
    setText((prev) => {
      if (!ta || document.activeElement !== ta) return prev ? `${prev.replace(/\s+$/, '')} ${spoken}` : spoken
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = prev.slice(0, start)
      const after = prev.slice(end)
      const pad = before && !/\s$/.test(before) ? ' ' : ''
      return `${before}${pad}${spoken}${after}`
    })
    ta?.focus()
  }

  const dictation = useDictation(settings.micDeviceId, insertText, levelRef)
  const now = useTicker(dictation.state === 'recording')
  const recording = dictation.state === 'recording' || dictation.state === 'starting'

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT)}px`
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [text])

  useEffect(() => {
    taRef.current?.focus()
  }, [focusTick, chatId])

  const hasKey = settings.hasApiKey
  const canSend = hasKey && !sending && pending === 0 && !recording && dictation.state !== 'transcribing' && (text.trim().length > 0 || attachments.length > 0)

  const submit = async (): Promise<void> => {
    if (!canSend || streaming) return
    const body = text.trim()
    const images = attachments
    setText('')
    composer().clear()
    const ok = await send(body, images)
    if (!ok) {
      setText((t) => t || body)
      images.forEach((img) => composer().add(img))
    }
    taRef.current?.focus()
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    void composer().importFiles(files)
  }

  return (
    <div className="composer-wrap">
      <div className={`composer${recording ? ' is-recording' : ''}${!hasKey ? ' is-locked' : ''}`}>
        {(attachments.length > 0 || pending > 0) && (
          <div className="composer-attachments">
            {attachments.map((img) => (
              <div key={img.id} className="att">
                <img src={img.url} alt={img.kind === 'screenshot' ? S.images.screenshot : S.images.upload} draggable={false} />
                <button type="button" className="att-remove" aria-label={S.composer.removeAttachment} title={S.composer.removeAttachment} onClick={() => composer().remove(img.id)}>
                  <X size={12} strokeWidth={2.6} />
                </button>
              </div>
            ))}
            {pending > 0 && (
              <div className="att att--pending" aria-label={capturing ? S.composer.capturing : S.composer.attach}>
                <LoaderCircle size={18} className="spin" aria-hidden="true" />
              </div>
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={hasKey ? S.composer.placeholder : S.composer.placeholderNoKey}
          aria-label={S.composer.placeholder}
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />

        <div className="composer-bar">
          {recording ? (
            <div className="dictation" role="status">
              <span className="dictation-dot" aria-hidden="true" />
              <span className="dictation-label">{S.composer.recording}</span>
              <span className="dictation-time">{formatDuration(dictation.state === 'recording' ? now - dictation.startedAt : 0)}</span>
              <div ref={levelRef} className="dictation-level" aria-hidden="true">
                {BAR_K.map((k, i) => (
                  <i key={i} style={{ '--k': k } as React.CSSProperties} />
                ))}
              </div>
              <div className="dictation-actions">
                <IconButton label={S.composer.dictateCancel} size="sm" onClick={dictation.cancel}>
                  <X size={15} />
                </IconButton>
                <button type="button" className="btn btn--sm btn--primary" onClick={dictation.stop} disabled={dictation.state !== 'recording'}>
                  <Check size={14} aria-hidden="true" />
                  {S.composer.dictateStop}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="composer-tools">
                <IconButton label={S.composer.attach} onClick={() => void composer().pick()}>
                  <Paperclip size={17} />
                </IconButton>
                <button
                  type="button"
                  className="composer-chip"
                  onClick={() => void composer().capture()}
                  disabled={capturing}
                  title={S.composer.screenshotTitle}
                  aria-label={S.composer.screenshotTitle}
                >
                  {capturing ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <MonitorUp size={15} aria-hidden="true" />}
                  {capturing ? S.composer.capturing : S.composer.screenshot}
                </button>
                {dictation.state === 'transcribing' ? (
                  <span className="composer-status" role="status">
                    <LoaderCircle size={14} className="spin" aria-hidden="true" />
                    {S.composer.transcribing}
                  </span>
                ) : (
                  <IconButton label={S.composer.dictate} disabled={!hasKey} onClick={() => void dictation.start()}>
                    <Mic size={17} />
                  </IconButton>
                )}
              </div>
              <span className="composer-hint" aria-hidden="true">
                {S.composer.hint}
              </span>
              {streaming ? (
                <button type="button" className="send-btn send-btn--stop" aria-label={S.composer.stop} title={S.composer.stop} onClick={() => void cancel()}>
                  <Square size={13} fill="currentColor" strokeWidth={0} />
                </button>
              ) : (
                <button type="button" className="send-btn" aria-label={S.composer.send} title={S.composer.send} disabled={!canSend} onClick={() => void submit()}>
                  {sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} strokeWidth={2.4} />}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
