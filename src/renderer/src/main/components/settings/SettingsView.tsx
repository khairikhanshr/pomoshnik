import { useEffect, useRef } from 'react'
import { ArrowLeft, AudioLines, BrainCircuit, Info, Laptop, Radio, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { S } from '../../../common/strings'
import { useLoadedSettings } from '../../state/settings'
import { SETTINGS_TABS, useUi, type SettingsTab } from '../../state/ui'
import { AboutTab } from './AboutTab'
import { ActivationTab } from './ActivationTab'
import { AiTab } from './AiTab'
import { ComputerTab } from './ComputerTab'
import { GeneralTab } from './GeneralTab'
import { VoiceTab } from './VoiceTab'

const TAB_ICONS: Record<SettingsTab, LucideIcon> = {
  ai: BrainCircuit,
  voice: AudioLines,
  activation: Radio,
  computer: Laptop,
  general: SlidersHorizontal,
  about: Info
}

const TAB_VIEWS: Record<SettingsTab, () => React.JSX.Element> = {
  ai: AiTab,
  voice: VoiceTab,
  activation: ActivationTab,
  computer: ComputerTab,
  general: GeneralTab,
  about: AboutTab
}

export function SettingsView(): React.JSX.Element {
  const settings = useLoadedSettings()
  const tab = useUi((s) => s.settingsTab)
  const setTab = useUi((s) => s.setSettingsTab)
  const back = useUi((s) => s.openChatView)
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const View = TAB_VIEWS[tab]

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [tab])

  const initialTab = useRef(tab)
  useEffect(() => {
    tabRefs.current[initialTab.current]?.focus()
  }, [])

  const onTabKey = (e: React.KeyboardEvent): void => {
    const i = SETTINGS_TABS.indexOf(tab)
    let next = -1
    if (e.key === 'ArrowDown') next = (i + 1) % SETTINGS_TABS.length
    if (e.key === 'ArrowUp') next = (i - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
    if (e.key === 'Home') next = 0
    if (e.key === 'End') next = SETTINGS_TABS.length - 1
    if (next < 0) return
    e.preventDefault()
    const t = SETTINGS_TABS[next]
    setTab(t)
    tabRefs.current[t]?.focus()
  }

  return (
    <div className="settings">
      <nav className="set-nav" aria-label={S.settings.title}>
        <div className="set-nav-head drag">
          <button type="button" className="set-back" onClick={back}>
            <ArrowLeft size={16} aria-hidden="true" />
            {S.settings.back}
          </button>
        </div>
        <div className="set-nav-title">{S.settings.title}</div>
        <div className="set-tabs" role="tablist" aria-orientation="vertical" aria-label={S.settings.title} onKeyDown={onTabKey}>
          {SETTINGS_TABS.map((t) => {
            const Icon = TAB_ICONS[t]
            const selected = t === tab
            return (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el
                }}
                id={`set-tab-${t}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="set-panel"
                tabIndex={selected ? 0 : -1}
                className={`set-tab${selected ? ' is-selected' : ''}`}
                onClick={() => setTab(t)}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{S.settings.tabs[t]}</span>
              </button>
            )
          })}
        </div>
        <div className="set-nav-foot">
          {S.app.logo} · {S.settings.about.version(settings.appVersion)}
        </div>
      </nav>

      <section className="set-main">
        <header className="set-header drag">
          <h1 className="set-header-title">{S.settings.tabs[tab]}</h1>
        </header>
        <div ref={scrollRef} className="set-scroll">
          <div id="set-panel" className="set-content" role="tabpanel" aria-labelledby={`set-tab-${tab}`}>
            <View />
          </div>
        </div>
      </section>
    </div>
  )
}
