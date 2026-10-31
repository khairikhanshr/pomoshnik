// ModelCatalog: GET /models cached for 1 h (memory + userData/models-cache.json) and tier → model resolution.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { FALLBACK_TIER_MODELS, TIER_MODEL_PATTERN } from '@shared/defaults'
import { TIERS, type Tier } from '@shared/types'
import type { Logger } from '../log'
import type { ModelCatalog, SecretStore, SettingsStore } from '../services'
import { readJson, writeJsonAtomic } from '../util/fs'
import { AiError, OPENAI_MESSAGES, userMessage } from './errors'
import type { OpenAiClient } from './http'

export const MODELS_CACHE_FILE = 'models-cache.json'
const DEFAULT_TTL_MS = 60 * 60 * 1000
/** Minimum pause between background refreshes triggered by resolve(). */
const AUTO_REFRESH_GAP_MS = 5 * 60 * 1000
const LIST_TIMEOUT_MS = 30_000

interface CacheEntry {
  version: 1
  baseUrl: string
  /** Truncated SHA-256 of the API key: a list fetched with another key is not reused. */
  keyId: string
  fetchedAt: number
  models: string[]
}

export interface ModelCatalogDeps {
  http: OpenAiClient
  settings: SettingsStore
  secrets: SecretStore
  userDataDir: string
  log: Logger
  ttlMs?: number
  /** resolve() starts a background refresh when the cache is stale (default true). */
  autoRefresh?: boolean
  /** Fired when the tier → model resolution changed after a fetch. */
  onResolvedChange?: (resolved: Record<Tier, string>) => void
  now?: () => number
}

/** Numeric dotted-version compare: 6.1 > 6 > 5.6, 5.10 > 5.9. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number(p) || 0)
  const pb = b.split('.').map((p) => Number(p) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Highest-version `gpt-<version>-<tier>` id, or null. */
export function newestTierModel(ids: readonly string[], tier: Tier): string | null {
  let best: { id: string; version: string } | null = null
  for (const id of ids) {
    const m = TIER_MODEL_PATTERN.exec(id)
    if (!m || m[2] !== tier) continue
    if (!best || compareVersions(m[1], best.version) > 0) best = { id, version: m[1] }
  }
  return best?.id ?? null
}

export class ModelCatalogService implements ModelCatalog {
  private cache: CacheEntry | null
  private inflight: Promise<string[]> | null = null
  private lastAutoRefresh = 0
  private keyMemo: { key: string; id: string } | null = null
  private readonly file: string
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly deps: ModelCatalogDeps) {
    this.file = join(deps.userDataDir, MODELS_CACHE_FILE)
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
    this.now = deps.now ?? Date.now
    this.cache = this.load()
  }

  async list(force = false): Promise<string[]> {
    const cur = this.usableCache()
    if (!force && cur && this.now() - cur.fetchedAt < this.ttlMs) return [...cur.models]
    return this.fetchModels()
  }

  resolve(tier: Tier): string {
    const explicit = this.explicitModel(tier)
    if (explicit) return explicit
    this.maybeAutoRefresh()
    return this.resolveFrom(this.usableCache(), tier)
  }

  resolvedAll(): Record<Tier, string> {
    const out = {} as Record<Tier, string>
    for (const tier of TIERS) out[tier] = this.resolve(tier)
    return out
  }

  async refresh(): Promise<void> {
    if (!this.deps.http.hasKey()) return
    try {
      await this.fetchModels()
    } catch (err) {
      this.deps.log.warn(`model list refresh failed: ${userMessage(err)}`)
    }
  }

  private explicitModel(tier: Tier): string | null {
    const model = this.deps.settings.get().tiers?.[tier]?.model?.trim()
    return model && model.toLowerCase() !== 'auto' ? model : null
  }

  private resolveFrom(cache: CacheEntry | null, tier: Tier): string {
    return this.explicitModel(tier) ?? (cache && newestTierModel(cache.models, tier)) ?? FALLBACK_TIER_MODELS[tier]
  }

  private resolveAllFrom(cache: CacheEntry | null): Record<Tier, string> {
    const out = {} as Record<Tier, string>
    for (const tier of TIERS) out[tier] = this.resolveFrom(cache, tier)
    return out
  }

  private keyId(): string {
    const key = this.deps.secrets.getApiKey()?.trim() ?? ''
    if (!key) return ''
    if (this.keyMemo?.key !== key) {
      this.keyMemo = { key, id: createHash('sha256').update(key).digest('hex').slice(0, 16) }
    }
    return this.keyMemo.id
  }

  /** Cached list for the current base URL and key (stale entries included: offline startup). */
  private usableCache(): CacheEntry | null {
    const c = this.cache
    if (!c || c.baseUrl !== this.deps.http.baseUrl()) return null
    const id = this.keyId()
    if (c.keyId && id && c.keyId !== id) return null
    return c
  }

  private maybeAutoRefresh(): void {
    if (this.deps.autoRefresh === false || this.inflight) return
    const now = this.now()
    const cur = this.usableCache()
    if (cur && now - cur.fetchedAt < this.ttlMs) return
    if (now - this.lastAutoRefresh < AUTO_REFRESH_GAP_MS || !this.deps.http.hasKey()) return
    this.lastAutoRefresh = now
    void this.refresh()
  }

  private fetchModels(): Promise<string[]> {
    if (this.inflight) return this.inflight
    const run = async (): Promise<string[]> => {
      const baseUrl = this.deps.http.baseUrl()
      const keyId = this.keyId()
      const before = this.resolveAllFrom(this.usableCache())
      const res = await this.deps.http.getJson<{ data?: unknown }>('/models', { timeoutMs: LIST_TIMEOUT_MS })
      if (!Array.isArray(res?.data)) {
        throw new AiError('invalid_response', OPENAI_MESSAGES.invalidResponse, { detail: 'GET /models: no data[]' })
      }
      const ids = [
        ...new Set(
          res.data
            .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
            .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            .map((id) => id.trim())
        )
      ].sort()
      this.cache = { version: 1, baseUrl, keyId, fetchedAt: this.now(), models: ids }
      try {
        writeJsonAtomic(this.file, this.cache)
      } catch (err) {
        this.deps.log.warn('cannot write the model cache', err)
      }
      const after = this.resolveAllFrom(this.usableCache())
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        try {
          this.deps.onResolvedChange?.(after)
        } catch (err) {
          this.deps.log.warn('onResolvedChange listener failed', err)
        }
      }
      return [...ids]
    }
    const p = run()
    this.inflight = p
    const clear = (): void => {
      if (this.inflight === p) this.inflight = null
    }
    p.then(clear, clear)
    return p
  }

  private load(): CacheEntry | null {
    const raw = readJson<Partial<CacheEntry>>(this.file)
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) return null
    if (typeof raw.baseUrl !== 'string' || typeof raw.fetchedAt !== 'number') return null
    return {
      version: 1,
      baseUrl: raw.baseUrl,
      keyId: typeof raw.keyId === 'string' ? raw.keyId : '',
      fetchedAt: raw.fetchedAt,
      models: raw.models.filter((m): m is string => typeof m === 'string')
    }
  }
}
