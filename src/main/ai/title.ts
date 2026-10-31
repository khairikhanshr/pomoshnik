// Chat titles: a ≤ 5-word Russian title from the Luna tier, falling back to the start of the user text.
// Never throws and never blocks the turn (called in the background).
import type { ReasoningEffort } from '@shared/types'
import type { Logger } from '../log'
import { userMessage } from './errors'
import type { ModelProvider } from './provider'

export const NEW_CHAT_TITLE = 'Новый чат'
const FALLBACK_CHARS = 48
const MAX_TITLE_WORDS = 6
const MAX_TITLE_CHARS = 60
const PROMPT_PART_CHARS = 1500
const TITLE_TIMEOUT_MS = 30_000

const TITLE_INSTRUCTIONS = [
  'You name chat conversations.',
  'Reply with a short Russian title of at most 5 words that captures what the user asked for.',
  'No quotes, no emoji, no trailing period, no explanations: output only the title.'
].join(' ')

export function fallbackTitle(userText: string, hasImages = false): string {
  const flat = userText.replace(/\s+/g, ' ').trim()
  if (!flat) return hasImages ? 'Изображение' : NEW_CHAT_TITLE
  return flat.length <= FALLBACK_CHARS ? flat : `${flat.slice(0, FALLBACK_CHARS).trimEnd()}…`
}

/** Normalizes a model-produced title; '' when unusable. */
export function cleanTitle(raw: string): string {
  let title = raw.split('\n').find((line) => line.trim()) ?? ''
  title = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:title|название|заголовок)\s*[:：]\s*/i, '')
    .replace(/^["'«“„`*_#\s]+/, '')
    .replace(/["'»”`*_\s.!。]+$/, '')
    .trim()
  const words = title.split(' ').filter(Boolean)
  if (words.length > MAX_TITLE_WORDS) title = words.slice(0, MAX_TITLE_WORDS).join(' ')
  if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
  return title
}

export interface TitleRequest {
  provider: ModelProvider
  model: string
  effort: ReasoningEffort
  userText: string
  assistantText: string
  hasImages?: boolean
  signal?: AbortSignal
}

export async function generateTitle(req: TitleRequest, log: Logger): Promise<string> {
  const fallback = fallbackTitle(req.userText, req.hasImages)
  const user = req.userText.trim() || (req.hasImages ? '(пользователь прислал изображение)' : '')
  if (!user) return fallback
  const prompt = [
    `Запрос пользователя:\n${user.slice(0, PROMPT_PART_CHARS)}`,
    req.assistantText.trim() ? `Ответ ассистента:\n${req.assistantText.trim().slice(0, PROMPT_PART_CHARS)}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const session = req.provider.createSession({
      model: req.model,
      instructions: TITLE_INSTRUCTIONS,
      messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      tools: [],
      webSearch: false,
      effort: req.effort
    })
    const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    const result = await session.step({ signal })
    return cleanTitle(result.text) || fallback
  } catch (err) {
    log.warn(`title generation failed: ${userMessage(err)}`)
    return fallback
  }
}
