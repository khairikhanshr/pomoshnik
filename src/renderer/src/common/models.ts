// Model-id helpers for the tier model selects. Pure.
import { TIER_MODEL_PATTERN } from '@shared/defaults'
import type { Tier } from '@shared/types'

export interface ModelGroups {
  /** gpt-<version>-<tier> ids of this tier, newest first. */
  tier: string[]
  /** Other chat-capable models, alphabetical. */
  other: string[]
}

const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/
const NON_CHAT = /(embed|tts|whisper|transcri|dall-e|image|audio|realtime|moderation|search|similarity|instruct)/

function versionOf(id: string): number[] {
  const m = TIER_MODEL_PATTERN.exec(id)
  return m ? m[1].split('.').map(Number) : []
}

function compareVersionsDesc(a: string, b: string): number {
  const va = versionOf(a)
  const vb = versionOf(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0)
    if (d) return d
  }
  return a.localeCompare(b)
}

export function groupModels(ids: string[], tier: Tier): ModelGroups {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  const tierIds = unique.filter((id) => TIER_MODEL_PATTERN.exec(id)?.[2] === tier).sort(compareVersionsDesc)
  const tierSet = new Set(tierIds)
  const other = unique
    .filter((id) => !tierSet.has(id) && CHAT_MODEL.test(id) && !NON_CHAT.test(id))
    .sort((a, b) => a.localeCompare(b))
  return { tier: tierIds, other }
}

/** True when `model` is neither 'auto' nor one of the listed ids (shown as a free-text value). */
export function isCustomModel(model: string, groups: ModelGroups): boolean {
  return model !== 'auto' && !groups.tier.includes(model) && !groups.other.includes(model)
}

/** OpenAI TTS models that accept style `instructions`. */
export function ttsSupportsInstructions(model: string): boolean {
  return !/^tts-1/.test(model)
}
