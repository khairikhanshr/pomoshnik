import { create } from 'zustand'
import type { PublicSettings, SettingsPatch, Tier, TierConfig } from '@shared/types'
import { api, errorMessage } from '../../common/api'
import { S } from '../../common/strings'
import { toast } from './ui'

interface SettingsState {
  settings: PublicSettings | null
  load(): Promise<void>
  apply(settings: PublicSettings): void
  /** Optimistic patch; reverts and shows a toast on failure. */
  update(patch: SettingsPatch): Promise<boolean>
}

function mergePatch(s: PublicSettings, patch: SettingsPatch): PublicSettings {
  const { tiers, ...rest } = patch
  const next: PublicSettings = { ...s, ...rest }
  if (tiers) {
    const merged = { ...s.tiers }
    for (const [tier, cfg] of Object.entries(tiers) as [Tier, Partial<TierConfig> | undefined][]) {
      if (cfg) merged[tier] = { ...merged[tier], ...cfg }
    }
    next.tiers = merged
  }
  return next
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,

  async load() {
    const settings = await api.settings.get()
    set({ settings })
  },

  apply(settings) {
    set({ settings })
  },

  async update(patch) {
    const before = get().settings
    if (before) set({ settings: mergePatch(before, patch) })
    try {
      const settings = await api.settings.update(patch)
      set({ settings })
      return true
    } catch (err) {
      if (before) set({ settings: before })
      toast(S.settings.hint.failed(errorMessage(err) || S.common.unknownError), 'error')
      return false
    }
  }
}))

/** Non-null settings for components rendered after the initial load. */
export function useLoadedSettings(): PublicSettings {
  const settings = useSettings((s) => s.settings)
  if (!settings) throw new Error('settings are not loaded')
  return settings
}
