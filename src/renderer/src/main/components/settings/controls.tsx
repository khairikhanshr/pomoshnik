import { useEffect, useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'

export function Section({
  title,
  description,
  children,
  actions
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section className="set-section" aria-labelledby={id}>
      <div className="set-section-head">
        <div>
          <h2 id={id} className="set-section-title">
            {title}
          </h2>
          {description && <p className="set-section-desc">{description}</p>}
        </div>
        {actions && <div className="set-section-actions">{actions}</div>}
      </div>
      <div className="set-card">{children}</div>
    </section>
  )
}

interface RowProps {
  label: React.ReactNode
  description?: React.ReactNode
  htmlFor?: string
  children?: React.ReactNode
  /** Control below the text (wide inputs). */
  stacked?: boolean
  disabled?: boolean
}

export function Row({ label, description, htmlFor, children, stacked, disabled }: RowProps): React.JSX.Element {
  return (
    <div className={`set-row${stacked ? ' set-row--stacked' : ''}${disabled ? ' is-disabled' : ''}`}>
      <div className="set-row-text">
        {htmlFor ? (
          <label className="set-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className="set-row-label">{label}</div>
        )}
        {description && <div className="set-row-desc">{description}</div>}
      </div>
      {children !== undefined && <div className="set-row-control">{children}</div>}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  id
}: {
  checked: boolean
  onChange(value: boolean): void
  label: string
  disabled?: boolean
  id?: string
}): React.JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" />
    </button>
  )
}

/** A full row whose switch toggles a boolean setting. */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  label: string
  description?: React.ReactNode
  checked: boolean
  onChange(value: boolean): void
  disabled?: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <Row label={label} description={description} htmlFor={id} disabled={disabled}>
      <Toggle id={id} checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </Row>
  )
}

export interface Option<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
}

export interface OptionGroup<T extends string> {
  label: string
  options: Option<T>[]
}

export function Select<T extends string>({
  id,
  value,
  options,
  groups,
  onChange,
  label,
  disabled,
  className
}: {
  id?: string
  value: T
  options?: Option<T>[]
  groups?: OptionGroup<T>[]
  onChange(value: T): void
  label?: string
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <select
      id={id}
      className={`select${className ? ` ${className}` : ''}`}
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {groups?.map((g) =>
        g.options.length ? (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null
      )}
    </select>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled
}: {
  value: T
  options: Option<T>[]
  onChange(value: T): void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const i = options.findIndex((o) => o.value === value)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % options.length
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + options.length) % options.length
    if (next < 0) return
    e.preventDefault()
    onChange(options[next].value)
    refs.current[next]?.focus()
  }
  return (
    <div className={`segmented${disabled ? ' is-disabled' : ''}`} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const checked = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className={`segmented-item${checked ? ' is-checked' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.icon}
            <span>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export interface Choice<T extends string> {
  value: T
  title: string
  description: string
  icon: React.ReactNode
}

/** Large radio cards with an icon, a title and an explanation. */
export function ChoiceCards<T extends string>({
  value,
  choices,
  onChange,
  label
}: {
  value: T
  choices: Choice<T>[]
  onChange(value: T): void
  label: string
}): React.JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const i = choices.findIndex((c) => c.value === value)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % choices.length
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + choices.length) % choices.length
    if (next < 0) return
    e.preventDefault()
    onChange(choices[next].value)
    refs.current[next]?.focus()
  }
  return (
    <div className="choices" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {choices.map((c, i) => {
        const checked = c.value === value
        return (
          <button
            key={c.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={`choice${checked ? ' is-checked' : ''}`}
            onClick={() => onChange(c.value)}
          >
            <span className="choice-head">
              <span className="choice-icon">{c.icon}</span>
              <span className="choice-title">{c.title}</span>
              <span className="choice-check" aria-hidden="true">
                {checked && <Check size={12} strokeWidth={3} />}
              </span>
            </span>
            <span className="choice-desc">{c.description}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Range input that updates its label live and commits after the user pauses. */
export function Slider({
  id,
  value,
  min,
  max,
  step,
  onCommit,
  format,
  label,
  disabled
}: {
  id?: string
  value: number
  min: number
  max: number
  step: number
  onCommit(value: number): void
  format(value: number): string
  label: string
  disabled?: boolean
}): React.JSX.Element {
  const [local, setLocal] = useState(value)
  const timer = useRef(0)
  const dirty = useRef(false)

  useEffect(() => {
    if (!dirty.current) setLocal(value)
  }, [value])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const commit = (v: number): void => {
    window.clearTimeout(timer.current)
    dirty.current = false
    if (v !== value) onCommit(v)
  }

  const pct = ((local - min) / (max - min)) * 100
  return (
    <div className="slider">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        aria-label={label}
        aria-valuetext={format(local)}
        disabled={disabled}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLocal(v)
          dirty.current = true
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => commit(v), 350)
        }}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      />
      <output className="slider-value" htmlFor={id}>
        {format(local)}
      </output>
    </div>
  )
}

/** Text input with a local draft committed on blur / Enter. */
export function TextField({
  id,
  value,
  onCommit,
  placeholder,
  mono,
  label,
  maxLength,
  transform
}: {
  id?: string
  value: string
  onCommit(value: string): void
  placeholder?: string
  mono?: boolean
  label?: string
  maxLength?: number
  transform?(value: string): string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  const commit = (): void => {
    const next = transform ? transform(draft) : draft
    if (next !== draft) setDraft(next)
    if (next !== value) onCommit(next)
  }

  return (
    <input
      id={id}
      className={`input${mono ? ' input--mono' : ''}`}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      maxLength={maxLength}
      spellCheck={false}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          setDraft(value)
        }
      }}
    />
  )
}

/** Multi-line draft committed on blur and after a typing pause. */
export function TextArea({
  id,
  value,
  onCommit,
  placeholder,
  rows = 4,
  label,
  mono
}: {
  id?: string
  value: string
  onCommit(value: string): void
  placeholder?: string
  rows?: number
  label?: string
  mono?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const timer = useRef(0)

  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const commit = (next: string): void => {
    window.clearTimeout(timer.current)
    if (next !== value) onCommit(next)
  }

  return (
    <textarea
      id={id}
      className={`textarea${mono ? ' input--mono' : ''}`}
      value={draft}
      rows={rows}
      placeholder={placeholder}
      aria-label={label}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => {
        const next = e.target.value
        setDraft(next)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => commit(next), 900)
      }}
      onBlur={() => {
        focused.current = false
        commit(draft)
      }}
    />
  )
}

export function Callout({ tone = 'info', icon, children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; icon?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`callout callout--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {icon && <span className="callout-icon">{icon}</span>}
      <div className="callout-body">{children}</div>
    </div>
  )
}
