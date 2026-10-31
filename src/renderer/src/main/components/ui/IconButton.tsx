import { forwardRef } from 'react'
import { Tooltip } from './Tooltip'

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  children: React.ReactNode
  /** Tooltip text; defaults to the label. false disables it. */
  tip?: React.ReactNode | false
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
  tone?: 'default' | 'accent' | 'danger'
}

const Button = forwardRef<HTMLButtonElement, IconButtonProps>(function Button(
  { label, children, tip: _tip, active, size = 'md', tone = 'default', className, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={`icon-btn icon-btn--${size} icon-btn--${tone}${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
})

export function IconButton(props: IconButtonProps): React.JSX.Element {
  const { tip, label, disabled } = props
  if (tip === false) return <Button {...props} />
  return (
    <Tooltip content={tip ?? label} disabled={disabled}>
      <Button {...props} />
    </Tooltip>
  )
}
