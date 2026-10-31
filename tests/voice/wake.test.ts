import { describe, expect, it } from 'vitest'
import { DEFAULT_WAKE_PHRASES } from '@shared/defaults'
import {
  editDistance,
  hasWords,
  isEchoOf,
  isLikelyHallucination,
  isStopCommand,
  matchWake,
  normalizeText,
  phoneticKey,
  stripWake
} from '@shared/wake'
import type { WakeSensitivity } from '@shared/types'

const PHRASES = DEFAULT_WAKE_PHRASES
const LEVELS: WakeSensitivity[] = ['low', 'medium', 'high']

describe('normalizeText', () => {
  it('lower-cases, maps ё to е and strips punctuation', () => {
    expect(normalizeText('Джарвис, Открой Калькулятор!')).toBe('джарвис открой калькулятор')
    expect(normalizeText('Ёлка — ЁЖИК…')).toBe('елка ежик')
    expect(normalizeText('  Hello,   WORLD?! ')).toBe('hello world')
  })

  it('drops recogniser annotations and apostrophes', () => {
    expect(normalizeText('[Музыка] Привет (смеётся) *шум*')).toBe('привет')
    expect(normalizeText("JARVIS's")).toBe('jarviss')
  })

  it('handles empty and punctuation-only input', () => {
    expect(normalizeText('')).toBe('')
    expect(normalizeText(' ... !!! ')).toBe('')
    expect(hasWords(' ... ')).toBe(false)
    expect(hasWords('да')).toBe(true)
  })
})

describe('phoneticKey / editDistance', () => {
  it('collapses Cyrillic and Latin spellings of Jarvis', () => {
    const key = phoneticKey('jarvis')
    for (const w of ['джарвис', 'жарвис', 'джарвиз', 'джарвисс', 'чарвис', 'jarviz', 'jarvys']) {
      expect(phoneticKey(w), w).toBe(key)
    }
  })

  it('computes optimal string alignment distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('abc', 'abc')).toBe(0)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('abc', '')).toBe(3)
    expect(editDistance('ab', 'ba')).toBe(1)
    expect(editDistance('jarivs', 'jarvis')).toBe(1)
    expect(editDistance('abcdef', 'uvwxyz', 2)).toBe(3)
  })
})

describe('matchWake — positives', () => {
  const cases: Array<[string, string]> = [
    ['Джарвис', ''],
    ['Джарвис.', ''],
    ['JARVIS!', ''],
    ['Джарвис, открой калькулятор', 'открой калькулятор'],
    ['Джарвис, сколько сейчас времени?', 'сколько сейчас времени?'],
    ['Jarvis, what time is it?', 'what time is it?'],
    ['Jarvis, открой калькулятор', 'открой калькулятор'],
    ['Жарвис, который час?', 'который час?'],
    ['Джарвиз открой телеграм', 'открой телеграм'],
    ['Джервис, привет', 'привет'],
    ['Джарвес, включи музыку', 'включи музыку'],
    ['Чарвис, сделай скриншот', 'сделай скриншот'],
    ['Jervis, open Safari', 'open Safari'],
    ['Эй, Джарвис, включи музыку', 'включи музыку'],
    ['Ну что, Джарвис, как дела?', 'как дела?'],
    ['Hey Jarvis turn on the lights', 'turn on the lights'],
    ['Джар Вис, открой почту', 'открой почту'],
    ['Джарвис, Джарвис, ты тут?', 'ты тут?'],
    ['Джарвис — открой Telegram.', 'открой Telegram.'],
    ['[Музыка] Джарвис, стоп', 'стоп']
  ]

  for (const [transcript, remainder] of cases) {
    it(`"${transcript}"`, () => {
      const m = matchWake(transcript, PHRASES, 'medium')
      expect(m.matched).toBe(true)
      expect(m.remainder).toBe(remainder)
      expect(m.matchedWord).toBeTruthy()
    })
  }

  it('reports the matched word and phrase', () => {
    const m = matchWake('Жарвис, Открой Telegram.', PHRASES, 'medium')
    expect(m).toEqual({ matched: true, remainder: 'Открой Telegram.', matchedWord: 'Жарвис', phrase: 'джарвис' })
  })

  it('accepts known misrecognitions even at low sensitivity', () => {
    for (const t of ['Джервис, привет', 'Жарвис привет', 'Jervis hello', 'Джарвиз', 'Javas.', 'Jarverse, what time is it?']) {
      expect(matchWake(t, PHRASES, 'low').matched, t).toBe(true)
    }
  })
})

describe('matchWake — negatives', () => {
  const negatives = [
    'Дарвин был великим учёным',
    'Джавид пришёл домой',
    'Сегодня очень жарко',
    'Жарко сегодня, правда?',
    'Привет, как дела',
    'Как дела?',
    'Открой калькулятор',
    'Я вчера долго говорил с другом про Джарвис',
    'Davis is here',
    'Travis Scott',
    'Харвест мун',
    'Продолжение следует...',
    'Субтитры сделал DimaTorzok',
    'Спасибо за просмотр!',
    '',
    '   ...  ',
    '[Музыка]'
  ]

  for (const transcript of negatives) {
    it(`"${transcript}" at every sensitivity`, () => {
      for (const level of LEVELS) {
        expect(matchWake(transcript, PHRASES, level), level).toEqual({ matched: false, remainder: '' })
      }
    })
  }

  it('requires the wake word within the first 3 words', () => {
    expect(matchWake('раз два три Джарвис', PHRASES, 'high').matched).toBe(false)
    expect(matchWake('раз два Джарвис', PHRASES, 'medium').matched).toBe(true)
  })
})

describe('matchWake — sensitivity', () => {
  it('low rejects fuzzy variants that medium accepts', () => {
    expect(matchWake('Джорвис, привет', PHRASES, 'low').matched).toBe(false)
    expect(matchWake('Джорвис, привет', PHRASES, 'medium').matched).toBe(true)
  })

  it('high accepts distance-2 variants that keep the first and last sound', () => {
    expect(matchWake('Джорвес, привет', PHRASES, 'medium').matched).toBe(false)
    expect(matchWake('Джорвес, привет', PHRASES, 'high')).toMatchObject({ matched: true, remainder: 'привет' })
    expect(matchWake('Джарвисон', PHRASES, 'high').matched).toBe(false)
  })
})

describe('matchWake — custom phrases', () => {
  it('matches a custom single-word phrase and ignores Jarvis', () => {
    expect(matchWake('Пятница, открой почту', ['пятница'], 'medium')).toMatchObject({
      matched: true,
      remainder: 'открой почту'
    })
    expect(matchWake('Джарвис, открой почту', ['пятница'], 'medium').matched).toBe(false)
  })

  it('matches multi-word phrases, also when the recogniser merges words', () => {
    expect(matchWake('Окей, компьютер, который час?', ['окей компьютер'], 'medium')).toMatchObject({
      matched: true,
      remainder: 'который час?'
    })
    expect(matchWake('Окейкомпьютер который час', ['окей компьютер'], 'medium').matched).toBe(true)
    expect(matchWake('Эй Жарвис, привет', ['эй джарвис'], 'medium')).toMatchObject({ matched: true, remainder: 'привет' })
  })

  it('tolerates messy phrase input and rejects empty phrase lists', () => {
    expect(matchWake('Джарвис, привет', ['  ДЖАРВИС! '], 'medium').matched).toBe(true)
    expect(matchWake('Джарвис, привет', [], 'medium').matched).toBe(false)
    expect(matchWake('Джарвис, привет', ['', '  '], 'medium').matched).toBe(false)
  })

  it('does not fuzzy-match very short phrases', () => {
    expect(matchWake('Мак, привет', ['макс'], 'medium').matched).toBe(true)
    expect(matchWake('Мир, привет', ['мир'], 'high').matched).toBe(true)
    expect(matchWake('Мор, привет', ['мир'], 'high').matched).toBe(false)
  })
})

describe('stripWake', () => {
  it('removes a leading wake word and keeps other text intact', () => {
    expect(stripWake('Джарвис, открой калькулятор', PHRASES, 'medium')).toBe('открой калькулятор')
    expect(stripWake('открой калькулятор', PHRASES, 'medium')).toBe('открой калькулятор')
    expect(stripWake('  Джарвис  ', PHRASES, 'medium')).toBe('')
  })
})

describe('isLikelyHallucination / isStopCommand', () => {
  it('flags typical recogniser artefacts only', () => {
    expect(isLikelyHallucination('Продолжение следует...')).toBe(true)
    expect(isLikelyHallucination('Субтитры сделал DimaTorzok')).toBe(true)
    expect(isLikelyHallucination('Thanks for watching!')).toBe(true)
    expect(isLikelyHallucination('  ...  ')).toBe(true)
    expect(isLikelyHallucination('Открой калькулятор')).toBe(false)
    expect(isLikelyHallucination('Спасибо')).toBe(false)
  })

  it('recognises stop commands', () => {
    for (const t of ['Стоп', 'стоп!', 'Хватит.', 'Замолчи, пожалуйста', 'Stop', 'shut up', 'Отмена']) {
      expect(isStopCommand(t), t).toBe(true)
    }
    for (const t of ['стоп машина', 'Открой калькулятор', 'хватит ли места на диске', '']) {
      expect(isStopCommand(t), t).toBe(false)
    }
  })
})

describe('isEchoOf', () => {
  it('detects our own speech picked up by the microphone', () => {
    expect(isEchoOf('Джарвис к вашим услугам', ['Джарвис к вашим услугам, сэр.'])).toBe(true)
    expect(isEchoOf('сейчас пятнадцать часов', ['Сейчас пятнадцать часов тридцать минут, сэр.'])).toBe(true)
    expect(isEchoOf('Да сэр', ['Да, сэр?'])).toBe(true)
  })

  it('does not suppress real user speech', () => {
    expect(isEchoOf('Джарвис, стоп', ['Сегодня солнечно и тепло, сэр.'])).toBe(false)
    expect(isEchoOf('открой калькулятор', [])).toBe(false)
    expect(isEchoOf('', ['что угодно'])).toBe(false)
  })
})
