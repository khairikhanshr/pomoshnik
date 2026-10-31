// Contract between the agent loop (src/main/ai) and computer-control tools (src/main/tools).
// CONTRACT FILE: additive changes only.
import type { ImageRef, MessageSource, Settings } from '@shared/types'
import type { AppBus } from '../bus'
import type { MediaStore, SettingsStore, WindowService } from '../services'

/** JSON Schema of a function's parameters (always an object). */
export interface JsonObjectSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolSpec {
  name: string
  /** English description for the model (models follow English tool docs best). */
  description: string
  parameters: JsonObjectSchema
}

export interface ToolContext {
  chatId: string
  turnId: string
  source: MessageSource
  settings: Settings
  /** Aborted when the user cancels the turn. */
  signal: AbortSignal
}

export interface ToolResult {
  ok: boolean
  /** Text for the model (concise prose or JSON). The agent truncates it to LIMITS.maxToolOutputChars. */
  output: string
  /** Short Russian summary for the UI, e.g. "Открыто: Telegram". */
  summary?: string
  /** Images the model should see (e.g. a screenshot); also attached to the assistant message. */
  images?: ImageRef[]
}

export interface ToolRegistry {
  /** Function specs enabled for the current settings and platform. */
  specs(settings: Settings): ToolSpec[]
  /** Russian present-tense title for the UI before/while running, e.g. "Открываю «Telegram»". */
  describe(name: string, args: Record<string, unknown>): string
  /**
   * Runs a tool. Never throws: failures resolve to { ok: false, output: 'Error: …' }.
   * Dangerous actions ask the user for confirmation internally (native dialog) when
   * settings.confirmDangerous is on; a refusal resolves to { ok: false, output: 'User denied …' }.
   */
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/** Everything tools may use from the rest of the app. */
export interface ToolHost {
  settings: SettingsStore
  media: MediaStore
  windows: WindowService
  bus: AppBus
  userDataDir: string
  platform: NodeJS.Platform
}
