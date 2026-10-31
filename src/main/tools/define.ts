import type { Settings } from '@shared/types'
import type { Logger } from '../log'
import type { Args } from './args'
import type { ToolContext, ToolHost, ToolResult, ToolSpec } from './types'

export interface ToolDef {
  spec: ToolSpec
  /** Still offered when settings.computerControl is off. */
  harmless?: boolean
  /** Platforms the tool works on (default: macOS and Windows). */
  platforms?: readonly NodeJS.Platform[]
  /** Extra settings gate, e.g. allowShellCommands for run_command. */
  enabled?: (settings: Settings) => boolean
  /** Russian present-tense title for the UI, e.g. "Открываю «Telegram»". */
  title(args: Args): string
  run(args: Args, ctx: ToolContext): Promise<ToolResult>
}

export interface ConfirmRequest {
  /** Russian question, e.g. "Выполнить команду в терминале?" */
  message: string
  /** Exact details (command text, file path). */
  detail?: string
  /** Short spoken prompt for voice turns. */
  spoken?: string
}

export type ConfirmFn = (ctx: ToolContext, req: ConfirmRequest) => Promise<boolean>

/** Shared dependencies handed to every tool factory. */
export interface ToolEnv {
  host: ToolHost
  platform: NodeJS.Platform
  log: Logger
  /** Asks the user (honours settings.confirmDangerous and JARVIS_AUTO_CONFIRM). */
  confirm: ConfirmFn
}

export const DESKTOP_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32']

export function ok(output: string, summary?: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, output, summary, ...extra }
}

export function fail(output: string, summary?: string): ToolResult {
  return { ok: false, output: output.startsWith('Error') ? output : `Error: ${output}`, summary }
}

/** Contract wording the agent loop relies on to mark a call as denied. */
export function denied(what: string): ToolResult {
  return { ok: false, output: `User denied the action: ${what}`, summary: 'Отменено пользователем' }
}
