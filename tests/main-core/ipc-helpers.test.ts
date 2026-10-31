import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, FALLBACK_TIER_MODELS } from '@shared/defaults'
import { buildPublicSettings, toPlatform } from '../../src/main/ipc/public-settings'
import { buildReplayChunks } from '../../src/main/ipc/replay'
import { createThrottle } from '../../src/main/ipc/throttle'
import {
  asBinary,
  asMime,
  asNavigate,
  asSendRequest,
  asSettingsPatch,
  asText,
  asTitle,
  asVoicePhaseReport,
  isAudioMime,
  isImageMime,
  MAX_IMAGE_BYTES
} from '../../src/main/ipc/validate'
import { isSafeExternalUrl, isAppUrl, appOrigins, rendererBaseUrl } from '../../src/main/app/urls'

describe('validate', () => {
  it('validates send requests', () => {
    expect(asSendRequest({ text: 'Привет', tier: 'sol', speak: true, chatId: 'abc123', images: ['u1', 'u1'] })).toEqual({
      text: 'Привет',
      tier: 'sol',
      speak: true,
      chatId: 'abc123',
      images: ['u1']
    })
    expect(asSendRequest({ text: '', images: ['s1'] })).toEqual({ text: '', images: ['s1'] })
    expect(() => asSendRequest({ text: '   ' })).toThrow('Пустое сообщение')
    expect(() => asSendRequest({ text: 'x'.repeat(100_001) })).toThrow(/слишком длинный/)
    expect(() => asSendRequest({ text: 'x', tier: 'mars' })).toThrow()
    expect(() => asSendRequest({ text: 'x', chatId: '../evil' })).toThrow()
    expect(() => asSendRequest({ text: 'x', images: ['../../etc/passwd'] })).toThrow()
    expect(() => asSendRequest({ text: 'x', images: Array.from({ length: 11 }, (_, i) => `u${i}`) })).toThrow()
    expect(() => asSendRequest('text')).toThrow()
  })

  it('enforces binary size limits', () => {
    expect(asBinary(new Uint8Array([1, 2, 3]).buffer, 10, 'big')).toEqual(Buffer.from([1, 2, 3]))
    expect(asBinary(new Uint8Array([1, 2, 3, 4]).subarray(1, 3), 10, 'big')).toEqual(Buffer.from([2, 3]))
    expect(() => asBinary(new ArrayBuffer(11), 10, 'слишком большое')).toThrow('слишком большое')
    expect(() => asBinary(new ArrayBuffer(0), 10, 'big')).toThrow('Пустые данные')
    expect(() => asBinary('data', 10, 'big')).toThrow()
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024)
  })

  it('validates mime types, text, titles and patches', () => {
    expect(asMime('audio/webm;codecs=opus', isAudioMime, 'аудио')).toBe('audio/webm;codecs=opus')
    expect(asMime('Video/WebM', isAudioMime, 'аудио')).toBe('video/webm')
    expect(() => asMime('text/html', isAudioMime, 'аудио')).toThrow()
    expect(asMime('image/webp', isImageMime, 'изображения')).toBe('image/webp')
    expect(() => asMime('<script>', isImageMime, 'изображения')).toThrow()
    expect(() => asText(5)).toThrow()
    expect(() => asText(' ', { allowEmpty: false })).toThrow()
    expect(asTitle('  Новый   план  ')).toBe('Новый план')
    expect(() => asTitle('   ')).toThrow()
    expect(asSettingsPatch({ webSearch: false })).toEqual({ webSearch: false })
    expect(() => asSettingsPatch(null)).toThrow()
    expect(() => asSettingsPatch({ customInstructions: 'x'.repeat(300_000) })).toThrow()
  })

  it('sanitizes navigation and voice reports', () => {
    expect(asNavigate({ view: 'settings', settingsTab: 'voice', chatId: '../x', junk: 1 })).toEqual({
      view: 'settings',
      settingsTab: 'voice'
    })
    expect(asNavigate(undefined)).toBeUndefined()
    for (const tab of ['ai', 'voice', 'activation', 'computer', 'general', 'about']) {
      expect(asNavigate({ view: 'settings', settingsTab: tab })).toEqual({ view: 'settings', settingsTab: tab })
    }
    // Ids the settings view does not know are dropped.
    expect(asNavigate({ view: 'settings', settingsTab: 'openai' })).toEqual({ view: 'settings' })
    expect(asNavigate({ settingsTab: 'Voice' })).toEqual({})
    expect(asVoicePhaseReport({ phase: 'listening', wakeActive: true, engineError: null })).toEqual({
      phase: 'listening',
      wakeActive: true,
      engineError: null
    })
    expect(asVoicePhaseReport({ phase: 'dancing' })).toBeNull()
    expect(asVoicePhaseReport(null)).toBeNull()
  })
})

describe('urls', () => {
  it('allows only http(s) and mailto externally', () => {
    expect(isSafeExternalUrl('https://openai.com')).toBe(true)
    expect(isSafeExternalUrl('mailto:a@b.c')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('x-apple.systempreferences:foo')).toBe(false)
    expect(isSafeExternalUrl(42)).toBe(false)
  })

  it('recognizes our own origins', () => {
    const origins = appOrigins('http://localhost:5173/')
    expect(origins).toEqual(['app://jarvis', 'http://localhost:5173'])
    expect(isAppUrl('app://jarvis/index.html?window=main', origins)).toBe(true)
    expect(isAppUrl('http://localhost:5173/overlay.html', origins)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', origins)).toBe(false)
    expect(isAppUrl('app://evil/index.html', origins)).toBe(false)
    expect(isAppUrl('https://example.com', appOrigins())).toBe(false)
    expect(rendererBaseUrl()).toBe('app://jarvis')
    expect(rendererBaseUrl('http://localhost:5173/')).toBe('http://localhost:5173')
  })
})

describe('buildPublicSettings', () => {
  it('adds derived info without exposing keys', () => {
    const pub = buildPublicSettings({
      settings: DEFAULT_SETTINGS,
      secrets: {
        getApiKey: () => 'sk-secret-123456789',
        apiKeyHint: () => 'sk-…6789',
        getElevenLabsKey: () => null,
        elevenLabsKeyHint: () => ''
      },
      resolvedModels: () => ({ luna: 'gpt-6-luna', terra: '', sol: 7 as unknown as string }),
      platform: 'darwin',
      appVersion: '1.0.0'
    })
    expect(pub).toMatchObject({
      hasApiKey: true,
      apiKeyHint: 'sk-…6789',
      hasElevenLabsKey: false,
      elevenLabsKeyHint: '',
      platform: 'darwin',
      appVersion: '1.0.0',
      resolvedModels: { luna: 'gpt-6-luna', terra: FALLBACK_TIER_MODELS.terra, sol: FALLBACK_TIER_MODELS.sol }
    })
    expect(JSON.stringify(pub)).not.toContain('sk-secret')
    expect(toPlatform('freebsd')).toBe('linux')
  })

  it('survives a throwing model catalog', () => {
    const pub = buildPublicSettings({
      settings: DEFAULT_SETTINGS,
      secrets: { getApiKey: () => null, apiKeyHint: () => '', getElevenLabsKey: () => null, elevenLabsKeyHint: () => '' },
      resolvedModels: () => {
        throw new Error('boom')
      },
      platform: 'win32',
      appVersion: '1.0.0'
    })
    expect(pub.resolvedModels).toEqual(FALLBACK_TIER_MODELS)
    expect(pub.hasApiKey).toBe(false)
  })
})

describe('createThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('limits the rate and always delivers the latest value', () => {
    const seen: number[] = []
    const t = createThrottle<number>(50, (v) => seen.push(v))
    for (let i = 0; i < 100; i++) {
      t.push(i)
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(100)
    expect(seen[0]).toBe(0)
    expect(seen[seen.length - 1]).toBe(99)
    expect(seen.length).toBeLessThanOrEqual(11)
    t.push(1000)
    t.push(1001)
    t.cancel()
    vi.advanceTimersByTime(100)
    expect(seen[seen.length - 1]).toBe(1000)
  })
})

describe('buildReplayChunks', () => {
  it('produces ordered chunks of one synthetic turn ending with final', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Предложение номер ${i + 1} про погоду.`).join(' ')
    const chunks = buildReplayChunks(text, 'replay-1')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i))
    expect(chunks.every((c) => c.turnId === 'replay-1')).toBe(true)
    expect(chunks.filter((c) => c.final)).toHaveLength(1)
    expect(chunks[chunks.length - 1].final).toBe(true)
    expect(chunks[0].text.length).toBeLessThanOrEqual(400)
    expect(chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ')).toContain('Предложение номер 30')
    expect(buildReplayChunks('   ', 'replay-2')).toEqual([])
  })
})
