import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AssistantState, NavigateRequest, PublicSettings } from '@shared/types'
import { api } from '../common/api'
import { Orb } from '../common/Orb'
import { S } from '../common/strings'
import { capitalize } from '../common/format'
import { markdownToPlain } from '../common/plain-text'

function useAssistantState(): AssistantState | null {
  const [state, setState] = useState<AssistantState | null>(null)
  useEffect(() => {
    let alive = true
    const off = api.assistant.onState((s) => setState(s))
    api.assistant
      .getState()
      .then((s) => alive && setState((prev) => (prev && prev.updatedAt > s.updatedAt ? prev : s)))
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

function useSettings(): PublicSettings | null {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  useEffect(() => {
    let alive = true
    const off = api.settings.onChanged((s) => setSettings(s))
    api.settings
      .get()
      .then((s) => alive && setSettings((prev) => prev ?? s))
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [])
  return settings
}

function statusLabel(state: AssistantState | null, settings: PublicSettings | null): string {
  const phase = state?.phase ?? 'idle'
  switch (phase) {
    case 'acting':
      return state?.toolTitle || S.overlay.phase.acting
    case 'wake':
      return S.overlay.wakeAck(settings?.userTitle ?? '')
    case 'idle': {
      if (state?.response) return S.overlay.done
      const phrase = settings?.wakePhrases[0]
      return state?.wakeActive && phrase ? S.overlay.wakeHint(capitalize(phrase)) : S.overlay.phase.idle
    }
    default:
      return S.overlay.phase[phase]
  }
}

/** Clicking the HUD opens the conversation; an error caused by the missing API key opens Settings → ИИ. */
function overlayTarget(state: AssistantState | null, settings: PublicSettings | null): NavigateRequest {
  if (state?.phase === 'error' && settings && !settings.hasApiKey) return { view: 'settings', settingsTab: 'ai' }
  return state?.chatId ? { view: 'chat', chatId: state.chatId } : { view: 'chat' }
}

export function Overlay(): React.JSX.Element {
  const state = useAssistantState()
  const settings = useSettings()
  const replyRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  const phase = state?.phase ?? 'idle'
  const transcript = state?.transcript?.trim() ?? ''
  const error = phase === 'error' ? state?.error || state?.engineError || S.common.unknownError : ''
  const reply = error ? '' : markdownToPlain(state?.response ?? '')
  const position = settings?.overlayPosition ?? 'top-right'

  useEffect(() => {
    // The tail is pinned with flex-end, so overflow goes upwards and is not part of scrollHeight.
    const el = replyRef.current
    const text = el?.firstElementChild as HTMLElement | null
    setOverflowing(!!el && !!text && text.offsetHeight > el.clientHeight + 1)
  }, [reply])

  const open = (): void => {
    void api.app.showMain(overlayTarget(state, settings))
  }

  const close = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void api.app.hideOverlay()
  }

  return (
    <div className={`ov-stage ov-stage--${position.startsWith('bottom') ? 'bottom' : 'top'}`}>
      <section
        className={`ov-panel ov-panel--${phase}`}
        role="button"
        tabIndex={0}
        aria-label={`${S.overlay.label}. ${S.overlay.open}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') open()
        }}
      >
        <span className="ov-corner ov-corner--tl" aria-hidden="true" />
        <span className="ov-corner ov-corner--br" aria-hidden="true" />

        <div className="ov-head">
          <div className="ov-orb">
            <Orb size={64} phase={phase} reactive />
          </div>
          <div className="ov-meta">
            <div className="ov-status" aria-live="polite">
              <span className="ov-status-dot" aria-hidden="true" />
              <span className="ov-status-text">{statusLabel(state, settings)}</span>
            </div>
            {transcript ? (
              <div className="ov-transcript" title={transcript}>
                «{transcript}»
              </div>
            ) : (
              <div className="ov-transcript ov-transcript--muted">{S.app.logo}</div>
            )}
          </div>
          <button type="button" className="ov-close" aria-label={S.overlay.close} title={S.overlay.close} onClick={close}>
            <X size={14} strokeWidth={2.2} />
          </button>
        </div>

        {(reply || error) && (
          <div
            ref={replyRef}
            className={`ov-reply${overflowing ? ' ov-reply--fade' : ''}${error ? ' ov-reply--error' : ''}`}
            aria-live="polite"
          >
            <p>{error || reply}</p>
          </div>
        )}
      </section>
    </div>
  )
}
