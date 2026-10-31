// ENTRY POINT CONTRACT (owned by the AI module): keep these exported signatures.
// Markdown → plain speakable text and sentence splitting for chunked TTS (Russian and English).

export type SpeechLang = 'ru' | 'en'

export interface SpeakableOptions {
  /** Language of inserted phrases ("Код — в чате."); detected from the text when omitted. */
  lang?: SpeechLang
}

const PHRASES: Record<SpeechLang, { code: string; table: string }> = {
  ru: { code: 'Код — в чате.', table: 'Таблица — в чате.' },
  en: { code: 'The code is in the chat.', table: 'The table is in the chat.' }
}

/** Sentences longer than this are split at clause boundaries (keeps TTS requests reasonable). */
export const MAX_SENTENCE_CHARS = 300

const EMOJI_RE =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'«»]*[^\s<>"'«».,;:!?)\]]/gi
const URL_TEST = /(?:https?:\/\/|www\.)\S/i
const DOMAIN_LIKE = /^(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?$/i
const LINK_RE = /\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g
const INLINE_CODE_MAX = 40

/** 'en' only for clearly English text; Russian otherwise (the default reply language). */
export function detectSpeechLang(text: string): SpeechLang {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const cyrillic = prose.match(/\p{Script=Cyrillic}/gu)?.length ?? 0
  const latin = prose.match(/[A-Za-z]/g)?.length ?? 0
  if (latin === 0) return 'ru'
  return cyrillic === 0 || latin > cyrillic * 4 ? 'en' : 'ru'
}

function ensureTerminal(text: string): string {
  const t = text.trim()
  if (!t) return ''
  return /[.!?…:;,]["'»”’)\]]*$/.test(t) ? t : `${t}.`
}

function stripEmphasis(input: string): string {
  return input
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)(.+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)\*+(?=\S)/g, '$1')
    .replace(/(?<=\S)\*+(?=\s|$|[.,!?;:])/g, '')
}

/** Inline markdown of one line → plain text. */
function speakInline(input: string): string {
  let s = input
    .replace(/``([^`]+)``|`([^`]+)`/g, (_m, a: string | undefined, b: string | undefined) => {
      const code = (a ?? b ?? '').trim()
      return code.length <= INLINE_CODE_MAX && !URL_TEST.test(code) ? code : ''
    })
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(LINK_RE, (_m, label: string) => {
      const t = label.trim()
      return DOMAIN_LIKE.test(t) || URL_TEST.test(t) ? '' : t
    })
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/<(?:https?|mailto):[^>\s]+>/gi, '')
    .replace(URL_RE, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
  s = stripEmphasis(s)
    .replace(/\$\$|\\\(|\\\)|\\\[|\\\]/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, '$1')
    .replace(/[`[\]]/g, '')
    .replace(/(?<=\p{L})_(?=\p{L})/gu, ' ')
    .replace(EMOJI_RE, '')
    .replace(/\s*(?:->|=>|→|⇒|⟶|<-|←)\s*/g, ' — ')
    .replace(/^\s*#+\s*/, '')
    .replace(/\(\s*[,;.]?\s*\)/g, '')
    .replace(/\.{3,}/g, '…')
    .replace(/(?<!\.)\.\.(?!\.)/g, '.')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s+([.,!?;:…»”)\]])/g, '$1')
    .replace(/([«“(])\s+/g, '$1')
    .trim()
  return /^[\s.,;:!?…—–\-|]*$/.test(s) ? '' : s
}

/** One markdown line (outside code blocks / tables) → speakable line, '' when nothing to say. */
function speakLine(raw: string): string {
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(raw)) return '' // horizontal rule / setext underline
  if (/^\s{0,3}=+\s*$/.test(raw)) return ''
  if (/^\s{0,3}\[[^\]]+\]:\s/.test(raw)) return '' // link / footnote definitions
  let line = raw.replace(/^(\s*>)+\s?/, '')
  let prefix = ''
  const heading = /^\s{0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line)
  if (heading) {
    line = heading[1] ?? ''
  } else {
    const ordered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      prefix = `${ordered[1]}) `
      line = ordered[2]
    } else {
      const bullet = /^\s*[-*+•▪●◦‣]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)
      if (bullet) line = bullet[1]
    }
  }
  const text = speakInline(line)
  return text ? ensureTerminal(prefix + text) : ''
}

/** Converts markdown to plain text suitable for TTS (no markup, code blocks replaced by a short phrase, URLs removed). */
export function toSpeakableText(markdown: string, opts: SpeakableOptions = {}): string {
  if (!markdown) return ''
  const phrases = PHRASES[opts.lang ?? detectSpeechLang(markdown)]
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split('\n')
  const out: string[] = []
  let fence: { char: string; len: number } | null = null
  let saidCode = false
  let saidTable = false
  let inTable = false
  const sayCode = (): void => {
    if (!saidCode) out.push(phrases.code)
    saidCode = true
  }
  for (const line of lines) {
    if (fence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null
      continue
    }
    const open = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open) {
      inTable = false
      sayCode()
      const marker = open[1]
      // A fence closed on the same line (```code```) is a one-line block.
      if (!open[2].includes(marker)) fence = { char: marker[0], len: marker.length }
      continue
    }
    if (/^\s*\|/.test(line)) {
      if (!inTable && !saidTable) out.push(phrases.table)
      saidTable = true
      inTable = true
      continue
    }
    inTable = false
    const spoken = speakLine(line)
    if (spoken) out.push(spoken)
  }
  return out.join('\n')
}

const TERMINALS = '.!?…'
const CLOSERS = `"'»”’)]`
/** Abbreviations that precede names or numbers and do not end sentences. */
const NO_SPLIT = new Set([
  'г', 'гг', 'ул', 'д', 'кв', 'стр', 'рис', 'см', 'им', 'проф', 'акад', 'доц', 'св', 'пр', 'просп', 'пер', 'пл',
  'обл', 'ст', 'тел', 'напр', 'т', 'ср', 'вып', 'изд', 'гл', 'п', 'пп', 'т.е', 'т.к', 'т.н', 'т.ч',
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'fig', 'approx', 'e.g', 'i.e', 'cf', 'mt', 'vol', 'pp'
])

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === ' '
const isLower = (c: string): boolean => /\p{Ll}/u.test(c)
const isInitial = (token: string): boolean => /^\p{Lu}$/u.test(token)

function tokenBefore(text: string, end: number, floor: number): { token: string; start: number } {
  let s = end
  while (s > floor && !/\s/.test(text[s - 1])) s--
  return { token: text.slice(s, end).replace(/^[«"'(\[“]+/, ''), start: s }
}

function isBoundary(text: string, sentenceStart: number, punctAt: number, punctEnd: number, nextAt: number): boolean {
  const next = text[nextAt]
  if (isLower(next)) return false
  const punct = text.slice(punctAt, punctEnd)
  if (/[!?…]/.test(punct) || punct.startsWith('...')) return true
  const { token, start } = tokenBefore(text, punctAt, sentenceStart)
  const lower = token.toLowerCase()
  if (NO_SPLIT.has(lower)) {
    // "и т. д." / "и т. п." do end sentences.
    const prev = tokenBefore(text, Math.max(sentenceStart, start - 1), sentenceStart).token.toLowerCase()
    if (!((lower === 'д' || lower === 'п') && prev === 'т.')) return false
  }
  if (/^\d{1,3}$/.test(text.slice(sentenceStart, punctAt).trim())) return false // "1. Пункт"
  if (isInitial(token)) {
    if (/^\p{Lu}\.(?:\s|$)/u.test(text.slice(nextAt, nextAt + 3))) return false // "А. С. Пушкин"
    if (/(?:^|\s)\p{Lu}\.$/u.test(text.slice(sentenceStart, start).trimEnd())) return false
  }
  return true
}

/**
 * Offsets (exclusive ends) of sentences that are confirmed by following text. The end of the text is never
 * reported: a trailing "3." may still become "3.14".
 */
export function sentenceBoundaries(text: string, from = 0): number[] {
  const ends: number[] = []
  let sentenceStart = from
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      if (text.slice(sentenceStart, i).trim()) ends.push(i)
      sentenceStart = i + 1
      continue
    }
    if (!TERMINALS.includes(c)) continue
    let j = i + 1
    while (j < text.length && TERMINALS.includes(text[j])) j++
    while (j < text.length && CLOSERS.includes(text[j])) j++
    if (j >= text.length) break
    if (!isSpace(text[j]) && text[j] !== '\n') {
      i = j - 1
      continue
    }
    let k = j
    while (k < text.length && isSpace(text[k])) k++
    if (k >= text.length) break
    if (text[k] === '\n' || !isBoundary(text, sentenceStart, i, j, k)) {
      i = k - 1
      continue
    }
    ends.push(j)
    sentenceStart = j
    i = j - 1
  }
  return ends
}

/** Best cut ≤ max in a long sentence: after , ; : or before a dash, else at a space, else hard. */
export function clauseCut(text: string, max: number): number {
  if (text.length <= max) return text.length
  const floor = Math.floor(max * 0.4)
  let best = -1
  for (const m of text.slice(0, max + 1).matchAll(/[,;:](?=\s)|\s(?=[—–]\s)/g)) {
    const at = m[0] === ' ' ? m.index : m.index + 1
    if (at >= floor && at <= max) best = at
  }
  if (best > 0) return best
  const space = text.lastIndexOf(' ', max)
  return space >= floor ? space : max
}

function splitLong(sentence: string, max: number): string[] {
  const parts: string[] = []
  let rest = sentence
  while (rest.length > max) {
    const cut = clauseCut(rest, max)
    const head = rest.slice(0, cut).trim()
    if (head) parts.push(head)
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/** Splits plain text into sentences for chunked TTS. */
export function splitSentences(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  let start = 0
  for (const end of [...sentenceBoundaries(text), text.length]) {
    const sentence = text.slice(start, end).replace(/\s+/g, ' ').trim()
    start = end
    if (sentence && !/^[\s.,;:!?…—–-]*$/.test(sentence)) out.push(...splitLong(sentence, MAX_SENTENCE_CHARS))
  }
  return out
}
