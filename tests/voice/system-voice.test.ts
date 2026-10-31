import { describe, expect, it } from 'vitest'
import { importRenderer, type SystemVoiceModule, type VoiceLike } from './support/renderer'

const { detectTextLanguage, pickVoice } = await importRenderer<SystemVoiceModule>('voice/system-voice')

const v = (name: string, lang: string, localService = true): VoiceLike => ({ name, lang, localService })

const MAC = [
  v('Samantha', 'en-US'),
  v('Daniel', 'en-GB'),
  v('Karen', 'en-AU'),
  v('Yuri', 'ru-RU'),
  v('Milena', 'ru-RU'),
  v('Thomas', 'fr-FR')
]
const WINDOWS = [
  v('Microsoft David - English (United States)', 'en-US'),
  v('Microsoft George - English (United Kingdom)', 'en-GB'),
  v('Microsoft Irina - Russian (Russia)', 'ru-RU'),
  v('Microsoft Pavel - Russian (Russia)', 'ru-RU')
]

describe('detectTextLanguage', () => {
  it('classifies Cyrillic and Latin text', () => {
    expect(detectTextLanguage('Сейчас три часа, сэр.')).toBe('ru')
    expect(detectTextLanguage('It is three o’clock, sir.')).toBe('en')
    expect(detectTextLanguage('Открыл Telegram, сэр.')).toBe('ru')
    expect(detectTextLanguage('12:30')).toBe('en')
  })
})

describe('pickVoice', () => {
  it('prefers Milena for Russian and Daniel (en-GB) for English on macOS', () => {
    expect(pickVoice(MAC, 'Готово, сэр.', '')?.name).toBe('Milena')
    expect(pickVoice(MAC, 'Done, sir.', '')?.name).toBe('Daniel')
  })

  it('recognises localized macOS voice names', () => {
    const ru = [v('Юрий', 'ru-RU'), v('Милена', 'ru-RU'), v('Милена (улучшенный)', 'ru-RU')]
    expect(pickVoice(ru, 'Готово', '')?.name).toBe('Милена (улучшенный)')
  })

  it('picks the Windows voices by language', () => {
    expect(pickVoice(WINDOWS, 'Готово', '')?.name).toBe('Microsoft Pavel - Russian (Russia)')
    expect(pickVoice(WINDOWS, 'Done', '')?.name).toBe('Microsoft George - English (United Kingdom)')
  })

  it('uses the configured voice when it speaks the language of the text', () => {
    expect(pickVoice(MAC, 'Готово', 'Yuri')?.name).toBe('Yuri')
    expect(pickVoice(MAC, 'Готово', 'yuri')?.name).toBe('Yuri')
    // Daniel cannot read Russian: the best Russian voice wins.
    expect(pickVoice(MAC, 'Готово', 'Daniel')?.name).toBe('Milena')
    // …unless no voice for that language is installed.
    expect(pickVoice([v('Daniel', 'en-GB')], 'Готово', 'Daniel')?.name).toBe('Daniel')
  })

  it('returns null when nothing fits', () => {
    expect(pickVoice([], 'Готово', '')).toBeNull()
    expect(pickVoice([v('Thomas', 'fr-FR')], 'Готово', '')).toBeNull()
  })
})
