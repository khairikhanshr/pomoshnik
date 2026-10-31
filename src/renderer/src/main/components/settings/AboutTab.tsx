import { TIER_INFO } from '@shared/defaults'
import { TIERS } from '@shared/types'
import { Orb } from '../../../common/Orb'
import { S } from '../../../common/strings'
import { useLoadedSettings } from '../../state/settings'
import { TIER_ICONS } from '../chat/TierSwitch'
import { Kbd } from '../ui/Kbd'
import { Section } from './controls'

const T = S.settings.about

export function AboutTab(): React.JSX.Element {
  const s = useLoadedSettings()
  return (
    <>
      <div className="about-hero">
        <Orb size={112} phase="idle" />
        <div className="about-id">
          <div className="about-name">{S.app.logo}</div>
          <div className="about-tagline">{S.app.tagline}</div>
          <div className="about-version">
            {T.version(s.appVersion)} · {T.platform[s.platform]}
          </div>
        </div>
      </div>

      <Section title={T.guideTitle}>
        <ol className="guide">
          {T.guide.map((g, i) => (
            <li key={g.title} className="guide-item">
              <span className="guide-num">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <div className="guide-title">
                  {g.title}
                  {i === 1 && s.hotkeyVoice && <Kbd accelerator={s.hotkeyVoice} className="guide-kbd" />}
                </div>
                <div className="guide-text">{g.text}</div>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={T.tiersTitle}>
        <div className="about-tiers">
          {TIERS.map((t) => {
            const Icon = TIER_ICONS[t]
            return (
              <div key={t} className="about-tier">
                <span className={`tier-row-icon tier-row-icon--${t}`}>
                  <Icon size={16} aria-hidden="true" />
                </span>
                <div>
                  <div className="about-tier-name">
                    {TIER_INFO[t].label} <span>· {TIER_INFO[t].subtitle}</span>
                  </div>
                  <div className="guide-text">{TIER_INFO[t].description}</div>
                  <div className="about-tier-model">{s.resolvedModels[t]}</div>
                </div>
              </div>
            )
          })}
        </div>
      </Section>

      <p className="about-note">{T.voiceNote}</p>
    </>
  )
}
