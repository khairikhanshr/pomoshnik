import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSecretStore, maskSecret, normalizeSecret, type SecretCipher } from '../../src/main/store/secrets'

let dir: string

/** Reversible fake "encryption" so tests can check that stored values are not plain text. */
const fakeCipher = (available = true): SecretCipher & { decryptCalls: number } => {
  const c = {
    decryptCalls: 0,
    isAvailable: () => available,
    encrypt: (s: string) => Buffer.from(`enc:${[...s].reverse().join('')}`),
    decrypt: (b: Buffer) => {
      c.decryptCalls++
      const s = b.toString()
      if (!s.startsWith('enc:')) throw new Error('bad blob')
      return [...s.slice(4)].reverse().join('')
    }
  }
  return c
}

const readFile = (): Record<string, string> => JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-secrets-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('maskSecret / normalizeSecret', () => {
  it('masks keys', () => {
    expect(maskSecret('sk-proj-abcdefghijklmnopa1B2')).toBe('sk-…a1B2')
    expect(maskSecret('0123456789abcdef0123456789abcdef')).toBe('…cdef')
    expect(maskSecret('short')).toBe('…rt')
    expect(maskSecret('')).toBe('')
    expect(maskSecret(null)).toBe('')
  })

  it('normalizes and validates keys', () => {
    expect(normalizeSecret('  sk-abc  ')).toBe('sk-abc')
    expect(normalizeSecret('   ')).toBeNull()
    expect(normalizeSecret(null)).toBeNull()
    expect(() => normalizeSecret('sk-abc def')).toThrow()
    expect(() => normalizeSecret('ключ')).toThrow()
  })
})

describe('createSecretStore', () => {
  it('encrypts both keys at rest and reads them back', () => {
    const store = createSecretStore(dir, { cipher: fakeCipher() })
    const changes = vi.fn()
    store.onChange(changes)
    store.setApiKey(' sk-test-1234567890 ')
    store.setElevenLabsKey('xi-eleven-0987654321')
    expect(changes).toHaveBeenCalledTimes(2)
    expect(store.getApiKey()).toBe('sk-test-1234567890')
    expect(store.apiKeyHint()).toBe('sk-…7890')
    expect(store.elevenLabsKeyHint()).toBe('xi-…4321')

    const raw = readFile()
    expect(raw.openaiApiKey).not.toContain('sk-test')
    expect(Buffer.from(raw.openaiApiKey, 'base64').toString()).toMatch(/^enc:/)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600)

    const cipher = fakeCipher()
    const reopened = createSecretStore(dir, { cipher })
    expect(cipher.decryptCalls).toBe(0) // decrypted lazily
    expect(reopened.getApiKey()).toBe('sk-test-1234567890')
    expect(reopened.getElevenLabsKey()).toBe('xi-eleven-0987654321')
    expect(reopened.getApiKey()).toBe('sk-test-1234567890')
    expect(cipher.decryptCalls).toBe(2)
  })

  it('falls back to plain storage when encryption is unavailable', () => {
    const store = createSecretStore(dir, { cipher: fakeCipher(false) })
    store.setApiKey('sk-plain-123456789')
    expect(readFile().openaiApiKey).toBe('plain:sk-plain-123456789')
    expect(createSecretStore(dir, { cipher: fakeCipher(false) }).getApiKey()).toBe('sk-plain-123456789')
  })

  it('removes keys and ignores no-op updates', () => {
    const store = createSecretStore(dir, { cipher: fakeCipher() })
    const changes = vi.fn()
    store.onChange(changes)
    store.setApiKey('sk-remove-me-12345')
    store.setApiKey('sk-remove-me-12345')
    expect(changes).toHaveBeenCalledTimes(1)
    store.setApiKey('')
    expect(store.getApiKey()).toBeNull()
    expect(store.apiKeyHint()).toBe('')
    expect(readFile()).toEqual({})
    store.setElevenLabsKey(null)
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('uses environment overrides without persisting them', () => {
    const store = createSecretStore(dir, {
      cipher: fakeCipher(),
      overrides: { openaiApiKey: 'sk-env-123456789', elevenlabsKey: ' ' }
    })
    expect(store.getApiKey()).toBe('sk-env-123456789')
    expect(store.getElevenLabsKey()).toBeNull()
    expect(() => readFile()).toThrow()

    // An explicit key from the user replaces the injected one and is persisted.
    store.setApiKey('sk-user-987654321')
    expect(store.getApiKey()).toBe('sk-user-987654321')
    expect(createSecretStore(dir, { cipher: fakeCipher() }).getApiKey()).toBe('sk-user-987654321')
  })

  it('tolerates corrupt files and undecryptable values', () => {
    writeFileSync(join(dir, 'secrets.json'), '{oops')
    expect(createSecretStore(dir, { cipher: fakeCipher() }).getApiKey()).toBeNull()
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ openaiApiKey: Buffer.from('garbage').toString('base64') }))
    const store = createSecretStore(dir, { cipher: fakeCipher() })
    expect(store.getApiKey()).toBeNull()
    expect(store.apiKeyHint()).toBe('')
    expect(() => store.setApiKey('bad key with spaces')).toThrow()
  })
})
