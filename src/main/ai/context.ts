// Chat history → provider-neutral conversation. Only the images of the most recent image-bearing
// messages are sent; prior tool calls become a short text summary inside the assistant message.
import { LIMITS } from '@shared/defaults'
import type { ChatMessage, ImageDetail, ImageRef, ToolCallRecord } from '@shared/types'
import type { MediaStore } from '../services'
import type { ConvMessage, ConvPart } from './provider'

export const IMAGE_PLACEHOLDER = '[изображение]'
const MISSING_IMAGE = '[изображение недоступно]'
const TOOL_IMAGES_NOTE = 'Изображения, полученные инструментами для следующего ответа ассистента:'
const INTERRUPTED_NOTE = '[ответ прерван]'
export const MAX_HISTORY_MESSAGES = 40
export const MAX_HISTORY_CHARS = 120_000
/** Rough text-equivalent weight of an image when trimming long histories. */
const IMAGE_WEIGHT = 2_000

export interface ContextOptions {
  media: MediaStore
  imageDetail: ImageDetail
  /** The assistant message being generated right now (never part of the context). */
  excludeMessageId?: string
  maxMessages?: number
  maxChars?: number
  imageMessages?: number
}

const STATUS_MARK: Record<ToolCallRecord['status'], string> = {
  ok: '✓',
  error: '✕',
  denied: '✕ (отклонено пользователем)',
  running: '(прервано)'
}

/** "[Действия: Открываю «Telegram» — Открыто: Telegram ✓]" */
export function summarizeToolCalls(calls: readonly ToolCallRecord[] | undefined): string {
  if (!calls?.length) return ''
  const items = calls.map((c) => `${c.summary ? `${c.title} — ${c.summary}` : c.title} ${STATUS_MARK[c.status] ?? ''}`.trim())
  return `[Действия: ${items.join('; ')}]`
}

function isUsable(m: ChatMessage): boolean {
  if (m.role === 'user') return Boolean(m.text.trim() || m.images?.length)
  return Boolean(m.text.trim() || m.toolCalls?.length || m.images?.length)
}

function weight(m: ChatMessage): number {
  return m.text.length + (m.images?.length ?? 0) * IMAGE_WEIGHT + (m.toolCalls?.length ?? 0) * 120
}

/** Most recent messages within the limits, starting with a user message when possible. */
function recentWindow(messages: ChatMessage[], maxMessages: number, maxChars: number): ChatMessage[] {
  const picked: ChatMessage[] = []
  let total = 0
  for (let i = messages.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const w = weight(messages[i])
    if (picked.length > 0 && total + w > maxChars) break
    picked.unshift(messages[i])
    total += w
  }
  while (picked.length > 1 && picked[0].role !== 'user') picked.shift()
  return picked
}

async function imagePart(image: ImageRef, opts: ContextOptions): Promise<ConvPart> {
  const url = await opts.media.dataUrl(image.id, { maxSide: LIMITS.screenshotMaxSide }).catch(() => null)
  return url ? { type: 'image', url, detail: opts.imageDetail } : { type: 'text', text: MISSING_IMAGE }
}

function assistantText(m: ChatMessage, omittedImages: number): string {
  const pieces: string[] = []
  const actions = summarizeToolCalls(m.toolCalls)
  if (actions) pieces.push(actions)
  if (omittedImages > 0) pieces.push(Array.from({ length: omittedImages }, () => IMAGE_PLACEHOLDER).join(' '))
  const interrupted = m.status === 'cancelled' || m.status === 'streaming'
  const body = m.text.trim()
  if (body) pieces.push(interrupted ? `${body} ${INTERRUPTED_NOTE}` : body)
  else if (interrupted) pieces.push(INTERRUPTED_NOTE)
  return pieces.join('\n\n')
}

export async function buildConversation(messages: ChatMessage[], opts: ContextOptions): Promise<ConvMessage[]> {
  const usable = messages.filter((m) => m.id !== opts.excludeMessageId && isUsable(m))
  const window = recentWindow(usable, opts.maxMessages ?? MAX_HISTORY_MESSAGES, opts.maxChars ?? MAX_HISTORY_CHARS)

  const withImages = window.flatMap((m, i) => (m.images?.length ? [i] : []))
  const live = new Set(withImages.slice(-(opts.imageMessages ?? LIMITS.historyImageMessages)))

  const out: ConvMessage[] = []
  for (const [i, m] of window.entries()) {
    const images = m.images ?? []
    const sendImages = live.has(i)
    if (m.role === 'user') {
      const parts: ConvPart[] = []
      if (m.text.trim()) parts.push({ type: 'text', text: m.text })
      for (const image of images) {
        parts.push(sendImages ? await imagePart(image, opts) : { type: 'text', text: IMAGE_PLACEHOLDER })
      }
      if (parts.length) out.push({ role: 'user', parts })
      continue
    }
    if (sendImages && images.length) {
      // Assistant content cannot hold images: tool screenshots of that reply go in a user message before it.
      const parts: ConvPart[] = [{ type: 'text', text: TOOL_IMAGES_NOTE }]
      for (const image of images) parts.push(await imagePart(image, opts))
      out.push({ role: 'user', parts })
    }
    const text = assistantText(m, sendImages ? 0 : images.length)
    if (text) out.push({ role: 'assistant', parts: [{ type: 'text', text }] })
  }
  return out
}
