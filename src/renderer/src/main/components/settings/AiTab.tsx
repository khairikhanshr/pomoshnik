import { useCallback, useEffect, useId, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, PlugZap, RefreshCw } from 'lucide-react'
import { DEFAULT_BASE_URL, REASONING_EFFORT_LABELS, REASONING_EFFORTS, TIER_INFO } from '@shared/defaults'
import { TIERS, type ApiMode, type ImageDetail, type ReasoningEffort, type Tier } from '@shared/types'
import { api, errorMessage } from '../../../common/api'
import { groupModels, isCustomModel } from '../../../common/models'
import { S } from '../../../common/strings'
import { useLoadedSettings, useSettings } from '../../state/settings'
import { TIER_ICONS } from '../chat/TierSwitch'
import { Callout, Row, Section, Segmented, Select, TextArea, TextField, ToggleRow, type Option } from './controls'
import { KeyField } from './KeyField'

const T = S.settings.ai
const CUSTOM = '__custom__'

interface ModelsState {
  models: string[]
  error?: string
  loading: boolean
}

function useModels(): [ModelsState, (force?: boolean) => void] {
  const [state, setState] = useState<ModelsState>({ models: [], loading: true })
  const load = useCallback((force?: boolean) => {
    setState((s) => ({ ...s, loading: true }))
    api.models
      .list(force)
      .then((r) => setState({ models: r.models, error: r.error, loading: false }))
      .catch((err: unknown) => setState({ models: [], error: errorMessage(err) || S.common.unknownError, loading: false }))
  }, [])
  useEffect(() => load(), [load])
  return [state, load]
}

function TierModelRow({ tier, models }: { tier: Tier; models: string[] }): React.JSX.Element {
  const settings = useLoadedSettings()
  const update = useSettings((s) => s.update)
  const cfg = settings.tiers[tier]
  const info = TIER_INFO[tier]
  const Icon = TIER_ICONS[tier]
  const groups = groupModels(models, tier)
  const custom = isCustomModel(cfg.model, groups)
  const [editing, setEditing] = useState(custom)
  const selectId = useId()
  const showInput = editing || custom

  const setModel = (model: string): void => void update({ tiers: { [tier]: { model } } })

  const selectGroups = [
    { label: T.modelsTierGroup(info.label), options: groups.tier.map((id) => ({ value: id, label: id })) },
    { label: T.modelsOtherGroup, options: groups.other.map((id) => ({ value: id, label: id })) },
    { label: T.modelsCustomGroup, options: [{ value: CUSTOM, label: custom ? cfg.model : T.modelCustom }] }
  ]

  return (
    <div className="tier-row">
      <div className="tier-row-head">
        <span className={`tier-row-icon tier-row-icon--${tier}`}>
          <Icon size={16} aria-hidden="true" />
        </span>
        <div className="tier-row-name">
          <span className="tier-row-label">{info.label}</span>
          <span className="tier-row-sub">{info.subtitle}</span>
        </div>
        <span className="tier-row-resolved" title={T.resolvedNow(settings.resolvedModels[tier])}>
          {settings.resolvedModels[tier]}
        </span>
      </div>
      <div className="tier-row-controls">
        <div className="tier-row-field">
          <label className="mini-label" htmlFor={selectId}>
            {T.model}
          </label>
          <Select
            id={selectId}
            value={showInput ? CUSTOM : cfg.model}
            options={[{ value: 'auto', label: T.modelAuto }]}
            groups={selectGroups}
            onChange={(v) => {
              if (v === CUSTOM) {
                setEditing(true)
                return
              }
              setEditing(false)
              setModel(v)
            }}
          />
          {showInput && (
            <TextField
              value={cfg.model === 'auto' ? '' : cfg.model}
              mono
              label={T.modelCustom}
              placeholder={T.modelCustomPlaceholder}
              transform={(v) => v.trim()}
              onCommit={(v) => {
                if (!v) setEditing(false)
                setModel(v || 'auto')
              }}
            />
          )}
        </div>
        <div className="tier-row-field tier-row-field--effort">
          <label className="mini-label" htmlFor={`${selectId}-effort`}>
            {T.effort}
          </label>
          <Select<ReasoningEffort>
            id={`${selectId}-effort`}
            value={cfg.reasoningEffort}
            options={REASONING_EFFORTS.map((e) => ({ value: e, label: REASONING_EFFORT_LABELS[e] }))}
            onChange={(reasoningEffort) => void update({ tiers: { [tier]: { reasoningEffort } } })}
          />
        </div>
      </div>
    </div>
  )
}

function ConnectionTest(): React.JSX.Element {
  const [state, setState] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false })
  const run = async (): Promise<void> => {
    setState({ busy: true })
    try {
      const r = await api.models.test()
      setState({ busy: false, ok: r.ok, message: r.message })
    } catch (err) {
      setState({ busy: false, ok: false, message: errorMessage(err) || S.common.unknownError })
    }
  }
  return (
    <div className="conn-test">
      <button type="button" className="btn" onClick={() => void run()} disabled={state.busy}>
        {state.busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}
        {state.busy ? T.testing : T.test}
      </button>
      {state.message && (
        <span className={`conn-result${state.ok ? ' is-ok' : ' is-error'}`} role="status">
          {state.ok ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
          {state.message}
        </span>
      )}
    </div>
  )
}

export function AiTab(): React.JSX.Element {
  const settings = useLoadedSettings()
  const update = useSettings((s) => s.update)
  const [models, reload] = useModels()
  const ids = { baseUrl: useId(), apiMode: useId(), title: useId(), name: useId(), custom: useId(), key: useId() }

  const tierOptions: Option<Tier>[] = TIERS.map((t) => {
    const Icon = TIER_ICONS[t]
    return { value: t, label: TIER_INFO[t].label, icon: <Icon size={14} aria-hidden="true" /> }
  })

  const detailOptions: Option<ImageDetail>[] = (['auto', 'low', 'high', 'original'] as const).map((d) => ({
    value: d,
    label: T.imageDetailOptions[d]
  }))

  return (
    <>
      <Section title={T.keySection} description={T.keyDesc}>
        <Row label={T.keyLabel} htmlFor={ids.key} stacked>
          <KeyField
            id={ids.key}
            label={T.keyLabel}
            hasKey={settings.hasApiKey}
            hint={settings.apiKeyHint}
            placeholder={T.keyPlaceholder}
            save={(k) => api.settings.setApiKey(k)}
            clear={() => api.settings.clearApiKey()}
            savedText={T.keySaved}
            removedText={T.keyRemoved}
          />
        </Row>
        <Row label={T.baseUrl} description={T.baseUrlDesc} htmlFor={ids.baseUrl} stacked>
          <div className="inline-field">
            <TextField
              id={ids.baseUrl}
              value={settings.baseUrl}
              mono
              placeholder={DEFAULT_BASE_URL}
              transform={(v) => v.trim().replace(/\/+$/, '')}
              onCommit={(baseUrl) => void update({ baseUrl: baseUrl || DEFAULT_BASE_URL })}
            />
            {settings.baseUrl !== DEFAULT_BASE_URL && (
              <button type="button" className="btn btn--ghost" onClick={() => void update({ baseUrl: DEFAULT_BASE_URL })}>
                {T.baseUrlReset}
              </button>
            )}
          </div>
        </Row>
        <Row label={T.apiMode} htmlFor={ids.apiMode}>
          <Select<ApiMode>
            id={ids.apiMode}
            value={settings.apiMode}
            options={[
              { value: 'responses', label: T.apiModeResponses },
              { value: 'chat', label: T.apiModeChat }
            ]}
            onChange={(apiMode) => void update({ apiMode })}
          />
        </Row>
        <Row label={T.testRow} description={T.testRowDesc}>
          <ConnectionTest />
        </Row>
      </Section>

      <Section
        title={T.tiersSection}
        description={T.tiersDesc}
        actions={
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => reload(true)} disabled={models.loading} title={T.modelsRefresh}>
            <RefreshCw size={13} className={models.loading ? 'spin' : undefined} aria-hidden="true" />
            {S.common.refresh}
          </button>
        }
      >
        {models.error && !models.loading && (
          <div className="set-row">
            <Callout tone="warn" icon={<CircleAlert size={16} />}>
              {T.modelsError(models.error)}
            </Callout>
          </div>
        )}
        {TIERS.map((tier) => (
          <TierModelRow key={tier} tier={tier} models={models.models} />
        ))}
        <Row label={T.defaultTier}>
          <Segmented<Tier> label={T.defaultTier} value={settings.defaultTier} options={tierOptions} onChange={(defaultTier) => void update({ defaultTier })} />
        </Row>
        <Row label={T.voiceTier}>
          <Segmented<Tier> label={T.voiceTier} value={settings.voiceTier} options={tierOptions} onChange={(voiceTier) => void update({ voiceTier })} />
        </Row>
      </Section>

      <Section title={T.behaviorSection}>
        <ToggleRow
          label={T.webSearch}
          description={T.webSearchDesc}
          checked={settings.webSearch}
          disabled={settings.apiMode === 'chat'}
          onChange={(webSearch) => void update({ webSearch })}
        />
        <Row label={T.imageDetail} description={T.imageDetailDesc}>
          <Segmented<ImageDetail> label={T.imageDetail} value={settings.imageDetail} options={detailOptions} onChange={(imageDetail) => void update({ imageDetail })} />
        </Row>
        <Row label={T.userTitle} description={T.userTitleDesc} htmlFor={ids.title}>
          <TextField
            id={ids.title}
            value={settings.userTitle}
            placeholder={T.userTitlePlaceholder}
            maxLength={40}
            transform={(v) => v.trim()}
            onCommit={(userTitle) => void update({ userTitle })}
          />
        </Row>
        <Row label={T.userName} htmlFor={ids.name}>
          <TextField
            id={ids.name}
            value={settings.userName}
            placeholder={T.userNamePlaceholder}
            maxLength={60}
            transform={(v) => v.trim()}
            onCommit={(userName) => void update({ userName })}
          />
        </Row>
        <Row label={T.custom} description={T.customDesc} htmlFor={ids.custom} stacked>
          <TextArea id={ids.custom} value={settings.customInstructions} placeholder={T.customPlaceholder} rows={4} onCommit={(customInstructions) => void update({ customInstructions })} />
        </Row>
      </Section>
    </>
  )
}
