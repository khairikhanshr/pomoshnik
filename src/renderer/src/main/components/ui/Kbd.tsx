import { api } from '../../../common/api'
import { acceleratorParts } from '../../../common/format'

/** Renders an Electron accelerator as keycaps, e.g. ⌘ N / Ctrl N. */
export function Kbd({ accelerator, className }: { accelerator: string; className?: string }): React.JSX.Element {
  const parts = acceleratorParts(accelerator, api.platform)
  return (
    <span className={`kbd-group${className ? ` ${className}` : ''}`} aria-hidden="true">
      {parts.map((p, i) => (
        <kbd key={`${p}-${i}`}>{p}</kbd>
      ))}
    </span>
  )
}
