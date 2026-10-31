import { useCallback, useEffect, useState } from 'react'
import { Accessibility, CircleCheck, ExternalLink, Info, LoaderCircle, Mic, MonitorUp, RefreshCw, ShieldAlert } from 'lucide-react'
import type { PermissionKind, PermissionsStatus } from '@shared/types'
import { api, errorMessage } from '../../../common/api'
import { S } from '../../../common/strings'
import { useLoadedSettings, useSettings } from '../../state/settings'
import { toast } from '../../state/ui'
import { Callout, Section, ToggleRow } from './controls'

const T = S.settings.computer
const KINDS: PermissionKind[] = ['microphone', 'screen', 'accessibility']
const ICONS: Record<PermissionKind, React.ReactNode> = {
  microphone: <Mic size={17} />,
  screen: <MonitorUp size={17} />,
  accessibility: <Accessibility size={17} />
}

function usePermissions(): [PermissionsStatus | null, () => void, (s: PermissionsStatus) => void] {
  const [status, setStatus] = useState<PermissionsStatus | null>(null)
  const refresh = useCallback(() => {
    api.app
      .getPermissions()
      .then(setStatus)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    refresh()
    // The user usually comes back from System Settings: re-check when the window regains focus.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  return [status, refresh, setStatus]
}

function PermissionRows(): React.JSX.Element {
  const [status, refresh, setStatus] = usePermissions()
  const [busy, setBusy] = useState<PermissionKind | null>(null)

  const request = async (kind: PermissionKind): Promise<void> => {
    setBusy(kind)
    try {
      setStatus(await api.app.requestPermission(kind))
    } catch (err) {
      toast(errorMessage(err) || S.common.unknownError, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {KINDS.map((kind) => {
        const state = status?.[kind] ?? 'unknown'
        const granted = state === 'granted'
        const info = T.permissions[kind]
        return (
          <div key={kind} className="perm-row">
            <span className={`perm-icon${granted ? ' is-ok' : ''}`}>{ICONS[kind]}</span>
            <div className="perm-text">
              <div className="set-row-label">{info.title}</div>
              <div className="set-row-desc">{info.desc}</div>
            </div>
            <span className={`perm-badge perm-badge--${granted ? 'ok' : state === 'not-determined' || state === 'unknown' ? 'idle' : 'bad'}`}>
              {granted ? <CircleCheck size={13} aria-hidden="true" /> : <ShieldAlert size={13} aria-hidden="true" />}
              {status ? T.states[state] : '…'}
            </span>
            {!granted && (
              <div className="perm-actions">
                <button type="button" className="btn btn--sm btn--primary" disabled={busy === kind} onClick={() => void request(kind)}>
                  {busy === kind && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
                  {T.allow}
                </button>
                <button type="button" className="btn btn--sm" onClick={() => void api.app.openPermissionSettings(kind)}>
                  <ExternalLink size={13} aria-hidden="true" />
                  {T.openSettings}
                </button>
              </div>
            )}
          </div>
        )
      })}
      <div className="set-row set-row--end">
        <button type="button" className="btn btn--sm btn--ghost" onClick={refresh}>
          <RefreshCw size={13} aria-hidden="true" />
          {T.recheck}
        </button>
      </div>
    </>
  )
}

export function ComputerTab(): React.JSX.Element {
  const s = useLoadedSettings()
  const update = useSettings((st) => st.update)
  const mac = s.platform === 'darwin'

  return (
    <>
      <Section title={T.controlSection}>
        <ToggleRow label={T.control} description={T.controlDesc} checked={s.computerControl} onChange={(computerControl) => void update({ computerControl })} />
        <ToggleRow
          label={T.confirm}
          description={T.confirmDesc}
          checked={s.confirmDangerous}
          disabled={!s.computerControl}
          onChange={(confirmDangerous) => void update({ confirmDangerous })}
        />
        <ToggleRow
          label={T.shell}
          description={T.shellDesc}
          checked={s.allowShellCommands}
          disabled={!s.computerControl}
          onChange={(allowShellCommands) => void update({ allowShellCommands })}
        />
      </Section>

      {mac ? (
        <Section title={T.permissionsSection} description={T.permissionsDesc}>
          <PermissionRows />
        </Section>
      ) : (
        <Callout icon={<Info size={16} />}>{T.permissionsWindows}</Callout>
      )}
    </>
  )
}
