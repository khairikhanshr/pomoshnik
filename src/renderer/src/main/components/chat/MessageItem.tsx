import { memo } from 'react'
import { CircleAlert, Copy, KeyRound, Mic, RotateCcw, Square, Volume2 } from 'lucide-react'
import { TIER_INFO } from '@shared/defaults'
import type { ChatMessage } from '@shared/types'
import { api } from '../../../common/api'
import { formatFullDate, formatTime } from '../../../common/format'
import { Orb } from '../../../common/Orb'
import { S } from '../../../common/strings'
import { copyText } from '../../clipboard'
import { useThrottled } from '../../hooks/useThrottled'
import { useUi } from '../../state/ui'
import { IconButton } from '../ui/IconButton'
import { ImageGrid } from './ImageGrid'
import { Markdown } from './Markdown'
import { ToolChip } from './ToolChip'

interface MessageItemProps {
  message: ChatMessage
  hasApiKey: boolean
  /** This message is being read aloud right now. */
  speaking: boolean
  onRetry(messageId: string): void
  onSpeak(messageId: string, text: string): void
}

function UserMessage({ message }: { message: ChatMessage }): React.JSX.Element {
  return (
    <article className="msg msg--user" aria-label={S.messages.you}>
      <div className="msg-body">
        {message.images?.length ? <ImageGrid images={message.images} align="end" /> : null}
        {message.text && <div className="msg-bubble">{message.text}</div>}
        <div className="msg-actions msg-actions--end">
          {message.source === 'voice' && (
            <span className="msg-voice" title={S.messages.voiceRequest}>
              <Mic size={12} aria-hidden="true" />
              {S.messages.voiceRequest}
            </span>
          )}
          <time className="msg-time" dateTime={new Date(message.createdAt).toISOString()} title={formatFullDate(message.createdAt)}>
            {formatTime(message.createdAt)}
          </time>
          {message.text && (
            <IconButton label={S.messages.copyUser} size="sm" onClick={() => void copyText(message.text)}>
              <Copy size={14} />
            </IconButton>
          )}
        </div>
      </div>
    </article>
  )
}

function AssistantMessage({ message, hasApiKey, speaking, onRetry, onSpeak }: MessageItemProps): React.JSX.Element {
  const streaming = message.status === 'streaming'
  const text = useThrottled(message.text, 50, streaming)
  const calls = message.toolCalls ?? []
  const toolRunning = calls.some((c) => c.status === 'running')
  const openSettings = useUi((s) => s.openSettings)
  const tier = message.tier ? TIER_INFO[message.tier] : undefined

  return (
    <article className={`msg msg--assistant${streaming ? ' is-streaming' : ''}`} aria-label={S.messages.jarvis} aria-busy={streaming}>
      <div className="msg-avatar">
        <Orb size={30} phase={streaming ? (toolRunning ? 'acting' : 'thinking') : 'static'} />
      </div>
      <div className="msg-body">
        <div className="msg-meta">
          <span className="msg-name">{S.messages.jarvis}</span>
          {tier && (
            <span className={`msg-tier msg-tier--${message.tier}`} title={message.model}>
              {tier.label}
            </span>
          )}
          <time className="msg-time" dateTime={new Date(message.createdAt).toISOString()} title={formatFullDate(message.createdAt)}>
            {formatTime(message.createdAt)}
          </time>
        </div>

        {calls.length > 0 && (
          <div className="tool-chips">
            {calls.map((call) => (
              <ToolChip key={call.id} call={call} />
            ))}
          </div>
        )}

        {message.images?.length ? <ImageGrid images={message.images} /> : null}

        {text ? <Markdown text={text} streaming={streaming} /> : null}

        {streaming && !text && !toolRunning && (
          <div className="msg-thinking" role="status">
            <span className="thinking-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {S.messages.thinking}
          </div>
        )}

        {message.status === 'error' && (
          <div className="msg-error" role="alert">
            <CircleAlert size={18} className="msg-error-icon" aria-hidden="true" />
            <div className="msg-error-body">
              <div className="msg-error-title">{S.messages.errorTitle}</div>
              {message.error && <div className="msg-error-text">{message.error}</div>}
            </div>
            <div className="msg-error-actions">
              {!hasApiKey && (
                <button type="button" className="btn btn--sm" onClick={() => openSettings('ai')}>
                  <KeyRound size={14} aria-hidden="true" />
                  {S.composer.noKeyAction}
                </button>
              )}
              <button type="button" className="btn btn--sm" onClick={() => onRetry(message.id)}>
                <RotateCcw size={14} aria-hidden="true" />
                {S.common.retry}
              </button>
            </div>
          </div>
        )}

        {message.status === 'cancelled' && <div className="msg-note">{S.messages.cancelled}</div>}

        {!streaming && message.text && (
          <div className="msg-actions">
            <IconButton label={S.messages.copy} size="sm" onClick={() => void copyText(message.text)}>
              <Copy size={14} />
            </IconButton>
            {speaking ? (
              <IconButton label={S.messages.stopSpeaking} size="sm" active onClick={() => void api.speech.stop()}>
                <Square size={12} fill="currentColor" />
              </IconButton>
            ) : (
              <IconButton label={S.messages.speak} size="sm" onClick={() => onSpeak(message.id, message.text)}>
                <Volume2 size={14} />
              </IconButton>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

export const MessageItem = memo(function MessageItem(props: MessageItemProps): React.JSX.Element {
  return props.message.role === 'user' ? <UserMessage message={props.message} /> : <AssistantMessage {...props} />
})
