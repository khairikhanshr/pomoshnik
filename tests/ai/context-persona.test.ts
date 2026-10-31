import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { ChatMessage, ImageRef } from '@shared/types'
import { IMAGE_PLACEHOLDER, buildConversation, summarizeToolCalls } from '../../src/main/ai/context'
import { buildInstructions, describeNow, describeOs, type PersonaContext } from '../../src/main/ai/persona'
import { cleanTitle, fallbackTitle } from '../../src/main/ai/title'
import { MemoryMedia, TINY_PNG } from './helpers/fakes'

let seq = 0
function msg(role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m${++seq}`, role, text, createdAt: seq, ...extra }
}

describe('buildConversation', () => {
  it('sends images only for the last two image-bearing messages', async () => {
    const media = new MemoryMedia()
    const img = (): ImageRef => media.save(TINY_PNG, { kind: 'upload', mime: 'image/png' })
    const old = img()
    const mid = img()
    const recent = img()
    const messages = [
      msg('user', 'Первое фото', { images: [old] }),
      msg('assistant', 'Это кот.'),
      msg('user', 'Второе', { images: [mid] }),
      msg('assistant', 'Это пёс.'),
      msg('user', 'Третье', { images: [recent] })
    ]
    const conv = await buildConversation(messages, { media, imageDetail: 'high' })
    const url = `data:image/png;base64,${TINY_PNG.toString('base64')}`
    expect(conv).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'Первое фото' }, { type: 'text', text: IMAGE_PLACEHOLDER }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Это кот.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Второе' }, { type: 'image', url, detail: 'high' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Это пёс.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Третье' }, { type: 'image', url, detail: 'high' }] }
    ])
  })

  it('summarizes tool calls, keeps tool screenshots before the reply and skips unusable messages', async () => {
    const media = new MemoryMedia()
    const shot = media.save(TINY_PNG, { kind: 'screenshot', mime: 'image/png' })
    const messages = [
      msg('user', 'Ответь на тест'),
      msg('assistant', 'Вопрос 1 — B.', {
        images: [shot],
        toolCalls: [
          { id: 'c1', name: 'take_screenshot', title: 'Делаю снимок экрана', args: {}, status: 'ok', summary: 'Снимок готов', startedAt: 1 },
          { id: 'c2', name: 'close_application', title: 'Закрываю «Safari»', args: {}, status: 'denied', startedAt: 2 }
        ]
      }),
      msg('user', 'Стоп'),
      msg('assistant', '', { status: 'error', error: 'Ошибка' }),
      msg('user', 'Продолжай'),
      msg('assistant', 'Частичный', { status: 'cancelled' }),
      msg('user', 'Ещё раз'),
      msg('assistant', '', { id: 'streaming', status: 'streaming' })
    ]
    const conv = await buildConversation(messages, { media, imageDetail: 'auto', excludeMessageId: 'streaming' })
    expect(conv.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'user', 'assistant', 'user'])
    expect(conv[1].parts[0]).toEqual({ type: 'text', text: 'Изображения, полученные инструментами для следующего ответа ассистента:' })
    expect(conv[1].parts[1]).toMatchObject({ type: 'image', detail: 'auto' })
    expect(conv[2].parts[0]).toEqual({
      type: 'text',
      text: '[Действия: Делаю снимок экрана — Снимок готов ✓; Закрываю «Safari» ✕ (отклонено пользователем)]\n\nВопрос 1 — B.'
    })
    expect(conv[5].parts[0]).toEqual({ type: 'text', text: 'Частичный [ответ прерван]' })
  })

  it('marks images that are gone and trims long histories to start with a user message', async () => {
    const media = new MemoryMedia()
    const gone: ImageRef = { id: 'deleted', url: 'jarvis-media://image/deleted', kind: 'upload' }
    const many = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `сообщение ${i}`))
    const conv = await buildConversation([...many, msg('user', 'Последнее', { images: [gone] })], {
      media,
      imageDetail: 'high',
      maxMessages: 6
    })
    expect(conv[0].role).toBe('user')
    expect(conv.length).toBeLessThanOrEqual(6)
    expect(conv[conv.length - 1].parts).toEqual([
      { type: 'text', text: 'Последнее' },
      { type: 'text', text: '[изображение недоступно]' }
    ])
  })

  it('summarizeToolCalls is empty without calls', () => {
    expect(summarizeToolCalls(undefined)).toBe('')
    expect(summarizeToolCalls([])).toBe('')
  })
})

function persona(patch: Partial<PersonaContext> = {}, settings: Partial<typeof DEFAULT_SETTINGS> = {}): string {
  return buildInstructions(
    { ...DEFAULT_SETTINGS, ...settings },
    {
      now: new Date('2026-10-29T14:05:00Z'),
      platform: 'darwin',
      osRelease: '25.0.0',
      arch: 'arm64',
      source: 'voice',
      spoken: true,
      toolNames: ['take_screenshot', 'open_application', 'list_applications', 'mouse', 'type_text', 'press_keys', 'set_reminder', 'open_web_search'],
      webSearch: true,
      timeZone: 'Asia/Almaty',
      ...patch
    }
  )
}

describe('persona', () => {
  it('describes Jarvis, the address, date/time, OS and voice rules', () => {
    const text = persona({}, { userName: 'Тони', customInstructions: 'Отвечай с юмором.' })
    expect(text).toContain('J.A.R.V.I.S.')
    expect(text).toContain('"сэр" (the user\'s name is Тони')
    expect(text).toContain('Thursday, 29 October 2026')
    expect(text).toContain('Asia/Almaty')
    expect(text).toContain('macOS (Darwin 25.0.0, arm64)')
    expect(text).toContain('main modifier is Cmd')
    expect(text).toContain('## Spoken reply')
    expect(text).toContain('1–3 short sentences')
    expect(text).toContain('answer EVERY visible question')
    expect(text).toContain('`region`')
    expect(text).toContain('"калькулятор" → "Calculator"')
    expect(text).toContain('Never invent or assume tool results')
    expect(text).toContain('built-in web search')
    expect(text).toContain('open_web_search only opens a search page')
    expect(text.trim().endsWith('## Additional instructions from the user\nОтвечай с юмором.')).toBe(true)
  })

  it('switches to text rules, Windows specifics and a no-computer-control note', () => {
    const text = persona({
      spoken: false,
      source: 'text',
      platform: 'win32',
      osRelease: '10.0.22631',
      arch: 'x64',
      toolNames: ['get_datetime', 'set_reminder'],
      webSearch: false
    })
    expect(text).toContain('## Text reply')
    expect(text).not.toContain('## Spoken reply')
    expect(text).toContain('Windows 11 (10.0.22631, x64)')
    expect(text).toContain('main modifier is Ctrl')
    expect(text).toContain('Computer control is turned off')
    expect(text).not.toContain('take_screenshot')
  })

  it('formats OS and time helpers', () => {
    expect(describeOs('win32', '10.0.19045', 'x64')).toBe('Windows 10 (10.0.19045, x64)')
    expect(describeNow(new Date('2026-10-29T14:05:00Z'), 'Asia/Almaty')).toBe('Thursday, 29 October 2026 at 19:05 (Asia/Almaty, GMT+05:00)')
  })
})

describe('titles', () => {
  it('cleans model titles', () => {
    expect(cleanTitle('«Погода в Алматы».')).toBe('Погода в Алматы')
    expect(cleanTitle('Название: "Ответы на тест"\n')).toBe('Ответы на тест')
    expect(cleanTitle('**Открытие Telegram**')).toBe('Открытие Telegram')
    expect(cleanTitle('один два три четыре пять шесть семь восемь')).toBe('один два три четыре пять шесть')
    expect(cleanTitle('  \n ')).toBe('')
  })

  it('falls back to the first 48 characters of the user text', () => {
    const text = 'Сделай скриншот экрана и скажи ответ по каждому из тестов, пожалуйста'
    const title = fallbackTitle(text)
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(49)
    expect(text.startsWith(title.slice(0, -1))).toBe(true)
    expect(fallbackTitle('  Открой   Telegram ')).toBe('Открой Telegram')
    expect(fallbackTitle('', true)).toBe('Изображение')
  })
})
