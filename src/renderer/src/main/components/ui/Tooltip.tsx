import { cloneElement, useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactElement<React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }>
  placement?: 'top' | 'bottom'
  delay?: number
  disabled?: boolean
}

const MARGIN = 8

/** Hover/focus tooltip rendered in a portal and clamped to the window. */
export function Tooltip({ content, children, placement = 'bottom', delay = 350, disabled }: TooltipProps): React.JSX.Element {
  const id = useId()
  const anchorRef = useRef<HTMLElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; side: 'top' | 'bottom' } | null>(null)

  const show = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), delay)
  }, [delay])

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setOpen(false)
    setPos(null)
  }, [])

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !bubbleRef.current) return
    const a = anchorRef.current.getBoundingClientRect()
    const b = bubbleRef.current.getBoundingClientRect()
    let side = placement
    if (side === 'bottom' && a.bottom + MARGIN + b.height > window.innerHeight - MARGIN) side = 'top'
    if (side === 'top' && a.top - MARGIN - b.height < MARGIN) side = 'bottom'
    const left = Math.min(Math.max(a.left + a.width / 2 - b.width / 2, MARGIN), window.innerWidth - b.width - MARGIN)
    const top = side === 'bottom' ? a.bottom + MARGIN : a.top - MARGIN - b.height
    setPos({ left, top, side })
  }, [open, placement, content])

  useLayoutEffect(() => () => window.clearTimeout(timer.current), [])

  const child = children
  const props = child.props
  const childRef = props.ref
  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node
      if (typeof childRef === 'function') childRef(node)
      else if (childRef && typeof childRef === 'object') (childRef as React.RefObject<HTMLElement | null>).current = node
    },
    'aria-describedby': open && !disabled ? id : props['aria-describedby'],
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseEnter?.(e)
      if (!disabled) show()
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseLeave?.(e)
      hide()
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      props.onFocus?.(e)
      if (!disabled && e.currentTarget.matches(':focus-visible')) show()
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      props.onBlur?.(e)
      hide()
    },
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseDown?.(e)
      hide()
    }
  } as Partial<React.HTMLAttributes<HTMLElement>>)

  return (
    <>
      {trigger}
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={`tooltip tooltip--${pos?.side ?? placement}`}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  )
}
