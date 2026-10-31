import { describe, expect, it } from 'vitest'
import type { ChatSummary } from '@shared/types'
import {
  acceleratorFromKey,
  acceleratorParts,
  capitalize,
  formatAccelerator,
  formatDuration,
  formatListDate,
  groupChats,
  type KeyLike
} from '../../src/renderer/src/common/format'
import { groupModels, isCustomModel, ttsSupportsInstructions } from '../../src/renderer/src/common/models'
import { markdownToPlain } from '../../src/renderer/src/common/plain-text'

const NOW = new Date(2026, 9, 29, 15, 0).getTime()
const at = (daysAgo: number, hour = 12): number => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 30, 0, 0)
  return d.getTime()
}
const chat = (id: string, updatedAt: number, pinned = false): ChatSummary => ({
  id,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  tier: 'luna',
  source: 'text',
  messageCount: 1,
  preview: '',
  pinned
})

describe('groupChats', () => {
  it('buckets by day boundaries, newest first, pinned on top', () => {
    const groups = groupChats(
      [chat('old', at(30)), chat('today', at(0, 9)), chat('yesterday', at(1, 23)), chat('week', at(6)), chat('pin', at(40), true), chat('today2', at(0, 14))],
      NOW
    )
    expect(groups.map((g) => [g.key, g.chats.map((c) => c.id)])).toEqual([
      ['pinned', ['pin']],
      ['today', ['today2', 'today']],
      ['yesterday', ['yesterday']],
      ['week', ['week']],
      ['earlier', ['old']]
    ])
  })

  it('formats list dates compactly', () => {
    expect(formatListDate(at(0, 9), NOW)).toMatch(/^09:30$/)
    expect(formatListDate(at(1), NOW)).toBe('вчера')
    expect(formatListDate(at(400), NOW)).toMatch(/\d{4}/)
  })
})

describe('helpers', () => {
  it('formats durations and capitalizes Cyrillic', () => {
    expect(formatDuration(7_400)).toBe('0:07')
    expect(formatDuration(83_000)).toBe('1:23')
    expect(capitalize('джарвис')).toBe('Джарвис')
  })
})

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: code,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

describe('accelerators', () => {
  it('maps Cmd on macOS and Ctrl on Windows to CommandOrControl', () => {
    expect(acceleratorFromKey(key('Space', { metaKey: true, shiftKey: true }), 'darwin')).toEqual({
      kind: 'done',
      accelerator: 'CommandOrControl+Shift+Space'
    })
    expect(acceleratorFromKey(key('KeyJ', { ctrlKey: true, altKey: true }), 'win32')).toEqual({
      kind: 'done',
      accelerator: 'CommandOrControl+Alt+J'
    })
  })

  it('requires a modifier except for function keys; Esc cancels, Backspace clears', () => {
    expect(acceleratorFromKey(key('KeyA'), 'darwin').kind).toBe('pending')
    expect(acceleratorFromKey(key('KeyA', { shiftKey: true }), 'darwin').kind).toBe('pending')
    expect(acceleratorFromKey(key('F9'), 'win32')).toEqual({ kind: 'done', accelerator: 'F9' })
    expect(acceleratorFromKey({ ...key('Escape'), key: 'Escape' }, 'darwin').kind).toBe('cancel')
    expect(acceleratorFromKey({ ...key('Backspace'), key: 'Backspace' }, 'darwin').kind).toBe('clear')
    expect(acceleratorFromKey({ ...key('ShiftLeft', { shiftKey: true }), key: 'Shift' }, 'darwin').kind).toBe('pending')
  })

  it('renders platform labels', () => {
    expect(acceleratorParts('CommandOrControl+Shift+Space', 'darwin')).toEqual(['⌘', '⇧', 'Пробел'])
    expect(formatAccelerator('CommandOrControl+Shift+J', 'win32')).toBe('Ctrl+Shift+J')
    expect(acceleratorParts('', 'darwin')).toEqual([])
  })
})

describe('models', () => {
  it('lists tier models newest first and filters non-chat models', () => {
    const ids = ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-4.1-mini', 'o4-mini', 'whisper-1', 'tts-1', 'text-embedding-3-large', 'gpt-image-1']
    const groups = groupModels(ids, 'sol')
    expect(groups.tier).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'])
    expect(groups.other).toEqual(['gpt-4.1-mini', 'gpt-6-luna', 'o4-mini'])
    expect(isCustomModel('auto', groups)).toBe(false)
    expect(isCustomModel('gpt-6-sol', groups)).toBe(false)
    expect(isCustomModel('my-proxy-model', groups)).toBe(true)
  })

  it('knows which TTS models accept style instructions', () => {
    expect(ttsSupportsInstructions('gpt-4o-mini-tts')).toBe(true)
    expect(ttsSupportsInstructions('tts-1-hd')).toBe(false)
  })
})

describe('markdownToPlain', () => {
  it('strips markup for one-line previews', () => {
    const md = '## Итог\n\n**Вопрос 1 — B.** См. [MDN](https://mdn.dev) и `code`.\n\n- пункт\n\n```ts\nconst a = 1\n```'
    expect(markdownToPlain(md)).toBe('Итог\n\nВопрос 1 — B. См. MDN и code.\n\n• пункт\n\n [код]')
  })

  it('handles an unterminated code fence while streaming', () => {
    expect(markdownToPlain('Смотрите:\n```js\nlet x')).toBe('Смотрите:\n [код]')
  })
})
