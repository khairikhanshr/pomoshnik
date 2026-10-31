// Wake-word matching on (possibly misrecognised) speech transcripts, Cyrillic and Latin.
// Words are compared by a phonetic key so that "Джарвис", "Жарвис", "Jarvis" and "Джарвиз" collapse together,
// then fuzzily (Damerau-Levenshtein) with a tolerance that depends on the sensitivity and word length.
import type { WakeSensitivity } from './types'

export interface WakeMatch {
  matched: boolean
  /** Transcript text after the wake word (original casing and punctuation, leading separators removed). */
  remainder: string
  /** The transcript word(s) recognised as the wake word. */
  matchedWord?: string
  /** The configured phrase that matched. */
  phrase?: string
}

/** The wake word has to start within the first N words of the transcript. */
export const WAKE_MAX_WORD_INDEX = 3

/**
 * Misrecognitions of "Джарвис" seen from speech recognisers (incl. Whisper on the non-rhotic British
 * "Jah-vis"); accepted exactly (after phonetic folding) at every sensitivity.
 */
const JARVIS_VARIANTS = [
  'джарвиз',
  'джарвес',
  'джервис',
  'джерфис',
  'джарвисс',
  'джаврис',
  'джарви',
  'джаверс',
  'джарверс',
  'жарвис',
  'чарвис',
  'jarvis',
  'jervis',
  'jarviz',
  'jarves',
  'javis',
  'javas',
  'jarvas',
  'jarvus',
  'jarverse',
  'jarvers',
  'javers',
  'jarvi',
  'jarvys',
  'charvis'
]

/** Lower-case, ё→е, punctuation and annotations ("[музыка]") removed, whitespace collapsed. */
export function normalizeText(text: string): string {
  return tokenize(text)
    .map((t) => t.norm)
    .join(' ')
}

interface Token {
  norm: string
  key: string
  start: number
  end: number
}

const ANNOTATION_RE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

function normalizeWord(word: string): string {
  return word
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/['’]/g, '')
    .replace(/\p{M}/gu, '')
}

function tokenize(text: string): Token[] {
  // Blank annotations out with spaces so token offsets still index the original string.
  const cleaned = (text ?? '').replace(ANNOTATION_RE, (m) => ' '.repeat(m.length))
  const tokens: Token[] = []
  for (const m of cleaned.matchAll(WORD_RE)) {
    const norm = normalizeWord(m[0])
    if (!norm) continue
    tokens.push({ norm, key: phoneticKey(norm), start: m.index, end: m.index + m[0].length })
  }
  return tokens
}

const CYRILLIC_TO_PHONETIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'j', з: 's', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 's', ч: 'j', ш: 's', щ: 's',
  ъ: '', ы: 'i', ь: '', э: 'e', ю: 'u', я: 'a', і: 'i', ї: 'i', є: 'e', ў: 'u', ғ: 'g', қ: 'k', ң: 'n',
  ө: 'o', ұ: 'u', ү: 'u', һ: 'h', ә: 'a'
}

const LATIN_TO_PHONETIC: Record<string, string> = { z: 's', w: 'v', y: 'i', c: 'k', q: 'k', x: 'ks' }

/** Script-independent approximation of how a normalised word sounds. */
export function phoneticKey(word: string): string {
  const w = word
    .replace(/дж/g, 'j')
    .replace(/ph/g, 'f')
    .replace(/sh/g, 's')
    .replace(/th/g, 't')
    .replace(/ch/g, 'k')
  let out = ''
  for (const ch of w) {
    const mapped = CYRILLIC_TO_PHONETIC[ch] ?? LATIN_TO_PHONETIC[ch] ?? ch
    for (const c of mapped) {
      if (c !== out[out.length - 1]) out += c
    }
  }
  return out
}

/** Optimal-string-alignment distance (Levenshtein + adjacent transpositions), capped at `max + 1`. */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const n = b.length
  let prevPrev = new Array<number>(n + 1).fill(0)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let cur = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prevPrev[j - 2] + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    ;[prevPrev, prev, cur] = [prev, cur, prevPrev]
  }
  return Math.min(prev[n], max + 1)
}

/**
 * Allowed edit distance for a phrase key of the given length. At 'high', distance-2 matches must keep the
 * first and last sound (rejects "Дарвин", "Джавид", "Davis" while accepting e.g. "Джарвисы").
 */
function tolerance(len: number, sensitivity: WakeSensitivity): { max: number; anchoredFrom: number } {
  switch (sensitivity) {
    case 'low':
      return { max: len >= 8 ? 1 : 0, anchoredFrom: Infinity }
    case 'high':
      if (len <= 3) return { max: 0, anchoredFrom: Infinity }
      if (len <= 5) return { max: 1, anchoredFrom: Infinity }
      return { max: len >= 10 ? 3 : 2, anchoredFrom: len >= 10 ? 3 : 2 }
    default:
      if (len <= 3) return { max: 0, anchoredFrom: Infinity }
      return { max: len >= 10 ? 2 : 1, anchoredFrom: Infinity }
  }
}

interface Candidate {
  phrase: string
  /** Phonetic key of the phrase with spaces removed (ASR may split or merge words). */
  key: string
  words: number
  exact: boolean
}

const variantKeys = JARVIS_VARIANTS.map(phoneticKey)
const JARVIS_KEY = phoneticKey('jarvis')

function candidatesFor(phrases: readonly string[]): Candidate[] {
  const out: Candidate[] = []
  for (const raw of phrases) {
    const words = tokenize(raw)
    if (!words.length) continue
    const phrase = words.map((w) => w.norm).join(' ')
    const key = words.map((w) => w.key).join('')
    out.push({ phrase, key, words: words.length, exact: false })
    // Known misrecognitions apply to any phrase that is itself a spelling of "Jarvis" (also "эй джарвис").
    const last = words[words.length - 1]
    if (editDistance(last.key, JARVIS_KEY, 1) <= 1) {
      const prefix = words
        .slice(0, -1)
        .map((w) => w.key)
        .join('')
      for (const v of variantKeys) out.push({ phrase, key: prefix + v, words: words.length, exact: true })
    }
  }
  return out
}

interface Hit {
  phrase: string
  startToken: number
  endToken: number
  distance: number
}

function scoreSpan(span: string, c: Candidate, sensitivity: WakeSensitivity): number | null {
  if (c.exact) return span === c.key ? 0 : null
  const { max, anchoredFrom } = tolerance(c.key.length, sensitivity)
  const d = editDistance(span, c.key, max)
  if (d > max) return null
  if (d >= anchoredFrom && (span[0] !== c.key[0] || span[span.length - 1] !== c.key[c.key.length - 1])) return null
  return d
}

function findWake(tokens: Token[], candidates: Candidate[], sensitivity: WakeSensitivity, maxStart: number): Hit | null {
  const hits: Hit[] = []
  const lastStart = Math.min(maxStart, tokens.length)
  for (let i = 0; i < lastStart; i++) {
    for (const c of candidates) {
      for (let len = Math.max(1, c.words - 1); len <= c.words + 1 && i + len <= tokens.length; len++) {
        const span = tokens
          .slice(i, i + len)
          .map((t) => t.key)
          .join('')
        const d = scoreSpan(span, c, sensitivity)
        if (d !== null) hits.push({ phrase: c.phrase, startToken: i, endToken: i + len - 1, distance: d })
      }
    }
    // An exact hit ends the search; a fuzzy one can still be beaten by a closer match a word later.
    if (hits.some((h) => h.distance === 0)) break
  }
  let best: Hit | null = null
  for (const h of hits) if (!best || h.distance < best.distance) best = h
  return best
}

const LEADING_SEPARATORS = /^[\s\p{P}\p{S}]+/u

/**
 * Finds a wake phrase among the first words of a transcript.
 * `remainder` is the command spoken after the wake word ('' for a bare wake word).
 */
export function matchWake(transcript: string, phrases: readonly string[], sensitivity: WakeSensitivity): WakeMatch {
  const text = transcript ?? ''
  const candidates = candidatesFor(phrases)
  let tokens = tokenize(text)
  if (!tokens.length || !candidates.length) return { matched: false, remainder: '' }

  const hit = findWake(tokens, candidates, sensitivity, WAKE_MAX_WORD_INDEX)
  if (!hit) return { matched: false, remainder: '' }

  const matchedWord = text.slice(tokens[hit.startToken].start, tokens[hit.endToken].end)
  let cut = tokens[hit.endToken].end
  // "Джарвис, Джарвис, открой…" — drop repeated wake words right after the first one.
  for (;;) {
    tokens = tokens.filter((t) => t.start >= cut)
    const again = findWake(tokens, candidates, sensitivity, 1)
    if (!again) break
    cut = tokens[again.endToken].end
  }
  const remainder = text.slice(cut).replace(LEADING_SEPARATORS, '').trim()
  return { matched: true, remainder, matchedWord, phrase: hit.phrase }
}

/** Command text without a leading wake word (used for push-to-talk and follow-up commands). */
export function stripWake(transcript: string, phrases: readonly string[], sensitivity: WakeSensitivity): string {
  const m = matchWake(transcript, phrases, sensitivity)
  return (m.matched ? m.remainder : transcript).trim()
}

/** True when the text contains at least one word (letters or digits). */
export function hasWords(text: string): boolean {
  return tokenize(text).length > 0
}

/** Phrases speech recognisers (Whisper especially) produce for silence, music or noise. */
const HALLUCINATIONS = [
  'продолжение следует',
  'субтитры сделал',
  'субтитры создавал',
  'субтитры подготовил',
  'субтитры делал',
  'редактор субтитров',
  'спасибо за просмотр',
  'подписывайтесь на канал',
  'ставьте лайки',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'subtitles by',
  'amara org'
]

/** True for transcripts that are almost certainly recogniser artefacts rather than speech. */
export function isLikelyHallucination(transcript: string): boolean {
  const text = normalizeText(transcript)
  if (!text) return true
  if (text.split(' ').length > 10) return false
  return HALLUCINATIONS.some((h) => text === h || text.startsWith(`${h} `))
}

const STOP_COMMANDS = new Set([
  'стоп',
  'хватит',
  'замолчи',
  'замолкни',
  'помолчи',
  'тихо',
  'тише',
  'отмена',
  'отмени',
  'остановись',
  'прекрати',
  'достаточно',
  'stop',
  'cancel',
  'enough',
  'quiet',
  'be quiet',
  'shut up',
  'never mind',
  'nevermind'
])

/** "Стоп", "Хватит", "Stop"… — a command that only means "stop talking / cancel". */
export function isStopCommand(command: string): boolean {
  const text = normalizeText(command).replace(/\s*(пожалуйста|please)$/, '')
  return STOP_COMMANDS.has(text)
}

/**
 * Echo guard: does the transcript look like our own speech picked up by the microphone?
 * True when most of its words occur in the recently spoken text.
 */
export function isEchoOf(transcript: string, spokenTexts: readonly string[], threshold = 0.6): boolean {
  const heard = tokenize(transcript).map((t) => t.key)
  if (!heard.length) return false
  const spoken = new Set(spokenTexts.flatMap((s) => tokenize(s).map((t) => t.key)))
  if (!spoken.size) return false
  let hits = 0
  for (const w of heard) {
    if (spoken.has(w)) {
      hits++
      continue
    }
    if (w.length >= 5) {
      for (const s of spoken) {
        if (Math.abs(s.length - w.length) <= 1 && editDistance(w, s, 1) <= 1) {
          hits++
          break
        }
      }
    }
  }
  return hits / heard.length >= threshold
}
