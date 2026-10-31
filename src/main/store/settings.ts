// SettingsStore: userData/settings.json, validated and migrated on load (electron-free).
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '@shared/defaults'
import type { Settings, SettingsPatch } from '@shared/types'
import { createLogger } from '../log'
import type { Disposer, SettingsStore } from '../services'
import { writeJsonAtomic } from '../util/fs'
import {
  cloneSettings,
  mergeSettingsPatch,
  migrateSettings,
  sanitizeSettings,
  settingsEqual,
  storedVersion
} from './settings-validate'

const log = createLogger('settings')

export interface SettingsStoreOptions {
  /** Values applied on top of the stored settings (env overrides such as JARVIS_OPENAI_BASE_URL); never persisted. */
  overrides?: Partial<Settings>
}

type Listener = (next: Settings, prev: Settings) => void

export function createSettingsStore(dir: string, opts: SettingsStoreOptions = {}): SettingsStore {
  const file = join(dir, 'settings.json')
  const listeners = new Set<Listener>()
  let stored = load()
  let effective = withOverrides(stored)

  function withOverrides(s: Settings): Settings {
    if (!opts.overrides || !Object.keys(opts.overrides).length) return s
    return sanitizeSettings({ ...s, ...opts.overrides, tiers: { ...s.tiers, ...opts.overrides.tiers } }, s)
  }

  function persist(s: Settings): void {
    try {
      writeJsonAtomic(file, s)
    } catch (err) {
      log.error('Не удалось сохранить настройки', err)
    }
  }

  function load(): Settings {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Unreadable (permissions, I/O): use defaults but do not overwrite the file.
        log.warn('settings.json is unreadable, using defaults', err)
        return cloneSettings(DEFAULT_SETTINGS)
      }
      const defaults = cloneSettings(DEFAULT_SETTINGS)
      persist(defaults)
      return defaults
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      log.warn('settings.json is corrupt, resetting to defaults', err)
      backupCorrupt()
      const defaults = cloneSettings(DEFAULT_SETTINGS)
      persist(defaults)
      return defaults
    }
    const settings = sanitizeSettings(migrateSettings(raw), DEFAULT_SETTINGS)
    // A file from a newer app version keeps its extra fields until the user changes something.
    const fromNewerVersion = storedVersion(raw) > SETTINGS_VERSION
    if (!fromNewerVersion && JSON.stringify(settings) !== JSON.stringify(raw)) persist(settings)
    return settings
  }

  function backupCorrupt(): void {
    try {
      renameSync(file, join(dir, `settings.corrupt-${Date.now()}.json`))
    } catch {
      // best effort
    }
  }

  function commit(nextStored: Settings): Settings {
    if (settingsEqual(nextStored, stored)) return cloneSettings(effective)
    const prev = effective
    stored = nextStored
    effective = withOverrides(stored)
    persist(stored)
    if (!settingsEqual(effective, prev)) {
      for (const cb of [...listeners]) {
        try {
          cb(cloneSettings(effective), cloneSettings(prev))
        } catch (err) {
          log.error('settings listener failed', err)
        }
      }
    }
    return cloneSettings(effective)
  }

  return {
    get: () => cloneSettings(effective),
    update: (patch: SettingsPatch) => commit(sanitizeSettings(mergeSettingsPatch(stored, patch), stored)),
    reset: () => commit(cloneSettings(DEFAULT_SETTINGS)),
    onChange(cb: Listener): Disposer {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
