import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { createSettingsStore } from '../../src/main/store/settings'
import { mergeSettingsPatch, migrateSettings, sanitizeSettings } from '../../src/main/store/settings-validate'

let dir: string
const file = (): string => join(dir, 'settings.json')
const readFile = (): Settings => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-settings-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('sanitizeSettings', () => {
  it('returns complete defaults for garbage input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
  })

  it('drops unknown keys and replaces wrong types with defaults', () => {
    const s = sanitizeSettings({
      bogus: 1,
      webSearch: 'yes',
      ttsSpeed: '1.5',
      apiMode: 'graphql',
      defaultTier: 'mars',
      wakePhrases: 'джарвис',
      tiers: { luna: { model: 42, reasoningEffort: 'extreme' }, terra: 'x' }
    })
    expect(s).not.toHaveProperty('bogus')
    expect(s.webSearch).toBe(DEFAULT_SETTINGS.webSearch)
    expect(s.ttsSpeed).toBe(DEFAULT_SETTINGS.ttsSpeed)
    expect(s.apiMode).toBe('responses')
    expect(s.defaultTier).toBe(DEFAULT_SETTINGS.defaultTier)
    expect(s.wakePhrases).toEqual(DEFAULT_SETTINGS.wakePhrases)
    expect(s.tiers).toEqual(DEFAULT_SETTINGS.tiers)
  })

  it('clamps numbers', () => {
    const hi = sanitizeSettings({ ttsSpeed: 5, followUpSeconds: 100, commandTimeoutSeconds: 99, maxSpokenChars: 99999 })
    expect([hi.ttsSpeed, hi.followUpSeconds, hi.commandTimeoutSeconds, hi.maxSpokenChars]).toEqual([2, 30, 30, 5000])
    const lo = sanitizeSettings({ ttsSpeed: 0.1, followUpSeconds: -3, commandTimeoutSeconds: 1, maxSpokenChars: 10 })
    expect([lo.ttsSpeed, lo.followUpSeconds, lo.commandTimeoutSeconds, lo.maxSpokenChars]).toEqual([0.5, 0, 3, 100])
    expect(sanitizeSettings({ maxSpokenChars: 123.6 }).maxSpokenChars).toBe(124)
    expect(sanitizeSettings({ ttsSpeed: Number.NaN }).ttsSpeed).toBe(DEFAULT_SETTINGS.ttsSpeed)
    expect(sanitizeSettings({ followUpSeconds: Number.POSITIVE_INFINITY }).followUpSeconds).toBe(
      DEFAULT_SETTINGS.followUpSeconds
    )
  })

  it('normalizes baseUrl', () => {
    expect(sanitizeSettings({ baseUrl: '  https://proxy.example.com/v1///  ' }).baseUrl).toBe(
      'https://proxy.example.com/v1'
    )
    expect(sanitizeSettings({ baseUrl: 'ftp://x' }).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
    expect(sanitizeSettings({ baseUrl: 'not a url' }).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
    expect(sanitizeSettings({ baseUrl: '   ' }).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
  })

  it('normalizes wake phrases', () => {
    const s = sanitizeSettings({ wakePhrases: ['  Джарвис ', 'JARVIS', '', 7, 'джарвис', '  Эй   Джарвис '] })
    expect(s.wakePhrases).toEqual(['джарвис', 'jarvis', 'эй джарвис'])
    const many = Array.from({ length: 15 }, (_, i) => `слово${i}`)
    expect(sanitizeSettings({ wakePhrases: many }).wakePhrases).toHaveLength(10)
    expect(sanitizeSettings({ wakePhrases: ['  ', ''] }).wakePhrases).toEqual(DEFAULT_SETTINGS.wakePhrases)
  })

  it('validates ElevenLabs and TTS fields', () => {
    const s = sanitizeSettings({
      ttsProvider: 'elevenlabs',
      elevenVoiceId: '  21m00Tcm4TlvDq8ikWAM  ',
      elevenStability: 1.7,
      elevenSimilarity: -0.2,
      elevenModel: 'eleven_flash_v2_5'
    })
    expect(s.ttsProvider).toBe('elevenlabs')
    expect(s.elevenVoiceId).toBe('21m00Tcm4TlvDq8ikWAM')
    expect(s.elevenStability).toBe(1)
    expect(s.elevenSimilarity).toBe(0)
    expect(s.elevenModel).toBe('eleven_flash_v2_5')

    expect(sanitizeSettings({ ttsProvider: 'azure' }).ttsProvider).toBe('openai')
    expect(sanitizeSettings({ ttsProvider: 'system' }).ttsProvider).toBe('system')
    expect(sanitizeSettings({ elevenVoiceId: 'voice id!' }).elevenVoiceId).toBe('')
    expect(sanitizeSettings({ elevenVoiceId: 'a'.repeat(65) }).elevenVoiceId).toBe('')
    expect(sanitizeSettings({ elevenVoiceId: 'a'.repeat(64) }).elevenVoiceId).toBe('a'.repeat(64))
    expect(sanitizeSettings({ elevenModel: '' }).elevenModel).toBe(DEFAULT_SETTINGS.elevenModel)
  })

  it('validates tiers, languages and text fields', () => {
    const s = sanitizeSettings({
      tiers: { sol: { model: ' gpt-6-sol ', reasoningEffort: 'high' }, luna: { model: 'AUTO' } },
      sttLanguage: 'RU',
      userTitle: '   ',
      customInstructions: 'x'.repeat(30_000)
    })
    expect(s.tiers.sol).toEqual({ model: 'gpt-6-sol', reasoningEffort: 'high' })
    expect(s.tiers.luna).toEqual({ model: 'auto', reasoningEffort: DEFAULT_SETTINGS.tiers.luna.reasoningEffort })
    expect(s.tiers.terra).toEqual(DEFAULT_SETTINGS.tiers.terra)
    expect(s.sttLanguage).toBe('ru')
    expect(s.userTitle).toBe(DEFAULT_SETTINGS.userTitle)
    expect(s.customInstructions).toHaveLength(20_000)
    expect(sanitizeSettings({ sttLanguage: 'ru-RU' }).sttLanguage).toBe('')
    expect(sanitizeSettings({ tiers: { sol: { model: 'has space' } } }).tiers.sol.model).toBe('auto')
  })
})

describe('migrateSettings / mergeSettingsPatch', () => {
  it('upgrades unversioned files to the current version', () => {
    const migrated = migrateSettings({ webSearch: false })
    expect(migrated.version).toBe(SETTINGS_VERSION)
    expect(migrated.webSearch).toBe(false)
  })

  it('merges tiers per tier and ignores version / prototype keys', () => {
    const patch = JSON.parse('{"version": 99, "__proto__": {"polluted": true}, "tiers": {"sol": {"model": "gpt-6-sol"}}}')
    const merged = mergeSettingsPatch(DEFAULT_SETTINGS, patch)
    expect(merged.version).toBe(DEFAULT_SETTINGS.version)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(merged.tiers).toEqual({
      ...DEFAULT_SETTINGS.tiers,
      sol: { model: 'gpt-6-sol', reasoningEffort: DEFAULT_SETTINGS.tiers.sol.reasoningEffort }
    })
  })
})

describe('createSettingsStore', () => {
  it('creates settings.json with defaults on first run', () => {
    const store = createSettingsStore(dir)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(readFile()).toEqual(DEFAULT_SETTINGS)
  })

  it('recovers from a corrupt file and keeps a backup', () => {
    writeFileSync(file(), '{ not json')
    const store = createSettingsStore(dir)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(readdirSync(dir).some((f) => f.startsWith('settings.corrupt-'))).toBe(true)
    expect(readFile()).toEqual(DEFAULT_SETTINGS)
  })

  it('migrates and rewrites an old file on load', () => {
    writeFileSync(file(), JSON.stringify({ webSearch: false, ttsSpeed: 9, junk: true }))
    const store = createSettingsStore(dir)
    expect(store.get().webSearch).toBe(false)
    expect(store.get().ttsSpeed).toBe(2)
    const onDisk = readFile() as Settings & { junk?: boolean }
    expect(onDisk.version).toBe(SETTINGS_VERSION)
    expect(onDisk.junk).toBeUndefined()
    expect(onDisk.ttsSpeed).toBe(2)
  })

  it('does not overwrite a file written by a newer version on load', () => {
    const newer = JSON.stringify({ ...DEFAULT_SETTINGS, version: SETTINGS_VERSION + 1, futureField: 1 })
    writeFileSync(file(), newer)
    const store = createSettingsStore(dir)
    expect(store.get().version).toBe(SETTINGS_VERSION)
    expect(readFileSync(file(), 'utf8')).toBe(newer)
  })

  it('updates, validates, persists and notifies', () => {
    const store = createSettingsStore(dir)
    const seen: Array<[Settings, Settings]> = []
    const off = store.onChange((next, prev) => seen.push([next, prev]))

    const next = store.update({
      ttsSpeed: 1.25,
      defaultTier: 'sol',
      ttsVoice: 42 as unknown as string,
      tiers: { luna: { model: 'gpt-6-luna' } },
      unknownKey: 'x'
    } as never)
    expect(next.ttsSpeed).toBe(1.25)
    expect(next.defaultTier).toBe('sol')
    expect(next.ttsVoice).toBe(DEFAULT_SETTINGS.ttsVoice)
    expect(next.tiers.luna).toEqual({ model: 'gpt-6-luna', reasoningEffort: 'low' })
    expect(next).not.toHaveProperty('unknownKey')
    expect(seen).toHaveLength(1)
    expect(seen[0][0].defaultTier).toBe('sol')
    expect(seen[0][1].defaultTier).toBe(DEFAULT_SETTINGS.defaultTier)

    expect(createSettingsStore(dir).get().tiers.luna.model).toBe('gpt-6-luna')

    store.update({ ttsSpeed: 1.25 })
    expect(seen).toHaveLength(1)

    // Invalid patch values keep the current value (not the default).
    store.update({ ttsProvider: 'elevenlabs' })
    expect(store.update({ ttsProvider: 'nope' as never }).ttsProvider).toBe('elevenlabs')

    off()
    store.update({ webSearch: false })
    expect(seen).toHaveLength(2)
  })

  it('isolates listener failures and returns copies', () => {
    const store = createSettingsStore(dir)
    const good = vi.fn()
    store.onChange(() => {
      throw new Error('boom')
    })
    store.onChange(good)
    store.update({ userName: 'Тони' })
    expect(good).toHaveBeenCalledOnce()

    const copy = store.get()
    copy.wakePhrases.push('mutated')
    copy.tiers.sol.model = 'mutated'
    expect(store.get().wakePhrases).toEqual(DEFAULT_SETTINGS.wakePhrases)
    expect(store.get().tiers.sol.model).toBe('auto')
  })

  it('resets to defaults', () => {
    const store = createSettingsStore(dir)
    store.update({ showOverlay: false, wakePhrases: ['пятница'] })
    const cb = vi.fn()
    store.onChange(cb)
    expect(store.reset()).toEqual(DEFAULT_SETTINGS)
    expect(cb).toHaveBeenCalledOnce()
    expect(readFile()).toEqual(DEFAULT_SETTINGS)
  })

  it('applies overrides without persisting them', () => {
    const store = createSettingsStore(dir, { overrides: { baseUrl: 'http://127.0.0.1:9999/v1/' } })
    expect(store.get().baseUrl).toBe('http://127.0.0.1:9999/v1')
    expect(readFile().baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)

    const cb = vi.fn()
    store.onChange(cb)
    store.update({ baseUrl: 'https://other.example.com/v1' })
    expect(store.get().baseUrl).toBe('http://127.0.0.1:9999/v1')
    expect(readFile().baseUrl).toBe('https://other.example.com/v1')
    expect(cb).not.toHaveBeenCalled()
    expect(existsSync(file())).toBe(true)
  })
})
