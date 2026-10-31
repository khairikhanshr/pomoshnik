// Pure validation / migration of persisted settings and settings patches (electron-free, unit-tested).
import { DEFAULT_SETTINGS, REASONING_EFFORTS, SETTINGS_VERSION } from '@shared/defaults'
import { TIERS } from '@shared/types'
import type { Settings, Tier, TierConfig } from '@shared/types'

type Raw = Record<string, unknown>
type ValidatedKey = Exclude<keyof Settings, 'version' | 'tiers'>
type Validator<T> = (value: unknown, fallback: T) => T

export const MAX_WAKE_PHRASES = 10

export function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function oneOf<T extends string>(values: readonly T[]): Validator<T> {
  return (value, fallback) =>
    typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback
}

const bool: Validator<boolean> = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

function num(min: number, max: number, integer = false): Validator<number> {
  return (value, fallback) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return clamp(integer ? Math.round(value) : value, min, max)
  }
}

interface TextRule {
  maxLength: number
  /** Default true. */
  trim?: boolean
  nonEmpty?: boolean
  pattern?: RegExp
  lowerCase?: boolean
}

function text(rule: TextRule): Validator<string> {
  return (value, fallback) => {
    if (typeof value !== 'string') return fallback
    let s = rule.trim === false ? value : value.trim()
    if (rule.lowerCase) s = s.toLowerCase()
    if (s.length > rule.maxLength) {
      // Free text is truncated; identifiers that are too long are invalid.
      if (rule.pattern || rule.nonEmpty) return fallback
      s = s.slice(0, rule.maxLength)
    }
    if (rule.nonEmpty && !s) return fallback
    if (rule.pattern && !rule.pattern.test(s)) return fallback
    return s
  }
}

const baseUrl: Validator<string> = (value, fallback) => {
  if (typeof value !== 'string') return fallback
  const s = value.trim().replace(/\/+$/, '')
  if (!s || s.length > 500) return fallback
  try {
    const url = new URL(s)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
  } catch {
    return fallback
  }
  return s
}

const wakePhrases: Validator<string[]> = (value, fallback) => {
  if (!Array.isArray(value)) return [...fallback]
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const phrase = item.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!phrase || phrase.length > 40 || out.includes(phrase)) continue
    out.push(phrase)
    if (out.length >= MAX_WAKE_PHRASES) break
  }
  return out.length ? out : [...fallback]
}

/** Model ids: 'auto' or any token without whitespace (proxies use ids like "openai/gpt-5" or "llama3:8b"). */
const modelId: Validator<string> = (value, fallback) => {
  if (typeof value !== 'string') return fallback
  const s = value.trim()
  if (s.toLowerCase() === 'auto') return 'auto'
  return /^\S{1,200}$/.test(s) ? s : fallback
}

const reasoningEffort = oneOf(REASONING_EFFORTS)

function tiers(value: unknown, fallback: Record<Tier, TierConfig>): Record<Tier, TierConfig> {
  const src = isRecord(value) ? value : {}
  const out = {} as Record<Tier, TierConfig>
  for (const tier of TIERS) {
    const raw = isRecord(src[tier]) ? (src[tier] as Raw) : {}
    out[tier] = {
      model: modelId(raw.model, fallback[tier].model),
      reasoningEffort: reasoningEffort(raw.reasoningEffort, fallback[tier].reasoningEffort)
    }
  }
  return out
}

const tier = oneOf(TIERS)
const shortName = text({ maxLength: 100, nonEmpty: true, pattern: /^\S+$/ })

const VALIDATORS: { [K in ValidatedKey]: Validator<Settings[K]> } = {
  baseUrl,
  apiMode: oneOf(['responses', 'chat'] as const),
  defaultTier: tier,
  voiceTier: tier,
  webSearch: bool,
  imageDetail: oneOf(['auto', 'low', 'high', 'original'] as const),
  customInstructions: text({ maxLength: 20_000, trim: false }),
  userTitle: text({ maxLength: 60, nonEmpty: true }),
  userName: text({ maxLength: 80 }),

  sttModel: shortName,
  sttLanguage: text({ maxLength: 3, lowerCase: true, pattern: /^([a-z]{2,3})?$/ }),

  ttsProvider: oneOf(['openai', 'elevenlabs', 'system'] as const),
  ttsModel: shortName,
  ttsVoice: shortName,
  ttsInstructions: text({ maxLength: 4000, trim: false }),
  ttsSpeed: num(0.5, 2),
  elevenVoiceId: text({ maxLength: 64, pattern: /^[A-Za-z0-9]{0,64}$/ }),
  elevenModel: text({ maxLength: 100, nonEmpty: true, pattern: /^[A-Za-z0-9_.-]+$/ }),
  elevenStability: num(0, 1),
  elevenSimilarity: num(0, 1),
  systemVoiceName: text({ maxLength: 200 }),
  speakMode: oneOf(['voice', 'always', 'never'] as const),
  maxSpokenChars: num(100, 5000, true),

  wakeEngine: oneOf(['local', 'cloud', 'off'] as const),
  wakePhrases,
  wakeSensitivity: oneOf(['low', 'medium', 'high'] as const),
  micDeviceId: text({ maxLength: 512 }),
  followUpSeconds: num(0, 30),
  commandTimeoutSeconds: num(3, 30),
  acknowledge: oneOf(['chime', 'voice', 'both'] as const),

  hotkeyVoice: text({ maxLength: 100 }),
  hotkeyWindow: text({ maxLength: 100 }),

  computerControl: bool,
  confirmDangerous: bool,
  allowShellCommands: bool,

  launchAtLogin: bool,
  startHidden: bool,
  showOverlay: bool,
  overlayPosition: oneOf(['top-right', 'top-center', 'bottom-center', 'bottom-right'] as const),
  showInDock: bool
}

const VALIDATED_KEYS = Object.keys(VALIDATORS) as ValidatedKey[]

function applyField<K extends ValidatedKey>(out: Settings, key: K, src: Raw, fallback: Settings): void {
  out[key] = VALIDATORS[key](src[key], fallback[key])
}

export function cloneSettings(settings: Settings): Settings {
  return structuredClone(settings)
}

/**
 * Returns a complete, valid Settings object. Unknown keys are dropped, invalid values are replaced
 * by the corresponding `fallback` value (defaults when loading, the current settings for patches).
 */
export function sanitizeSettings(raw: unknown, fallback: Settings = DEFAULT_SETTINGS): Settings {
  const src = isRecord(raw) ? raw : {}
  const out = { version: SETTINGS_VERSION, tiers: tiers(src.tiers, fallback.tiers) } as Settings
  for (const key of VALIDATED_KEYS) applyField(out, key, src, fallback)
  return out
}

const MIGRATIONS: Record<number, (s: Raw) => Raw> = {
  // Files written before settings were versioned have the v1 shape without "version".
  0: (s) => ({ ...s, version: 1 })
}

export function storedVersion(raw: unknown): number {
  const v = isRecord(raw) ? raw.version : undefined
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
}

/** Upgrades an older settings object step by step to SETTINGS_VERSION (newer versions are left as is). */
export function migrateSettings(raw: unknown): Raw {
  let s: Raw = isRecord(raw) ? { ...raw } : {}
  for (let v = storedVersion(raw); v < SETTINGS_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (step) s = step(s)
  }
  return s
}

/** Shallow merge of a patch into the current settings (tiers merged per tier). `version` is not patchable. */
export function mergeSettingsPatch(current: Settings, patch: unknown): Raw {
  const merged: Raw = { ...current }
  if (!isRecord(patch)) return merged
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'version' || key === 'tiers' || !Object.hasOwn(DEFAULT_SETTINGS, key)) continue
    merged[key] = value
  }
  if (isRecord(patch.tiers)) {
    const nextTiers: Raw = {}
    for (const t of TIERS) {
      const p = patch.tiers[t]
      nextTiers[t] = isRecord(p) ? { ...current.tiers[t], ...p } : current.tiers[t]
    }
    merged.tiers = nextTiers
  }
  return merged
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
