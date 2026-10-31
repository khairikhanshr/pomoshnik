// OS voices through the Web Speech API (speechSynthesis): voice choice by text language and a promise wrapper.

export interface VoiceLike {
  name: string
  lang: string
  localService: boolean
}

export type TextLanguage = 'ru' | 'en'

// macOS reports voice names localized to the system language ("Милена" on a Russian system).
const PREFERRED: Record<TextLanguage, string[]> = {
  ru: [
    'milena', 'милена', 'yuri', 'юрий', 'pavel', 'павел', 'irina', 'ирина', 'dmitri', 'дмитрий', 'katya', 'катя',
    'svetlana', 'светлана', 'ekaterina', 'екатерина', 'dariya', 'дария', 'google русский'
  ],
  en: [
    'daniel', 'дэниел', 'arthur', 'артур', 'george', 'джордж', 'oliver', 'оливер', 'ryan', 'thomas', 'hazel',
    'serena', 'kate', 'google uk english male'
  ]
}

export function detectTextLanguage(text: string): TextLanguage {
  let cyr = 0
  let lat = 0
  for (const ch of text) {
    if (/[Ѐ-ӿ]/.test(ch)) cyr++
    else if (/[a-z]/i.test(ch)) lat++
  }
  return cyr > 0 && cyr >= lat * 0.3 ? 'ru' : 'en'
}

function rank(voice: VoiceLike, lang: TextLanguage): number {
  const name = voice.name.toLowerCase()
  const pref = PREFERRED[lang].findIndex((p) => name.includes(p))
  let score = pref >= 0 ? 100 - pref * 5 : 0
  if (lang === 'en' && /^en[-_]gb/i.test(voice.lang)) score += 40
  if (/premium|enhanced|улучш/i.test(name)) score += 10
  if (voice.localService) score += 5
  return score
}

/**
 * The configured voice when it speaks the text's language (or nothing better exists), otherwise the best
 * voice for that language (ru-RU: Milena, Yuri, Pavel, Irina…; en-GB: Daniel…).
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], text: string, preferredName: string): V | null {
  if (!voices.length) return null
  const lang = detectTextLanguage(text)
  const forLang = voices.filter((v) => v.lang.toLowerCase().startsWith(lang))
  const wanted = preferredName.trim().toLowerCase()
  if (wanted) {
    const preferred = voices.find((v) => v.name.toLowerCase() === wanted)
    if (preferred && (preferred.lang.toLowerCase().startsWith(lang) || !forLang.length)) return preferred
  }
  if (!forLang.length) return null
  return [...forLang].sort((a, b) => rank(b, lang) - rank(a, lang))[0]
}

export async function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === 'undefined') return []
  const now = speechSynthesis.getVoices()
  if (now.length) return now
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      speechSynthesis.removeEventListener('voiceschanged', done)
      resolve(speechSynthesis.getVoices())
    }
    const timer = setTimeout(done, timeoutMs)
    speechSynthesis.addEventListener('voiceschanged', done)
  })
}

export interface SystemUtterance {
  done: Promise<void>
  cancel(): void
}

// Chromium may garbage-collect an utterance before its events fire unless it stays referenced.
const live = new Set<SpeechSynthesisUtterance>()

/** Speaks one utterance; `done` resolves on end, error or cancel (never rejects). */
export function speakSystem(text: string, voice: SpeechSynthesisVoice | null, rate: number): SystemUtterance {
  const u = new SpeechSynthesisUtterance(text)
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  } else {
    u.lang = detectTextLanguage(text) === 'ru' ? 'ru-RU' : 'en-GB'
  }
  u.rate = Math.max(0.5, Math.min(2, rate || 1))
  live.add(u)
  let finish: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    // Some voices never fire 'end'; give up after a generous estimate of the speaking time.
    const watchdog = setTimeout(() => finish(), Math.min(120_000, 3000 + (text.length * 110) / u.rate))
    finish = () => {
      clearTimeout(watchdog)
      live.delete(u)
      resolve()
    }
  })
  u.onend = () => finish()
  u.onerror = () => finish()
  speechSynthesis.speak(u)
  return {
    done,
    cancel: () => {
      speechSynthesis.cancel()
      finish()
    }
  }
}
