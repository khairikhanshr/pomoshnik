import { useRef } from 'react'
import { Power, RotateCcw, Trash2 } from 'lucide-react'
import type { OverlayPosition } from '@shared/types'
import { api, errorMessage } from '../../../common/api'
import { S } from '../../../common/strings'
import { useChats } from '../../state/chats'
import { useLoadedSettings, useSettings } from '../../state/settings'
import { toast, useUi } from '../../state/ui'
import { Row, Section, ToggleRow } from './controls'

const T = S.settings.general
const POSITIONS: OverlayPosition[] = ['top-right', 'top-center', 'bottom-center', 'bottom-right']

/** Four mini screens showing where the overlay appears. */
function PositionPicker({ value, onChange, disabled }: { value: OverlayPosition; onChange(v: OverlayPosition): void; disabled?: boolean }): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const i = POSITIONS.indexOf(value)
    const next = e.key === 'ArrowRight' ? (i + 1) % 4 : e.key === 'ArrowLeft' ? (i + 3) % 4 : -1
    if (next < 0) return
    e.preventDefault()
    onChange(POSITIONS[next])
    refs.current[next]?.focus()
  }
  return (
    <div className={`pos-picker${disabled ? ' is-disabled' : ''}`} role="radiogroup" aria-label={T.overlayPosition} onKeyDown={onKeyDown}>
      {POSITIONS.map((p, i) => {
        const checked = p === value
        return (
          <button
            key={p}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className={`pos-option${checked ? ' is-checked' : ''}`}
            onClick={() => onChange(p)}
          >
            <span className={`pos-screen pos-screen--${p}`} aria-hidden="true">
              <i />
            </span>
            <span className="pos-label">{T.positions[p]}</span>
          </button>
        )
      })}
    </div>
  )
}

export function GeneralTab(): React.JSX.Element {
  const s = useLoadedSettings()
  const update = useSettings((st) => st.update)
  const apply = useSettings((st) => st.apply)
  const askConfirm = useUi((st) => st.askConfirm)

  const clearHistory = async (): Promise<void> => {
    const ok = await askConfirm({ title: T.clearHistoryConfirmTitle, message: T.clearHistoryConfirmText, confirmText: T.clearHistory, danger: true })
    if (!ok) return
    try {
      await api.chats.clearAll()
      useChats.getState().newChat()
      await useChats.getState().refreshList()
      useUi.getState().openSettings()
      toast(T.clearHistoryDone, 'success')
    } catch (err) {
      toast(errorMessage(err) || S.common.unknownError, 'error')
    }
  }

  const resetSettings = async (): Promise<void> => {
    const ok = await askConfirm({ title: T.resetConfirmTitle, message: T.resetConfirmText, confirmText: T.resetSettings, danger: true })
    if (!ok) return
    try {
      apply(await api.settings.reset())
      toast(T.resetDone, 'success')
    } catch (err) {
      toast(errorMessage(err) || S.common.unknownError, 'error')
    }
  }

  return (
    <>
      <Section title={T.startupSection}>
        <ToggleRow label={T.launchAtLogin} description={T.launchAtLoginDesc} checked={s.launchAtLogin} onChange={(launchAtLogin) => void update({ launchAtLogin })} />
        <ToggleRow label={T.startHidden} description={T.startHiddenDesc} checked={s.startHidden} onChange={(startHidden) => void update({ startHidden })} />
        {s.platform === 'darwin' && (
          <ToggleRow label={T.showInDock} description={T.showInDockDesc} checked={s.showInDock} onChange={(showInDock) => void update({ showInDock })} />
        )}
      </Section>

      <Section title={T.overlaySection}>
        <ToggleRow label={T.overlay} description={T.overlayDesc} checked={s.showOverlay} onChange={(showOverlay) => void update({ showOverlay })} />
        <Row label={T.overlayPosition} stacked disabled={!s.showOverlay}>
          <PositionPicker value={s.overlayPosition} disabled={!s.showOverlay} onChange={(overlayPosition) => void update({ overlayPosition })} />
        </Row>
      </Section>

      <Section title={T.dataSection}>
        <Row label={T.clearHistory} description={T.clearHistoryDesc}>
          <button type="button" className="btn btn--danger" onClick={() => void clearHistory()}>
            <Trash2 size={14} aria-hidden="true" />
            {T.clearHistory}
          </button>
        </Row>
        <Row label={T.resetSettings} description={T.resetSettingsDesc}>
          <button type="button" className="btn btn--danger" onClick={() => void resetSettings()}>
            <RotateCcw size={14} aria-hidden="true" />
            {T.resetSettings}
          </button>
        </Row>
        <Row label={T.quit} description={T.quitDesc}>
          <button type="button" className="btn" onClick={() => void api.app.quit()}>
            <Power size={14} aria-hidden="true" />
            {T.quit}
          </button>
        </Row>
      </Section>
    </>
  )
}
