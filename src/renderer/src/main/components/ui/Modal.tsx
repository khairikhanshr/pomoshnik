import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface ModalProps {
  label: string
  onClose(): void
  children: React.ReactNode
  className?: string
  /** Element to focus first (selector inside the modal). */
  initialFocus?: string
  onKeyDown?(e: React.KeyboardEvent<HTMLDivElement>): void
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Portal modal with a focus trap, Escape to close and focus restoration. */
export function Modal({ label, onClose, children, className, initialFocus, onKeyDown }: ModalProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const root = ref.current
    const first = (initialFocus && root?.querySelector<HTMLElement>(initialFocus)) || root?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? root)?.focus()
    return () => previous?.focus?.()
  }, [initialFocus])

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
      return
    }
    if (e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current()
      }}
    >
      <div ref={ref} className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={handleKey}>
        {children}
      </div>
    </div>,
    document.body
  )
}
