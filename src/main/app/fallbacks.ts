// Degraded services used when the AI or tools module throws during construction, so the app
// still starts (chats, settings, UI) and reports a clear error instead of crashing.
import { FALLBACK_TIER_MODELS } from '@shared/defaults'
import type { AiServices } from '../ai'
import type { ToolRegistry } from '../tools/types'

export function unavailableAi(reason: string): AiServices {
  const message = `ИИ-модуль не запустился: ${reason}`
  const fail = async (): Promise<never> => {
    throw new Error(message)
  }
  return {
    models: {
      list: fail,
      resolve: (tier) => FALLBACK_TIER_MODELS[tier],
      resolvedAll: () => ({ ...FALLBACK_TIER_MODELS }),
      refresh: async () => {}
    },
    speech: { transcribe: fail, synthesize: fail, listElevenLabsVoices: fail },
    assistant: {
      send: fail,
      cancel: () => {},
      currentTurn: () => null,
      testConnection: async () => ({ ok: false, message })
    }
  }
}

export function unavailableTools(reason: string): ToolRegistry & { dispose(): void } {
  return {
    specs: () => [],
    describe: (name) => name,
    execute: async (name) => ({ ok: false, output: `Error: tool ${name} is unavailable (${reason})` }),
    dispose: () => {}
  }
}
