import { describe, expect, it } from 'vitest'
import { toSpeakableText } from '@shared/speech-text'
import { SpeechChunker, cutPhrase } from '../../src/main/ai/speech-chunker'

interface Emitted {
  text: string
  final: boolean
  /** Number of deltas pushed when the chunk was emitted. */
  at: number
}

function run(deltas: string[], opts: { maxChars?: number; userTitle?: string } = {}): Emitted[] {
  const out: Emitted[] = []
  let pushed = 0
  const chunker = new SpeechChunker({
    maxChars: opts.maxChars ?? 700,
    userTitle: opts.userTitle ?? 'сэр',
    emit: (text, final) => out.push({ text, final, at: pushed })
  })
  for (const d of deltas) {
    pushed++
    chunker.push(d)
  }
  chunker.finish()
  return out
}

const words = (text: string): string[] => text.match(/\S+\s*/g) ?? []

const REPLY =
  'Добрый вечер, сэр. Сегодня в Алматы ясно, плюс пять градусов. Ветер слабый, осадков не ожидается. ' +
  'Завтра будет немного теплее, до плюс восьми. Хорошего вечера.'

describe('SpeechChunker', () => {
  it('emits an early first chunk of complete sentences and ends with a final chunk', () => {
    const deltas = words(REPLY)
    const out = run(deltas)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0].at).toBeLessThan(deltas.length)
    expect(out[0].text.length).toBeGreaterThanOrEqual(40)
    expect(out[0].text).toMatch(/[.!?]$/)
    expect(out.filter((c) => c.final)).toHaveLength(1)
    expect(out[out.length - 1].final).toBe(true)
    expect(out.map((c) => c.text).join(' ').trim()).toBe(REPLY.trim())
  })

  it('never splits a decimal number across chunks', () => {
    const out = run(['Число равно 3.', '14, а не 3.', '15. Это константа π, ', 'сэр. Кстати, ', 'её вычисляли тысячи лет.'])
    const joined = out.map((c) => c.text).join(' | ')
    expect(joined).toContain('3.14')
    expect(joined).not.toMatch(/3\. \|/)
  })

  it('speaks code blocks as a short phrase', () => {
    const out = run(words('Вот скрипт:\n```bash\nls -la\necho done\n```\nЗапустите его в терминале, сэр.'))
    const spoken = out.map((c) => c.text).join(' ')
    expect(spoken).toBe('Вот скрипт: Код — в чате. Запустите его в терминале, сэр.')
  })

  it('cuts after maxChars with "Остальное — в чате" and still sends a final chunk', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Предложение номер ${i + 1} про погоду и планы.`).join(' ')
    const out = run(words(long), { maxChars: 120 })
    const spokenText = out.map((c) => c.text).join(' ')
    expect(spokenText).toContain('Остальное — в чате, сэр.')
    const beforeCut = spokenText.slice(0, spokenText.indexOf('Остальное'))
    expect(beforeCut.length).toBeLessThanOrEqual(121)
    expect(out[out.length - 1].final).toBe(true)
    expect(out.filter((c) => c.final)).toHaveLength(1)
    // nothing after the cut phrase
    expect(spokenText.trim().endsWith('Остальное — в чате, сэр.')).toBe(true)
  })

  it('cuts inside a single over-long first sentence instead of staying silent', () => {
    const sentence = `${'очень длинное перечисление без точки, '.repeat(8)}конец.`
    const out = run([sentence], { maxChars: 100 })
    // the cut happens while streaming; the final chunk follows empty
    expect(out[0].text).toMatch(/…\s+Остальное — в чате, сэр\.$/)
    expect(out[0].text.length).toBeLessThanOrEqual(100 + ' Остальное — в чате, сэр.'.length)
    expect(out[out.length - 1]).toMatchObject({ text: '', final: true })
  })

  it('cuts at finish() when the over-long rest arrives in one piece', () => {
    const out: Array<{ text: string; final: boolean }> = []
    const chunker = new SpeechChunker({ maxChars: 100, userTitle: 'сэр', emit: (text, final) => out.push({ text, final }) })
    chunker.push('Короткое начало.')
    chunker.push(` ${'Ещё одно предложение про погоду. '.repeat(6)}`)
    chunker.finish()
    expect(out[out.length - 1].final).toBe(true)
    expect(out.filter((c) => c.final)).toHaveLength(1)
    const spoken = out.map((c) => c.text).join(' ').trim()
    expect(spoken).toMatch(/Остальное — в чате, сэр\.$/)
    expect(spoken.length).toBeLessThanOrEqual(100 + ' Остальное — в чате, сэр.'.length)
  })

  it('speaks the first clause of a long unfinished opening sentence early', () => {
    const first =
      'Сейчас я подробно расскажу, что происходит на экране, какие окна открыты, что в них написано, ' +
      'какие уведомления пришли за последний час, какие вкладки браузера открыты и какие программы запущены, '
    const deltas = [...words(first), ...words('и что можно сделать дальше без лишних действий с вашей стороны. Готово.')]
    const out = run(deltas)
    expect(out[0].at).toBeLessThan(deltas.length)
    expect(out[0].final).toBe(false)
    expect(out.map((c) => c.text).join(' ')).toBe(toSpeakableText(deltas.join('')))
  })

  it('emits only a final empty chunk when nothing is speakable', () => {
    expect(run([])).toEqual([{ text: '', final: true, at: 0 }])
    expect(run(['🙂', ' '])).toEqual([{ text: '', final: true, at: 2 }])
  })

  it('flush() speaks an unfinished sentence (model paused for a tool call)', () => {
    const out: Array<{ text: string; final: boolean }> = []
    const chunker = new SpeechChunker({ maxChars: 700, userTitle: 'сэр', emit: (text, final) => out.push({ text, final }) })
    chunker.push('Сейчас сделаю снимок экрана')
    expect(out).toEqual([])
    chunker.flush()
    expect(out).toEqual([{ text: 'Сейчас сделаю снимок экрана.', final: false }])
    chunker.push('\n\nНа экране тест из трёх вопросов.')
    chunker.finish()
    expect(out).toEqual([
      { text: 'Сейчас сделаю снимок экрана.', final: false },
      { text: 'На экране тест из трёх вопросов.', final: true }
    ])
  })

  it('cancel() stops all output, including the final chunk', () => {
    const out: string[] = []
    const chunker = new SpeechChunker({ maxChars: 700, userTitle: 'сэр', emit: (text) => out.push(text) })
    chunker.push('Первое предложение достаточно длинное, чтобы уйти сразу. Второе ')
    const before = out.length
    chunker.cancel()
    chunker.push('предложение. Третье.')
    chunker.finish()
    expect(out.length).toBe(before)
  })

  it('uses an English cut phrase for English replies', () => {
    const text = Array.from({ length: 10 }, (_, i) => `This is sentence number ${i + 1} about the weather.`).join(' ')
    const spoken = run(words(text), { maxChars: 100 })
      .map((c) => c.text)
      .join(' ')
    expect(spoken).toContain('The rest is in the chat, sir.')
    expect(cutPhrase('ru', '')).toBe('Остальное — в чате.')
    expect(cutPhrase('en', 'Tony')).toBe('The rest is in the chat, Tony.')
  })
})
