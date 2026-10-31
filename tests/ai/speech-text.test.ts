import { describe, expect, it } from 'vitest'
import {
  detectSpeechLang,
  sentenceBoundaries,
  splitSentences,
  toSpeakableText
} from '@shared/speech-text'

describe('toSpeakableText', () => {
  it('strips markdown emphasis, headings, links, URLs, emoji and keeps short inline code', () => {
    const md = '# Итоги\n\n**Важно:** нажмите `Cmd+C` 🚀 и откройте [документацию](https://example.com/docs) или https://openai.com.'
    expect(toSpeakableText(md)).toBe('Итоги.\nВажно: нажмите Cmd+C и откройте документацию или.')
  })

  it('replaces code blocks with "Код — в чате." once and skips their content', () => {
    const md = 'Вот код:\n```python\nprint("hi")\n```\nЕщё один:\n```js\nconsole.log(1)\n```\nГотово.'
    expect(toSpeakableText(md)).toBe('Вот код:\nКод — в чате.\nЕщё один:\nГотово.')
  })

  it('treats an unclosed fence (still streaming) as code to the end', () => {
    expect(toSpeakableText('Пример:\n```ts\nconst a = 1')).toBe('Пример:\nКод — в чате.')
  })

  it('uses English phrases for English text', () => {
    expect(toSpeakableText('Here you go:\n```\nls -la\n```')).toBe('Here you go:\nThe code is in the chat.')
  })

  it('turns lists into separate sentences and keeps ordinal numbers', () => {
    const md = '- первый пункт\n* второй **жирный**\n1. Москва\n2) Берлин\n- [x] сделано'
    expect(toSpeakableText(md)).toBe('первый пункт.\nвторой жирный.\n1) Москва.\n2) Берлин.\nсделано.')
  })

  it('replaces tables with one phrase and drops rules, quotes markers and HTML', () => {
    const md = '> Цитата <b>важная</b>\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nКонец'
    expect(toSpeakableText(md)).toBe('Цитата важная.\nТаблица — в чате.\nКонец.')
  })

  it('drops domain-like citation links from web search', () => {
    const md = 'В Алматы сейчас +5 °C ([weather.com](https://weather.com/ru)).'
    expect(toSpeakableText(md)).toBe('В Алматы сейчас +5 °C.')
  })

  it('keeps decimals, times and versions intact', () => {
    expect(toSpeakableText('Число π ≈ 3.14, встреча в 10.30, версия 5.6.')).toBe('Число π ≈ 3.14, встреча в 10.30, версия 5.6.')
  })

  it('returns empty text for markup-only input', () => {
    expect(toSpeakableText('')).toBe('')
    expect(toSpeakableText('---\n\n***')).toBe('')
    expect(toSpeakableText('🙂🚀')).toBe('')
  })
})

describe('splitSentences', () => {
  it('splits Russian and English sentences', () => {
    expect(splitSentences('Готово, сэр! Что дальше? Открываю Telegram. Done. Next one?')).toEqual([
      'Готово, сэр!',
      'Что дальше?',
      'Открываю Telegram.',
      'Done.',
      'Next one?'
    ])
  })

  it('does not split decimals, abbreviations, initials or list ordinals', () => {
    const text =
      'Число 3.14 — это π. А. С. Пушкин родился в 1799 г. в Москве. Это т. е. пример. Dr. Smith agrees, e.g. today. 1. Пункт один.'
    expect(splitSentences(text)).toEqual([
      'Число 3.14 — это π.',
      'А. С. Пушкин родился в 1799 г. в Москве.',
      'Это т. е. пример.',
      'Dr. Smith agrees, e.g. today.',
      '1. Пункт один.'
    ])
  })

  it('splits test answers with single-letter options', () => {
    expect(splitSentences('Вопрос 1 — B. Вопрос 2 — C. И т. д. Потом всё.')).toEqual([
      'Вопрос 1 — B.',
      'Вопрос 2 — C.',
      'И т. д.',
      'Потом всё.'
    ])
  })

  it('splits at newlines, ellipses and closing quotes', () => {
    expect(splitSentences('Первое\nВторое… Третье «в кавычках.» Четвёртое')).toEqual([
      'Первое',
      'Второе…',
      'Третье «в кавычках.»',
      'Четвёртое'
    ])
  })

  it('splits overly long sentences at clause boundaries', () => {
    const long = Array.from({ length: 40 }, (_, i) => `часть номер ${i}`).join(', ') + '.'
    const parts = splitSentences(long)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300)
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long)
  })

  it('handles empty and punctuation-only input', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences(' . ! ')).toEqual([])
  })
})

describe('sentenceBoundaries', () => {
  it('never confirms a boundary at the very end (a trailing "3." may become "3.14")', () => {
    expect(sentenceBoundaries('Это 3.')).toEqual([])
    expect(sentenceBoundaries('Это 3.14 и всё. Дальше')).toEqual([15])
  })
})

describe('detectSpeechLang', () => {
  it('detects English only for clearly English text', () => {
    expect(detectSpeechLang('Hello there, how are you?')).toBe('en')
    expect(detectSpeechLang('Привет, открой Telegram')).toBe('ru')
    expect(detectSpeechLang('```js\nconst x = 1\n```\nГотово')).toBe('ru')
    expect(detectSpeechLang('12345')).toBe('ru')
  })
})
