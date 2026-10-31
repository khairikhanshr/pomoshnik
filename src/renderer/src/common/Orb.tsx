import { useEffect, useId, useRef } from 'react'
import type { AssistantPhase } from '@shared/types'
import { api } from './api'
import './orb.css'

export type OrbPhase = AssistantPhase | 'static'

interface OrbProps {
  size: number
  /** Drives the animation; 'static' = no motion (logo, avatars). */
  phase?: OrbPhase
  /** Subscribe to assistant.onLevel and pulse with the mic / speech level. */
  reactive?: boolean
  className?: string
}

const LEVEL_TIMEOUT_MS = 260

/** Arc-reactor orb: logo, avatar, empty-state hero and the overlay indicator. */
export function Orb({ size, phase = 'static', reactive = false, className }: OrbProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const full = size >= 56

  useLevelVariable(rootRef, reactive)

  return (
    <div
      ref={rootRef}
      className={`orb ${full ? 'orb--full' : 'orb--mini'}${className ? ` ${className}` : ''}`}
      data-phase={phase}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="-100 -100 200 200" width={size} height={size} focusable="false">
        <defs>
          <radialGradient id={`core-${uid}`}>
            <stop offset="0" style={{ stopColor: '#ffffff' }} />
            <stop offset="0.38" style={{ stopColor: '#dcf9ff' }} />
            <stop offset="0.72" style={{ stopColor: 'var(--orb-accent)' }} />
            <stop offset="1" style={{ stopColor: 'var(--orb-accent)', stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id={`halo-${uid}`}>
            <stop offset="0.42" style={{ stopColor: 'var(--orb-accent)', stopOpacity: 0.34 }} />
            <stop offset="0.7" style={{ stopColor: 'var(--orb-accent)', stopOpacity: 0.1 }} />
            <stop offset="1" style={{ stopColor: 'var(--orb-accent)', stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id={`coil-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--orb-accent)' }} />
            <stop offset="1" style={{ stopColor: 'var(--orb-deep)' }} />
          </linearGradient>
          {full && (
            <filter id={`blur-${uid}`} x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="7" />
            </filter>
          )}
        </defs>

        <circle className="o-halo" r="99" fill={`url(#halo-${uid})`} />

        <g className="o-spin o-ticks">
          <circle className="o-tickring" r="88" strokeWidth={full ? 5 : 8} strokeDasharray={full ? '1.2 4.5596' : '3.4 8.119'} />
        </g>

        {full && (
          <g className="o-spin o-arcs">
            <circle className="o-thin" r="94" />
            <circle className="o-arc" r="94" strokeWidth="2.6" strokeDasharray="70 230 40 250.62" />
          </g>
        )}

        <g className="o-spin o-coils">
          <circle className="o-coilbase" r="67" />
          <circle className="o-coil" r="67" stroke={`url(#coil-${uid})`} strokeDasharray="33.1 9" />
          {full && <circle className="o-coiltex" r="67" />}
        </g>

        <g className="o-spin o-inner">
          <circle
            className="o-arc"
            r="47"
            strokeWidth={full ? 2.2 : 4.5}
            strokeDasharray={full ? '58 10 18 10 46 10 25 10 60 48.31' : '120 27.65'}
          />
          {full && <circle className="o-thin" r="39" />}
        </g>

        <g className="o-spin o-core">
          <g className="o-spin o-core-lv">
            {full && <circle className="o-core-glow" r="31" filter={`url(#blur-${uid})`} />}
            <circle r="31" fill={`url(#core-${uid})`} />
            <circle className="o-core-hot" r="12" />
          </g>
        </g>
      </svg>
    </div>
  )
}

/** Smoothly writes the assistant level into the --lv CSS variable without re-rendering React. */
function useLevelVariable(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    let target = 0
    let current = 0
    let frame = 0
    let lastEvent = 0

    const tick = (): void => {
      if (performance.now() - lastEvent > LEVEL_TIMEOUT_MS) target = 0
      current += (target - current) * (target > current ? 0.42 : 0.1)
      if (Math.abs(target - current) < 0.002) current = target
      el.style.setProperty('--lv', current.toFixed(3))
      frame = current === 0 && target === 0 ? 0 : requestAnimationFrame(tick)
    }

    const unsubscribe = api.assistant.onLevel((level) => {
      target = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0))
      lastEvent = performance.now()
      if (!frame) frame = requestAnimationFrame(tick)
    })

    return () => {
      unsubscribe()
      if (frame) cancelAnimationFrame(frame)
      el.style.setProperty('--lv', '0')
    }
  }, [ref, enabled])
}
