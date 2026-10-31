import { useState } from 'react'
import { ArrowUpRight, KeyRound, LoaderCircle, Settings2 } from 'lucide-react'
import { api, errorMessage } from '../../../common/api'
import { Orb } from '../../../common/Orb'
import { S } from '../../../common/strings'
import { SHORT_WINDOW, useMediaQuery } from '../../hooks/useMediaQuery'
import { useSettings } from '../../state/settings'
import { toast, useUi } from '../../state/ui'
import { SecretInput } from '../ui/SecretInput'

export function Onboarding(): React.JSX.Element {
  const apply = useSettings((s) => s.apply)
  const openSettings = useUi((s) => s.openSettings)
  const focusComposer = useUi((s) => s.focusComposer)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const short = useMediaQuery(SHORT_WINDOW)

  const save = async (): Promise<void> => {
    const value = key.trim()
    if (!value || saving) return
    setSaving(true)
    setError('')
    try {
      apply(await api.settings.setApiKey(value))
      setKey('')
      toast(S.onboarding.keySaved, 'success')
      focusComposer()
    } catch (err) {
      setError(errorMessage(err) || S.common.unknownError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="empty">
      <section className="onboard" aria-labelledby="onboard-title">
        <div className="onboard-orb">
          <Orb size={short ? 64 : 104} phase="idle" />
        </div>
        <h2 id="onboard-title" className="onboard-title">
          {S.onboarding.title}
        </h2>
        <p className="onboard-text">{S.onboarding.text}</p>

        <ol className="onboard-steps">
          <li>
            <span className="onboard-step-num">1</span>
            <span>
              {S.onboarding.step1}{' '}
              <button type="button" className="link-btn" onClick={() => void api.app.openExternal(S.onboarding.keysUrl)}>
                {S.onboarding.getKey}
                <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            </span>
          </li>
          <li>
            <span className="onboard-step-num">2</span>
            <span>{S.onboarding.step2}</span>
          </li>
          <li>
            <span className="onboard-step-num">3</span>
            <span>{S.onboarding.step3}</span>
          </li>
        </ol>

        <form
          className="onboard-form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <SecretInput value={key} onChange={setKey} onSubmit={() => void save()} placeholder={S.onboarding.keyPlaceholder} label={S.onboarding.keyLabel} />
          <button type="submit" className="btn btn--primary" disabled={!key.trim() || saving}>
            {saving ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />}
            {S.onboarding.saveKey}
          </button>
        </form>
        {error && (
          <p className="onboard-error" role="alert">
            {error}
          </p>
        )}

        <button type="button" className="link-btn onboard-more" onClick={() => openSettings('ai')}>
          <Settings2 size={14} aria-hidden="true" />
          {S.onboarding.allSettings}
        </button>
      </section>
    </div>
  )
}
