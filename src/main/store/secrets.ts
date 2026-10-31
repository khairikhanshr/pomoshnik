// SecretStore: userData/secrets.json = { openaiApiKey?, elevenlabsKey? }, each value base64 of an
// OS-encrypted blob (safeStorage: Keychain / DPAPI) or "plain:<key>" when encryption is unavailable.
// Electron-free: the cipher is injected (see secret-cipher.ts).
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../log'
import type { Disposer, SecretStore } from '../services'
import { writeJsonAtomic } from '../util/fs'

const log = createLogger('secrets')

export const PLAIN_PREFIX = 'plain:'
const KEY_RE = /^[\x21-\x7e]{1,512}$/

export interface SecretCipher {
  /** false → secrets are stored with the "plain:" prefix. */
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export type SecretName = 'openaiApiKey' | 'elevenlabsKey'

export interface SecretStoreOptions {
  cipher: SecretCipher
  /** Keys injected from the environment (JARVIS_API_KEY / JARVIS_ELEVENLABS_KEY); never persisted. */
  overrides?: Partial<Record<SecretName, string | undefined>>
}

/** Masked key for the UI, e.g. "sk-…a1B2"; '' when absent. */
export function maskSecret(key: string | null | undefined): string {
  const k = (key ?? '').trim()
  if (!k) return ''
  if (k.length <= 8) return `…${k.slice(-2)}`
  const prefix = /^(sk|xi)[-_]/i.test(k) ? k.slice(0, 3) : ''
  return `${prefix}…${k.slice(-4)}`
}

/** Trims a key; '' / null → null. Throws a user-facing error for keys that cannot be valid. */
export function normalizeSecret(key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null
  if (typeof key !== 'string') throw new Error('Ключ должен быть строкой.')
  const k = key.trim()
  if (!k) return null
  if (!KEY_RE.test(k)) throw new Error('Ключ содержит недопустимые символы (пробелы или не-ASCII).')
  return k
}

export function createSecretStore(dir: string, opts: SecretStoreOptions): SecretStore {
  const file = join(dir, 'secrets.json')
  const { cipher } = opts
  const overrides = new Map<SecretName, string>()
  for (const name of ['openaiApiKey', 'elevenlabsKey'] as const) {
    const v = opts.overrides?.[name]?.trim()
    if (v) overrides.set(name, v)
  }
  const stored: Partial<Record<SecretName, string>> = readStored()
  const memo = new Map<SecretName, string | null>()
  const listeners = new Set<() => void>()

  function readStored(): Partial<Record<SecretName, string>> {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const out: Partial<Record<SecretName, string>> = {}
      if (typeof raw?.openaiApiKey === 'string' && raw.openaiApiKey) out.openaiApiKey = raw.openaiApiKey
      if (typeof raw?.elevenlabsKey === 'string' && raw.elevenlabsKey) out.elevenlabsKey = raw.elevenlabsKey
      return out
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('secrets.json is unreadable or corrupt', err)
      return {}
    }
  }

  function persist(): void {
    try {
      writeJsonAtomic(file, stored)
      try {
        chmodSync(file, 0o600)
      } catch {
        // not supported on every file system
      }
    } catch (err) {
      log.error('Не удалось сохранить ключи', err)
    }
  }

  function encode(value: string): string {
    let available = false
    try {
      available = cipher.isAvailable()
    } catch {
      available = false
    }
    if (available) {
      try {
        return cipher.encrypt(value).toString('base64')
      } catch (err) {
        log.warn('OS encryption failed, storing the key without it', err)
      }
    } else {
      log.warn('OS encryption (safeStorage) is unavailable: the key is stored without it')
    }
    return PLAIN_PREFIX + value
  }

  function decode(name: SecretName, value: string): string | null {
    if (value.startsWith(PLAIN_PREFIX)) return value.slice(PLAIN_PREFIX.length).trim() || null
    try {
      return cipher.decrypt(Buffer.from(value, 'base64')).trim() || null
    } catch (err) {
      log.error(`cannot decrypt ${name}; set the key again in Settings`, err)
      return null
    }
  }

  function get(name: SecretName): string | null {
    const override = overrides.get(name)
    if (override) return override
    if (memo.has(name)) return memo.get(name) ?? null
    const raw = stored[name]
    const value = raw ? decode(name, raw) : null
    memo.set(name, value)
    return value
  }

  function set(name: SecretName, key: string | null): void {
    const value = normalizeSecret(key)
    const hadOverride = overrides.delete(name)
    if (!hadOverride && get(name) === value) return
    memo.set(name, value)
    if (value) stored[name] = encode(value)
    else delete stored[name]
    persist()
    for (const cb of [...listeners]) {
      try {
        cb()
      } catch (err) {
        log.error('secrets listener failed', err)
      }
    }
  }

  return {
    getApiKey: () => get('openaiApiKey'),
    setApiKey: (key) => set('openaiApiKey', key),
    apiKeyHint: () => maskSecret(get('openaiApiKey')),
    getElevenLabsKey: () => get('elevenlabsKey'),
    setElevenLabsKey: (key) => set('elevenlabsKey', key),
    elevenLabsKeyHint: () => maskSecret(get('elevenlabsKey')),
    onChange(cb: () => void): Disposer {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
