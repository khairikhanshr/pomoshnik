import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { S } from '../../../common/strings'
import { useUi } from '../../state/ui'

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert }

export function Toasts(): React.JSX.Element {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind]
        return (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            <Icon size={16} className="toast-icon" aria-hidden="true" />
            <span className="toast-text">{t.text}</span>
            <button type="button" className="toast-close" aria-label={S.common.close} onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
