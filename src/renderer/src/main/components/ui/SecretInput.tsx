import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { S } from '../../../common/strings'

interface SecretInputProps {
  id?: string
  value: string
  onChange(value: string): void
  onSubmit?(): void
  placeholder?: string
  label: string
  autoFocus?: boolean
  disabled?: boolean
}

/** Password-style field with a show/hide toggle; never pre-filled with a stored secret. */
export function SecretInput({ id, value, onChange, onSubmit, placeholder, label, autoFocus, disabled }: SecretInputProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  return (
    <div className="secret-input">
      <input
        id={id}
        className="input input--mono"
        type={visible ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      <button
        type="button"
        className="secret-toggle"
        aria-label={visible ? S.settings.ai.hideKey : S.settings.ai.showKey}
        title={visible ? S.settings.ai.hideKey : S.settings.ai.showKey}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  )
}
