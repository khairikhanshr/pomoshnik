import { AlarmClock, CloudSun, ScanText, Send } from 'lucide-react'
import { api, errorMessage } from '../../../common/api'
import { Orb } from '../../../common/Orb'
import { S } from '../../../common/strings'
import { SHORT_WINDOW, useMediaQuery } from '../../hooks/useMediaQuery'
import { useAssistant } from '../../state/assistant'
import { useLoadedSettings } from '../../state/settings'
import { toast } from '../../state/ui'

const EXAMPLE_ICONS = [ScanText, Send, CloudSun, AlarmClock]

export function EmptyState({ onExample }: { onExample(text: string): void }): React.JSX.Element {
  const settings = useLoadedSettings()
  const phase = useAssistant((s) => s.state.phase)
  const wakeOn = settings.wakeEngine !== 'off'
  const short = useMediaQuery(SHORT_WINDOW)

  const listen = (): void => {
    api.assistant.listen().catch((err: unknown) => toast(errorMessage(err) || S.common.unknownError, 'error'))
  }

  return (
    <div className="empty">
      <div className="empty-inner">
        <button type="button" className="empty-orb" onClick={listen} aria-label={S.empty.orbHint} title={S.empty.orbHint}>
          <span className="empty-orb-ring" aria-hidden="true" />
          <Orb size={short ? 100 : 168} phase={phase} reactive />
        </button>
        <h2 className="empty-title">{S.empty.greeting(new Date().getHours(), settings.userTitle)}</h2>
        <p className="empty-sub">{wakeOn ? S.empty.subtitle : S.empty.subtitleNoWake}</p>

        <div className="empty-examples" role="list" aria-label={S.empty.examplesTitle}>
          {S.empty.examples.map((text, i) => {
            const Icon = EXAMPLE_ICONS[i % EXAMPLE_ICONS.length]
            return (
              <button key={text} type="button" role="listitem" className="example" onClick={() => onExample(text)}>
                <span className="example-icon">
                  <Icon size={16} aria-hidden="true" />
                </span>
                <span className="example-text">{text}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
