import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { AudioLines, Info, LaptopMinimal, RefreshCw, Sparkles, WandSparkles } from 'lucide-react'
import { ELEVENLABS_MODELS, JARVIS_VOICE_INSTRUCTIONS, OPENAI_STT_MODELS, OPENAI_TTS_MODELS, OPENAI_TTS_VOICES } from '@shared/defaults'
import type { ElevenLabsVoice, SpeakMode, TtsProvider } from '@shared/types'
import { api, errorMessage } from '../../../common/api'
import { capitalize, formatDecimal } from '../../../common/format'
import { ttsSupportsInstructions } from '../../../common/models'
import { S } from '../../../common/strings'
import { useLoadedSettings, useSettings } from '../../state/settings'
import { KeyField } from './KeyField'
import { Callout, ChoiceCards, Row, Section, Select, Slider, TextArea, TextField, type Choice, type Option } from './controls'
import { VoicePreview } from './VoicePreview'

const T = S.settings.voice

function withCurrent(options: Option<string>[], current: string): Option<string>[] {
  return current && !options.some((o) => o.value === current) ? [...options, { value: current, label: current }] : options
}

function useElevenVoices(enabled: boolean): { voices: ElevenLabsVoice[]; error?: string; loading: boolean; reload(): void } {
  const [state, setState] = useState<{ voices: ElevenLabsVoice[]; error?: string; loading: boolean }>({ voices: [], loading: false })
  const reload = useCallback(() => {
    if (!enabled) return
    setState((s) => ({ ...s, loading: true }))
    api.speech
      .listElevenLabsVoices()
      .then((r) => setState({ voices: r.voices, error: r.error, loading: false }))
      .catch((err: unknown) => setState({ voices: [], error: errorMessage(err) || S.common.unknownError, loading: false }))
  }, [enabled])
  useEffect(() => {
    if (enabled) reload()
    else setState({ voices: [], loading: false })
  }, [enabled, reload])
  return { ...state, reload }
}

function useSystemVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => window.speechSynthesis?.getVoices() ?? [])
  useEffect(() => {
    const synth = window.speechSynthesis
    if (!synth) return
    const update = (): void => setVoices(synth.getVoices())
    update()
    synth.addEventListener('voiceschanged', update)
    return () => synth.removeEventListener('voiceschanged', update)
  }, [])
  return voices
}

function OpenAiVoice(): React.JSX.Element {
  const s = useLoadedSettings()
  const update = useSettings((st) => st.update)
  const ids = { voice: useId(), model: useId(), style: useId() }
  const styleOk = ttsSupportsInstructions(s.ttsModel)
  return (
    <>
      <Row label={T.openaiVoice} htmlFor={ids.voice}>
        <Select
          id={ids.voice}
          value={s.ttsVoice}
          options={withCurrent(
            OPENAI_TTS_VOICES.map((v) => ({ value: v, label: capitalize(v) })),
            s.ttsVoice
          )}
          onChange={(ttsVoice) => void update({ ttsVoice })}
        />
      </Row>
      <Row label={T.ttsModel} htmlFor={ids.model}>
        <Select
          id={ids.model}
          value={s.ttsModel}
          options={withCurrent(
            OPENAI_TTS_MODELS.map((m) => ({ value: m, label: m })),
            s.ttsModel
          )}
          onChange={(ttsModel) => void update({ ttsModel })}
        />
      </Row>
      <Row
        label={T.style}
        description={styleOk ? T.styleDesc : T.styleNotSupported}
        htmlFor={ids.style}
        stacked
        disabled={!styleOk}
      >
        <TextArea id={ids.style} value={s.ttsInstructions} rows={5} onCommit={(ttsInstructions) => void update({ ttsInstructions })} />
        <div className="row-actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={s.ttsInstructions === JARVIS_VOICE_INSTRUCTIONS}
            onClick={() => void update({ ttsInstructions: JARVIS_VOICE_INSTRUCTIONS })}
          >
            <WandSparkles size={13} aria-hidden="true" />
            {T.styleReset}
          </button>
        </div>
      </Row>
    </>
  )
}

function ElevenLabsVoiceSettings(): React.JSX.Element {
  const s = useLoadedSettings()
  const update = useSettings((st) => st.update)
  const { voices, error, loading, reload } = useElevenVoices(s.hasElevenLabsKey)
  const ids = { key: useId(), voice: useId(), manual: useId(), model: useId() }
  const selected = voices.find((v) => v.id === s.elevenVoiceId)

  const voiceOptions: Option<string>[] = [
    {
      value: '',
      label: !s.hasElevenLabsKey ? T.elevenVoicesNeedKey : loading ? T.elevenVoicesLoading : voices.length ? T.elevenVoicePick : T.elevenVoicesEmpty
    },
    ...voices.map((v) => ({ value: v.id, label: v.description ? `${v.name} — ${v.description}` : v.name }))
  ]
  if (s.elevenVoiceId && !selected) voiceOptions.push({ value: s.elevenVoiceId, label: s.elevenVoiceId })

  return (
    <>
      <Row label={T.elevenKey} htmlFor={ids.key} stacked>
        <KeyField
          id={ids.key}
          label={T.elevenKey}
          hasKey={s.hasElevenLabsKey}
          hint={s.elevenLabsKeyHint}
          placeholder={T.elevenKeyPlaceholder}
          save={(k) => api.settings.setElevenLabsKey(k)}
          clear={() => api.settings.clearElevenLabsKey()}
          savedText={T.elevenKeySaved}
          removedText={T.elevenKeyRemoved}
        />
      </Row>
      <Row label={T.elevenVoice} htmlFor={ids.voice} stacked>
        <div className="inline-field">
          <Select id={ids.voice} value={s.elevenVoiceId} options={voiceOptions} disabled={!s.hasElevenLabsKey} onChange={(elevenVoiceId) => void update({ elevenVoiceId })} />
          <button type="button" className="btn btn--ghost" onClick={reload} disabled={!s.hasElevenLabsKey || loading} aria-label={S.common.refresh} title={S.common.refresh}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
          </button>
        </div>
        {error && <p className="field-error">{error}</p>}
      </Row>
      <Row label={T.elevenVoiceId} description={T.elevenVoiceIdDesc} htmlFor={ids.manual}>
        <TextField
          id={ids.manual}
          value={s.elevenVoiceId}
          mono
          placeholder="21m00Tcm4TlvDq8ikWAM"
          maxLength={64}
          transform={(v) => v.replace(/[^A-Za-z0-9]/g, '')}
          onCommit={(elevenVoiceId) => void update({ elevenVoiceId })}
        />
      </Row>
      <Row label={T.elevenModel} htmlFor={ids.model}>
        <Select
          id={ids.model}
          value={s.elevenModel}
          options={withCurrent(
            ELEVENLABS_MODELS.map((m) => ({ value: m.id, label: m.label })),
            s.elevenModel
          )}
          onChange={(elevenModel) => void update({ elevenModel })}
        />
      </Row>
      <Row label={T.stability} description={T.stabilityDesc}>
        <Slider label={T.stability} value={s.elevenStability} min={0} max={1} step={0.05} format={(v) => formatDecimal(v)} onCommit={(elevenStability) => void update({ elevenStability })} />
      </Row>
      <Row label={T.similarity} description={T.similarityDesc}>
        <Slider label={T.similarity} value={s.elevenSimilarity} min={0} max={1} step={0.05} format={(v) => formatDecimal(v)} onCommit={(elevenSimilarity) => void update({ elevenSimilarity })} />
      </Row>
      <div className="set-row">
        <Callout icon={<Info size={16} />}>{T.rightsHint}</Callout>
      </div>
    </>
  )
}

function SystemVoice(): React.JSX.Element {
  const s = useLoadedSettings()
  const update = useSettings((st) => st.update)
  const voices = useSystemVoices()
  const id = useId()

  const groups = useMemo(() => {
    const byLang = new Map<string, SpeechSynthesisVoice[]>()
    for (const v of voices) {
      const lang = v.lang || '—'
      byLang.set(lang, [...(byLang.get(lang) ?? []), v])
    }
    const rank = (lang: string): number => (lang.toLowerCase().startsWith('ru') ? 0 : lang.toLowerCase().startsWith('en') ? 1 : 2)
    return [...byLang.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([lang, list]) => ({ label: lang, options: list.map((v) => ({ value: v.name, label: v.name })) }))
  }, [voices])

  const known = voices.some((v) => v.name === s.systemVoiceName)
  const options: Option<string>[] = [{ value: '', label: T.systemVoiceAuto }]
  if (s.systemVoiceName && !known) options.push({ value: s.systemVoiceName, label: s.systemVoiceName })

  return (
    <Row label={T.systemVoice} description={voices.length ? undefined : T.systemVoicesEmpty} htmlFor={id}>
      <Select id={id} value={s.systemVoiceName} options={options} groups={groups} onChange={(systemVoiceName) => void update({ systemVoiceName })} />
    </Row>
  )
}

export function VoiceTab(): React.JSX.Element {
  const s = useLoadedSettings()
  const update = useSettings((st) => st.update)
  const ids = { mode: useId(), stt: useId(), lang: useId() }

  const providers: Choice<TtsProvider>[] = [
    { value: 'openai', title: T.providers.openai, description: T.providerDesc.openai, icon: <Sparkles size={16} /> },
    { value: 'elevenlabs', title: T.providers.elevenlabs, description: T.providerDesc.elevenlabs, icon: <AudioLines size={16} /> },
    { value: 'system', title: T.providers.system, description: T.providerDesc.system, icon: <LaptopMinimal size={16} /> }
  ]

  const eleven = s.ttsProvider === 'elevenlabs'
  const speedMin = eleven ? 0.7 : 0.5
  const speedMax = eleven ? 1.2 : 2
  const speed = Math.min(speedMax, Math.max(speedMin, s.ttsSpeed))

  return (
    <>
      <Section title={T.providerSection} actions={<VoicePreview settings={s} />}>
        <div className="set-row set-row--flush">
          <ChoiceCards<TtsProvider> label={T.provider} value={s.ttsProvider} choices={providers} onChange={(ttsProvider) => void update({ ttsProvider })} />
        </div>
        {s.ttsProvider === 'openai' && <OpenAiVoice />}
        {eleven && <ElevenLabsVoiceSettings />}
        {s.ttsProvider === 'system' && <SystemVoice />}
        <Row label={T.speed} description={eleven ? T.elevenSpeedNote : undefined}>
          <Slider
            label={T.speed}
            value={speed}
            min={speedMin}
            max={speedMax}
            step={0.05}
            format={(v) => `${formatDecimal(v)}×`}
            onCommit={(ttsSpeed) => void update({ ttsSpeed })}
          />
        </Row>
      </Section>

      <Section title={T.playbackSection}>
        <Row label={T.speakMode} htmlFor={ids.mode}>
          <Select<SpeakMode>
            id={ids.mode}
            value={s.speakMode}
            options={(['voice', 'always', 'never'] as const).map((m) => ({ value: m, label: T.speakModes[m] }))}
            onChange={(speakMode) => void update({ speakMode })}
          />
        </Row>
        <Row label={T.maxSpoken} description={T.maxSpokenDesc}>
          <Slider label={T.maxSpoken} value={s.maxSpokenChars} min={100} max={5000} step={50} format={T.chars} onCommit={(maxSpokenChars) => void update({ maxSpokenChars })} />
        </Row>
      </Section>

      <Section title={T.sttSection}>
        <Row label={T.sttModel} htmlFor={ids.stt}>
          <Select
            id={ids.stt}
            value={s.sttModel}
            options={withCurrent(
              OPENAI_STT_MODELS.map((m) => ({ value: m, label: m })),
              s.sttModel
            )}
            onChange={(sttModel) => void update({ sttModel })}
          />
        </Row>
        <Row label={T.sttLanguage} htmlFor={ids.lang}>
          <Select
            id={ids.lang}
            value={s.sttLanguage}
            options={withCurrent(
              Object.entries(T.sttLanguages).map(([value, label]) => ({ value, label })),
              s.sttLanguage
            )}
            onChange={(sttLanguage) => void update({ sttLanguage })}
          />
        </Row>
      </Section>
    </>
  )
}
