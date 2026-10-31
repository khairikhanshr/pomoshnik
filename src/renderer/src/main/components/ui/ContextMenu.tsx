import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUi } from '../../state/ui'

const EDGE = 8

export function ContextMenu(): React.JSX.Element | null {
  const menu = useUi((s) => s.menu)
  const close = useUi((s) => s.closeMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null)
      return
    }
    const r = ref.current.getBoundingClientRect()
    setPos({
      left: Math.min(menu.x, window.innerWidth - r.width - EDGE),
      top: Math.min(menu.y, window.innerHeight - r.height - EDGE)
    })
    ref.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onBlur = (): void => close()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    window.addEventListener('wheel', onBlur, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
      window.removeEventListener('wheel', onBlur)
    }
  }, [menu, close])

  if (!menu) return null

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(i + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      close()
    }
  }

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={pos ?? { left: menu.x, top: menu.y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`ctx-item${item.danger ? ' ctx-item--danger' : ''}`}
          onClick={() => {
            close()
            item.onSelect()
          }}
        >
          {item.icon && <span className="ctx-icon">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
