import { useState } from 'react'
import { X } from 'lucide-react'
import type { Platform } from '@shared/types'
import { acceleratorFromKey, acceleratorParts } from '../../../common/format'
import { S } from '../../../common/strings'

const T = S.settings.activation

/** Click, then press a combination; Esc cancels, Backspace clears. Produces an Electron accelerator. */
export function HotkeyInput({ value, onChange, platform, label }: { value: string; onChange(v: string): void; platform: Platform; label: string }): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const parts = acceleratorParts(value, platform)

  return (
    <div className="hotkey">
      <button
        type="button"
        className={`hotkey-btn${recording ? ' is-recording' : ''}`}
        aria-label={`${label}: ${parts.join(' ') || T.hotkeyNone}. ${T.hotkeyEdit}`}
        data-hotkey-recording={recording ? '' : undefined}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return
          e.preventDefault()
          e.stopPropagation()
          const r = acceleratorFromKey(e, platform)
          if (r.kind === 'cancel') setRecording(false)
          else if (r.kind === 'clear') {
            onChange('')
            setRecording(false)
          } else if (r.kind === 'done') {
            onChange(r.accelerator)
            setRecording(false)
          }
        }}
      >
        {recording ? (
          <span className="hotkey-prompt">{T.hotkeyRecord}</span>
        ) : parts.length ? (
          <span className="kbd-group">
            {parts.map((p, i) => (
              <kbd key={`${p}-${i}`}>{p}</kbd>
            ))}
          </span>
        ) : (
          <span className="hotkey-none">{T.hotkeyNone}</span>
        )}
      </button>
      {recording ? (
        <span className="hotkey-hint">{T.hotkeyHint}</span>
      ) : (
        value && (
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`${T.hotkeyClear}: ${label}`} title={T.hotkeyClear} onClick={() => onChange('')}>
            <X size={14} />
          </button>
        )
      )}
    </div>
  )
}
