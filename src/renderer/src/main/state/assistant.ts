import { create } from 'zustand'
import type { AssistantState } from '@shared/types'
import { api } from '../../common/api'

interface AssistantStore {
  state: AssistantState
  load(): Promise<void>
  apply(state: AssistantState): void
}

const INITIAL: AssistantState = { phase: 'idle', wakeActive: false, updatedAt: 0 }

export const useAssistant = create<AssistantStore>((set, get) => ({
  state: INITIAL,

  async load() {
    const state = await api.assistant.getState()
    if (state.updatedAt >= get().state.updatedAt) set({ state })
  },

  apply(state) {
    set({ state })
  }
}))
