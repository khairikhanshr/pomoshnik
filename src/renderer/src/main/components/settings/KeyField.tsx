import { useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, Trash2 } from 'lucide-react'
import type { PublicSettings } from '@shared/types'
import { errorMessage } from '../../../common/api'
import { S } from '../../../common/strings'
import { useSettings } from '../../state/settings'
import { toast } from '../../state/ui'
import { SecretInput } from '../ui/SecretInput'

interface KeyFieldProps {
  id: string
  label: string
  hasKey: boolean
  hint: string
  placeholder: string
  save(key: string): Promise<PublicSettings>
  clear(): Promise<PublicSettings>
  savedText: string
  removedText: string
}

/** Stored-secret status + replace / remove. The stored key itself never reaches the renderer. */
export function KeyField({ id, label, hasKey, hint, placeholder, save, clear, savedText, removedText }: KeyFieldProps): React.JSX.Element {
  const apply = useSettings((s) => s.apply)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null)
  const [error, setError] = useState('')

  const run = async (kind: 'save' | 'clear'): Promise<void> => {
    if (busy) return
    if (kind === 'save' && !value.trim()) return
    setBusy(kind)
    setError('')
    try {
      apply(kind === 'save' ? await save(value.trim()) : await clear())
      if (kind === 'save') setValue('')
      toast(kind === 'save' ? savedText : removedText, 'success')
    } catch (err) {
      setError(errorMessage(err) || S.common.unknownError)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="key-field">
      <div className={`key-status${hasKey ? ' is-set' : ''}`}>
        {hasKey ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
        <span className="key-status-text">{hasKey ? S.settings.ai.keyStored(hint) : S.settings.ai.keyNone}</span>
        {hasKey && (
          <button type="button" className="btn btn--sm btn--ghost key-remove" onClick={() => void run('clear')} disabled={!!busy}>
            {busy === 'clear' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
            {S.settings.ai.removeKey}
          </button>
        )}
      </div>
      <div className="key-input-row">
        <SecretInput
          id={id}
          value={value}
          onChange={setValue}
          onSubmit={() => void run('save')}
          placeholder={hasKey ? S.settings.ai.keyPlaceholderReplace : placeholder}
          label={label}
        />
        <button type="button" className="btn btn--primary" onClick={() => void run('save')} disabled={!value.trim() || !!busy}>
          {busy === 'save' && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
          {S.common.save}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
