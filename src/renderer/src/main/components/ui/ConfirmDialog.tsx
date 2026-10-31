import { TriangleAlert } from 'lucide-react'
import { S } from '../../../common/strings'
import { useUi } from '../../state/ui'
import { Modal } from './Modal'

export function ConfirmDialog(): React.JSX.Element | null {
  const req = useUi((s) => s.confirm)
  const settle = useUi((s) => s.settleConfirm)
  if (!req) return null
  return (
    <Modal label={req.title} onClose={() => settle(false)} className="confirm" initialFocus={req.danger ? '.btn--ghost' : '.btn--primary, .btn--danger'}>
      <div className="confirm-body">
        {req.danger && (
          <div className="confirm-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </div>
        )}
        <div>
          <h2 className="confirm-title">{req.title}</h2>
          <p className="confirm-text">{req.message}</p>
        </div>
      </div>
      <div className="confirm-actions">
        <button type="button" className="btn btn--ghost" onClick={() => settle(false)}>
          {S.common.cancel}
        </button>
        <button type="button" className={`btn ${req.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => settle(true)}>
          {req.confirmText}
        </button>
      </div>
    </Modal>
  )
}
