// PublicSettings = Settings + derived read-only info for renderers (never the keys themselves).
import { FALLBACK_TIER_MODELS } from '@shared/defaults'
import { TIERS } from '@shared/types'
import type { Platform, PublicSettings, Settings, Tier } from '@shared/types'
import type { SecretStore } from '../services'

export function toPlatform(platform: NodeJS.Platform): Platform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux'
}

export interface PublicSettingsInput {
  settings: Settings
  secrets: Pick<SecretStore, 'getApiKey' | 'apiKeyHint' | 'getElevenLabsKey' | 'elevenLabsKeyHint'>
  /** ModelCatalog.resolvedAll */
  resolvedModels(): Record<Tier, string>
  platform: NodeJS.Platform
  appVersion: string
}

function safeResolved(resolve: () => Record<Tier, string>): Record<Tier, string> {
  let raw: Partial<Record<Tier, unknown>> = {}
  try {
    raw = resolve() ?? {}
  } catch {
    raw = {}
  }
  const out = { ...FALLBACK_TIER_MODELS }
  for (const tier of TIERS) {
    const id = raw[tier]
    if (typeof id === 'string' && id.trim()) out[tier] = id
  }
  return out
}

export function buildPublicSettings(input: PublicSettingsInput): PublicSettings {
  return {
    ...input.settings,
    hasApiKey: !!input.secrets.getApiKey(),
    apiKeyHint: input.secrets.apiKeyHint(),
    hasElevenLabsKey: !!input.secrets.getElevenLabsKey(),
    elevenLabsKeyHint: input.secrets.elevenLabsKeyHint(),
    platform: toPlatform(input.platform),
    appVersion: input.appVersion,
    resolvedModels: safeResolved(input.resolvedModels)
  }
}
