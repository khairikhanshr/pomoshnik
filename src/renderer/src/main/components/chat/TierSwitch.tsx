import { useRef } from 'react'
import { Earth, Moon, Sun, type LucideIcon } from 'lucide-react'
import { TIER_INFO } from '@shared/defaults'
import { TIERS, type Tier } from '@shared/types'
import { S } from '../../../common/strings'
import { Tooltip } from '../ui/Tooltip'

export const TIER_ICONS: Record<Tier, LucideIcon> = { luna: Moon, terra: Earth, sol: Sun }

interface TierSwitchProps {
  value: Tier
  resolved: Record<Tier, string>
  onChange(tier: Tier): void
  compact?: boolean
}

/** Segmented Luna / Terra / Sol control (ARIA radio group with arrow-key navigation). */
export function TierSwitch({ value, resolved, onChange, compact }: TierSwitchProps): React.JSX.Element {
  const refs = useRef<Partial<Record<Tier, HTMLButtonElement | null>>>({})

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const i = TIERS.indexOf(value)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % TIERS.length
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + TIERS.length) % TIERS.length
    if (e.key === 'Home') next = 0
    if (e.key === 'End') next = TIERS.length - 1
    if (next < 0) return
    e.preventDefault()
    const tier = TIERS[next]
    onChange(tier)
    refs.current[tier]?.focus()
  }

  return (
    <div className={`tier-switch${compact ? ' tier-switch--compact' : ''}`} role="radiogroup" aria-label={S.header.tierGroup} onKeyDown={onKeyDown}>
      {TIERS.map((tier) => {
        const info = TIER_INFO[tier]
        const Icon = TIER_ICONS[tier]
        const checked = tier === value
        return (
          <Tooltip
            key={tier}
            content={
              <>
                <div className="tooltip-title">
                  {info.label} — {info.subtitle}
                </div>
                <div className="tooltip-sub">{info.description}</div>
                <div className="tooltip-mono">{S.tiers.resolved(resolved[tier])}</div>
              </>
            }
          >
            <button
              ref={(el) => {
                refs.current[tier] = el
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`${info.label}, ${info.subtitle}. ${S.tiers.resolved(resolved[tier])}`}
              tabIndex={checked ? 0 : -1}
              className={`tier-seg tier-seg--${tier}${checked ? ' is-checked' : ''}`}
              onClick={() => onChange(tier)}
            >
              <Icon size={15} strokeWidth={2} aria-hidden="true" />
              <span className="tier-seg-label">{info.label}</span>
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
