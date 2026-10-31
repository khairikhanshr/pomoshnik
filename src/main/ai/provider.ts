// Provider-neutral conversation model shared by the Responses API and Chat Completions implementations.
import type { ApiMode, ImageDetail, ReasoningEffort } from '@shared/types'
import type { ToolSpec } from '../tools/types'

export type ConvPart = { type: 'text'; text: string } | { type: 'image'; url: string; detail: ImageDetail }

export interface ConvMessage {
  role: 'user' | 'assistant'
  /** Assistant messages carry text parts only. */
  parts: ConvPart[]
}

export interface ToolCallRequest {
  /** call_id to answer with. */
  id: string
  name: string
  /** Raw JSON arguments as produced by the model. */
  arguments: string
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter'

export interface StepResult {
  text: string
  toolCalls: ToolCallRequest[]
  finishReason: FinishReason
}

export interface ToolImage {
  url: string
  detail: ImageDetail
}

export interface ToolResultInput {
  callId: string
  name: string
  output: string
  images: ToolImage[]
}

export interface SessionOptions {
  model: string
  instructions: string
  messages: ConvMessage[]
  tools: ToolSpec[]
  /** Built-in web search (Responses API only). */
  webSearch: boolean
  effort: ReasoningEffort
  maxOutputTokens?: number
}

export interface StepOptions {
  signal: AbortSignal
  /** Tools stay declared but the model must answer in text (last allowed step). */
  noTools?: boolean
  onTextDelta?: (text: string) => void
  onActivity?: (activity: 'web_search') => void
}

/** One agent turn: the provider keeps its own wire-format transcript between steps. */
export interface ModelSession {
  step(opts: StepOptions): Promise<StepResult>
  addToolResults(results: ToolResultInput[]): void
}

export interface ModelProvider {
  readonly api: ApiMode
  createSession(opts: SessionOptions): ModelSession
}

/** Name of our function tool that opens a browser search; it collides with the built-in `web_search`. */
const BROWSER_SEARCH_TOOL = 'web_search'
const BROWSER_SEARCH_ALIAS = 'open_web_search'

/** Name under which a function tool is shown to the model. */
export function exposedToolName(name: string, builtinWebSearch: boolean): string {
  return builtinWebSearch && name === BROWSER_SEARCH_TOOL ? BROWSER_SEARCH_ALIAS : name
}

/** Maps model-visible names back to registry names. */
export function toolNameMap(tools: readonly ToolSpec[], builtinWebSearch: boolean): Map<string, string> {
  return new Map(tools.map((t) => [exposedToolName(t.name, builtinWebSearch), t.name]))
}

export function toolImageLabel(toolName: string): string {
  return toolName === 'take_screenshot'
    ? 'Снимок экрана (результат take_screenshot):'
    : `Изображение (результат ${toolName}):`
}

/** In-turn images re-sent with every step; older tool images are replaced by a note to bound request size. */
export const MAX_TURN_IMAGE_MESSAGES = 3
export const OMITTED_IMAGE_NOTE = '[предыдущее изображение опущено]'

export const EFFORT_ORDER: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * When a 400 lists the supported reasoning efforts, picks the closest supported value
 * (highest not above the requested one, else the lowest above it).
 */
export function downgradeEffort(requested: string, message: string): string | null {
  const rank = EFFORT_ORDER.indexOf(requested)
  const supported = [...new Set([...message.matchAll(/'([a-z]+)'/g)].map((m) => m[1]))].filter(
    (v) => v !== requested && EFFORT_ORDER.includes(v)
  )
  if (rank < 0 || supported.length === 0) return null
  const sorted = supported.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
  const lower = sorted.filter((v) => EFFORT_ORDER.indexOf(v) < rank)
  return lower.length ? lower[lower.length - 1] : sorted[0]
}

/** Per-model adaptive request adjustments learned from HTTP 400 responses (kept for the app session). */
export interface ModelQuirks {
  noReasoning?: boolean
  /** Requested effort → effort the model accepts. */
  effortMap?: Record<string, string>
  noWebSearch?: boolean
  noInclude?: boolean
  detailHigh?: boolean
  noTools?: boolean
}

export class QuirkMemory {
  private readonly byModel = new Map<string, ModelQuirks>()

  get(model: string): ModelQuirks {
    let q = this.byModel.get(model)
    if (!q) {
      q = {}
      this.byModel.set(model, q)
    }
    return q
  }
}

export function lowerErrorText(err: { detail?: string; param?: string; apiCode?: string }): string {
  return [err.detail, err.param, err.apiCode].filter(Boolean).join(' ').toLowerCase()
}

/** Learns a reasoning-effort fix from a 400: a supported lower effort, else dropping the parameter. */
export function adaptEffort(quirks: ModelQuirks, requested: string, detail: string): string {
  const replacement = downgradeEffort(requested, detail)
  if (replacement && quirks.effortMap?.[requested] !== replacement) {
    quirks.effortMap = { ...quirks.effortMap, [requested]: replacement }
    return `effort:${replacement}`
  }
  quirks.noReasoning = true
  return 'no-reasoning'
}

export function effectiveEffort(quirks: ModelQuirks, effort: string): string | null {
  if (effort === 'auto' || quirks.noReasoning) return null
  return quirks.effortMap?.[effort] ?? effort
}

export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function parseJsonObject(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}
