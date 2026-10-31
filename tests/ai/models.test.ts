import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FALLBACK_TIER_MODELS } from '@shared/defaults'
import type { SettingsPatch, Tier } from '@shared/types'
import { DEFAULT_HTTP_TUNING, OpenAiClient } from '../../src/main/ai/http'
import { ModelCatalogService, compareVersions, newestTierModel } from '../../src/main/ai/models'
import { FakeSecrets, FakeSettings, memoryLog } from './helpers/fakes'
import { MockServer, json, openAiError } from './helpers/mock-server'

let server: MockServer
let dir: string
beforeAll(async () => {
  server = await MockServer.start()
})
afterAll(() => server.close())
beforeEach(() => {
  server.reset()
  dir = mkdtempSync(join(tmpdir(), 'jarvis-models-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const IDS = [
  'gpt-5.6-sol',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6.1-sol-preview',
  'gpt-6.9-terra',
  'gpt-6.10-terra',
  'gpt-5.6-luna',
  'whisper-1',
  'gpt-4o-mini-tts'
]

function catalog(
  opts: {
    settings?: SettingsPatch
    key?: string | null
    ttlMs?: number
    now?: () => number
    onResolvedChange?: (r: Record<Tier, string>) => void
  } = {}
) {
  const settings = new FakeSettings({ baseUrl: `${server.url}/v1`, ...opts.settings })
  const secrets = new FakeSecrets(opts.key === undefined ? 'sk-test-0123456789abcdef' : opts.key)
  const log = memoryLog()
  const http = new OpenAiClient({ settings, secrets, tuning: { ...DEFAULT_HTTP_TUNING, retryBaseDelayMs: 5 }, log })
  const models = new ModelCatalogService({
    http,
    settings,
    secrets,
    userDataDir: dir,
    log,
    ttlMs: opts.ttlMs,
    now: opts.now,
    autoRefresh: false,
    onResolvedChange: opts.onResolvedChange
  })
  return { models, settings, secrets, log }
}

describe('version ordering', () => {
  it('compares numerically', () => {
    expect(compareVersions('6.1', '6')).toBeGreaterThan(0)
    expect(compareVersions('6', '5.6')).toBeGreaterThan(0)
    expect(compareVersions('5.10', '5.9')).toBeGreaterThan(0)
    expect(compareVersions('6.0', '6')).toBe(0)
  })

  it('picks the highest gpt-<version>-<tier> id', () => {
    expect(newestTierModel(IDS, 'sol')).toBe('gpt-6.1-sol')
    expect(newestTierModel(IDS, 'terra')).toBe('gpt-6.10-terra')
    expect(newestTierModel(IDS, 'luna')).toBe('gpt-5.6-luna')
    expect(newestTierModel(['gpt-4o'], 'luna')).toBeNull()
  })
})

describe('ModelCatalogService', () => {
  it('falls back to FALLBACK_TIER_MODELS without a model list', () => {
    const { models } = catalog()
    expect(models.resolvedAll()).toEqual(FALLBACK_TIER_MODELS)
  })

  it('resolves auto tiers from GET /models and lets explicit models win', async () => {
    server.on('GET /v1/models', json(200, { object: 'list', data: IDS.map((id) => ({ id, object: 'model', owned_by: 'openai' })) }))
    const { models, settings } = catalog()
    const list = await models.list()
    expect(list).toEqual([...IDS].sort())
    expect(models.resolvedAll()).toEqual({ luna: 'gpt-5.6-luna', terra: 'gpt-6.10-terra', sol: 'gpt-6.1-sol' })
    settings.update({ tiers: { sol: { model: 'my-custom-model' } } })
    expect(models.resolve('sol')).toBe('my-custom-model')
  })

  it('caches the list for the TTL; force re-fetches', async () => {
    server.on('GET /v1/models', json(200, { data: [{ id: 'gpt-6-luna' }] }))
    let now = 1_000_000
    const { models } = catalog({ ttlMs: 1000, now: () => now })
    await models.list()
    await models.list()
    expect(server.requests).toHaveLength(1)
    await models.list(true)
    expect(server.requests).toHaveLength(2)
    now += 5000
    await models.list()
    expect(server.requests).toHaveLength(3)
  })

  it('deduplicates concurrent fetches', async () => {
    server.on('GET /v1/models', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 30))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] }))
    })
    const { models } = catalog()
    const [a, b] = await Promise.all([models.list(true), models.list(true)])
    expect(a).toEqual(b)
    expect(server.requests).toHaveLength(1)
  })

  it('persists to models-cache.json and resolves offline at startup even when stale', async () => {
    server.on('GET /v1/models', json(200, { data: IDS.map((id) => ({ id })) }))
    let now = 1_000_000
    await catalog({ now: () => now }).models.list()
    const file = JSON.parse(readFileSync(join(dir, 'models-cache.json'), 'utf8'))
    expect(file.models).toContain('gpt-6.1-sol')
    expect(JSON.stringify(file)).not.toContain('sk-test')

    await server.close()
    now += 10 * 60 * 60 * 1000
    const offline = catalog({ now: () => now })
    expect(offline.models.resolve('sol')).toBe('gpt-6.1-sol')
    server = await MockServer.start()
  })

  it('ignores a cache from another base URL or another key', async () => {
    server.on('GET /v1/models', json(200, { data: [{ id: 'gpt-7-sol' }] }))
    await catalog().models.list()
    expect(catalog().models.resolve('sol')).toBe('gpt-7-sol')
    expect(catalog({ settings: { baseUrl: 'https://proxy.example.com/v1' } }).models.resolve('sol')).toBe(FALLBACK_TIER_MODELS.sol)
    expect(catalog({ key: 'sk-other-key-000000000' }).models.resolve('sol')).toBe(FALLBACK_TIER_MODELS.sol)
  })

  it('survives a corrupt cache file', () => {
    writeFileSync(join(dir, 'models-cache.json'), '{not json')
    expect(catalog().models.resolve('terra')).toBe(FALLBACK_TIER_MODELS.terra)
  })

  it('refresh() never throws and skips the request without a key', async () => {
    server.on('GET /v1/models', openAiError(500, 'boom', null, 'server_error'))
    const { models, log } = catalog()
    await expect(models.refresh()).resolves.toBeUndefined()
    expect(log.lines.some((l) => l.includes('model list refresh failed'))).toBe(true)
    server.reset()
    await catalog({ key: null }).models.refresh()
    expect(server.requests).toHaveLength(0)
  })

  it('list() throws Russian errors', async () => {
    server.on('GET /v1/models', openAiError(401, 'Incorrect API key provided', 'invalid_api_key'))
    await expect(catalog().models.list(true)).rejects.toThrow(/недействителен/)
  })

  it('notifies when the resolution changed', async () => {
    server.on('GET /v1/models', json(200, { data: [{ id: 'gpt-6.2-terra' }] }))
    const changes: Record<Tier, string>[] = []
    const { models } = catalog({ onResolvedChange: (r) => changes.push(r) })
    await models.list(true)
    await models.list(true)
    expect(changes).toEqual([{ ...FALLBACK_TIER_MODELS, terra: 'gpt-6.2-terra' }])
  })
})
