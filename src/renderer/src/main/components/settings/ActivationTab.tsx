import { Cloud, Cpu, MicOff, TriangleAlert } from 'lucide-react'
import type { WakeEngine, WakeSensitivity } from '@shared/types'
import { api } from '../../../common/api'
import { S } from '../../../common/strings'
import { useAssistant } from '../../state/assistant'
import { useLoadedSettings, useSettings } from '../../state/settings'
import { Callout, ChoiceCards, Row, Section, Segmented, Slider, type Choice } from './controls'
import { HotkeyInput } from './HotkeyInput'
import { MicPicker } from './MicPicker'
import { WakePhrases } from './WakePhrases'

const T = S.settings.activation

export function ActivationTab(): React.JSX.Element {
  const s = useLoadedSettings()
  const update = useSettings((st) => st.update)
  const engineError = useAssistant((st) => st.state.engineError)
  const off = s.wakeEngine === 'off'

  const engines: Choice<WakeEngine>[] = [
    { value: 'local', title: T.engines.local.title, description: T.engines.local.desc, icon: <Cpu size={16} /> },
    { value: 'cloud', title: T.engines.cloud.title, description: T.engines.cloud.desc, icon: <Cloud size={16} /> },
    { value: 'off', title: T.engines.off.title, description: T.engines.off.desc, icon: <MicOff size={16} /> }
  ]

  return (
    <>
      <Section title={T.engineSection} description={T.engineDesc}>
        <div className="set-row set-row--flush">
          <ChoiceCards<WakeEngine> label={T.engineSection} value={s.wakeEngine} choices={engines} onChange={(wakeEngine) => void update({ wakeEngine })} />
        </div>
        {engineError && !off && (
          <div className="set-row">
            <Callout tone="warn" icon={<TriangleAlert size={16} />}>
              {T.engineError(engineError)}
            </Callout>
          </div>
        )}
        <Row label={T.phrases} description={T.phrasesDesc} stacked disabled={off}>
          <WakePhrases phrases={s.wakePhrases} onChange={(wakePhrases) => void update({ wakePhrases })} />
        </Row>
        <Row label={T.sensitivity} description={T.sensitivityDesc} disabled={off}>
          <Segmented<WakeSensitivity>
            label={T.sensitivity}
            value={s.wakeSensitivity}
            disabled={off}
            options={(['low', 'medium', 'high'] as const).map((v) => ({ value: v, label: T.sensitivities[v] }))}
            onChange={(wakeSensitivity) => void update({ wakeSensitivity })}
          />
        </Row>
      </Section>

      <Section title={T.sessionSection}>
        <Row label={T.followUp} description={T.followUpDesc}>
          <Slider
            label={T.followUp}
            value={s.followUpSeconds}
            min={0}
            max={30}
            step={1}
            format={(v) => (v === 0 ? T.followUpOff : T.seconds(v))}
            onCommit={(followUpSeconds) => void update({ followUpSeconds })}
          />
        </Row>
        <Row label={T.commandTimeout} description={T.commandTimeoutDesc}>
          <Slider
            label={T.commandTimeout}
            value={s.commandTimeoutSeconds}
            min={3}
            max={30}
            step={1}
            format={T.seconds}
            onCommit={(commandTimeoutSeconds) => void update({ commandTimeoutSeconds })}
          />
        </Row>
        <Row label={T.acknowledge}>
          <Segmented<'chime' | 'voice' | 'both'>
            label={T.acknowledge}
            value={s.acknowledge}
            options={(['chime', 'voice', 'both'] as const).map((v) => ({ value: v, label: T.acknowledges[v] }))}
            onChange={(acknowledge) => void update({ acknowledge })}
          />
        </Row>
      </Section>

      <Section title={T.micSection}>
        <div className="set-row set-row--flush">
          <MicPicker deviceId={s.micDeviceId} onChange={(micDeviceId) => void update({ micDeviceId })} />
        </div>
      </Section>

      <Section title={T.hotkeysSection}>
        <Row label={T.hotkeyVoice} description={T.hotkeyVoiceDesc}>
          <HotkeyInput label={T.hotkeyVoice} value={s.hotkeyVoice} platform={api.platform} onChange={(hotkeyVoice) => void update({ hotkeyVoice })} />
        </Row>
        <Row label={T.hotkeyWindow}>
          <HotkeyInput label={T.hotkeyWindow} value={s.hotkeyWindow} platform={api.platform} onChange={(hotkeyWindow) => void update({ hotkeyWindow })} />
        </Row>
      </Section>
    </>
  )
}
