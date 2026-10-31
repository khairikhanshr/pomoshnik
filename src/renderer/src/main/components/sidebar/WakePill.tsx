import { useState } from 'react'
import { Mic, MicOff, TriangleAlert } from 'lucide-react'
import { api, errorMessage } from '../../../common/api'
import { capitalize } from '../../../common/format'
import { S } from '../../../common/strings'
import { useAssistant } from '../../state/assistant'
import { useLoadedSettings } from '../../state/settings'
import { toast } from '../../state/ui'
import { Tooltip } from '../ui/Tooltip'

export type WakeMode = 'on' | 'off' | 'starting' | 'error'

export function useWakeMode(): { mode: WakeMode; enabled: boolean; phrase: string; engineError?: string } {
  const settings = useLoadedSettings()
  const wakeActive = useAssistant((s) => s.state.wakeActive)
  const engineError = useAssistant((s) => s.state.engineError)
  const enabled = settings.wakeEngine !== 'off'
  const phrase = capitalize(settings.wakePhrases[0] ?? 'джарвис')
  const mode: WakeMode = !enabled ? 'off' : engineError ? 'error' : wakeActive ? 'on' : 'starting'
  return { mode, enabled, phrase, engineError }
}

export function WakePill(): React.JSX.Element {
  const { mode, enabled, phrase, engineError } = useWakeMode()
  const [busy, setBusy] = useState(false)

  const text =
    mode === 'on'
      ? S.sidebar.wakeOn(phrase)
      : mode === 'off'
        ? S.sidebar.wakeOff
        : mode === 'error'
          ? S.sidebar.wakeFailed
          : S.sidebar.wakeStarting

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.assistant.setWakeEnabled(!enabled)
    } catch (err) {
      toast(errorMessage(err) || S.common.unknownError, 'error')
    } finally {
      setBusy(false)
    }
  }

  const tip = (
    <>
      <div className="tooltip-title">{enabled ? S.sidebar.wakeTurnOff : S.sidebar.wakeTurnOn}</div>
      {mode === 'error' && engineError && <div className="tooltip-sub">{engineError}</div>}
    </>
  )

  const Icon = mode === 'off' ? MicOff : mode === 'error' ? TriangleAlert : Mic

  return (
    <Tooltip content={tip} placement="top">
      <button
        type="button"
        className={`wake-pill wake-pill--${mode}`}
        role="switch"
        aria-checked={enabled}
        aria-label={`${text}. ${enabled ? S.sidebar.wakeTurnOff : S.sidebar.wakeTurnOn}`}
        disabled={busy}
        onClick={() => void toggle()}
      >
        <span className="wake-pill-dot" aria-hidden="true" />
        <span className="wake-pill-text">{text}</span>
        <Icon size={15} aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
