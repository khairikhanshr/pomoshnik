// Turns a streaming markdown reply into speakable chunks at sentence boundaries:
// an early first chunk, grouped later chunks, a cut after maxSpokenChars and always a final chunk.
import {
  clauseCut,
  detectSpeechLang,
  sentenceBoundaries,
  toSpeakableText,
  type SpeechLang
} from '@shared/speech-text'

export interface SpeechChunkerOptions {
  /** settings.maxSpokenChars */
  maxChars: number
  userTitle: string
  emit: (text: string, final: boolean) => void
  /** The first chunk goes out once this many characters of complete sentences exist. */
  firstChunkChars?: number
  /** Later chunks group sentences up to at least this many characters. */
  chunkChars?: number
  /** An unfinished first sentence this long is spoken up to its last clause boundary. */
  forceFirstChars?: number
}

const FIRST_CHUNK_CHARS = 40
const CHUNK_CHARS = 120
const FORCE_FIRST_CHARS = 160
/** Re-scan the text only when a sentence may have ended or enough new text arrived. */
const RESCAN_CHARS = 32

/** "Остальное — в чате, сэр." in the reply language. */
export function cutPhrase(lang: SpeechLang, userTitle: string): string {
  const title = userTitle.trim()
  if (lang === 'en') {
    const cyrillic = /\p{Script=Cyrillic}/u.test(title)
    const en = cyrillic ? (title.toLowerCase() === 'сэр' ? 'sir' : '') : title
    return `The rest is in the chat${en ? `, ${en}` : ''}.`
  }
  return `Остальное — в чате${title ? `, ${title}` : ''}.`
}

export class SpeechChunker {
  private raw = ''
  /** Offset in the speakable text up to which chunks were handed out. */
  private sent = 0
  private spoken = 0
  private chunks = 0
  private lang: SpeechLang | null = null
  private state: 'open' | 'cut' | 'closed' = 'open'
  private scannedAt = 0
  private readonly firstChars: number
  private readonly nextChars: number
  private readonly forceChars: number

  constructor(private readonly opts: SpeechChunkerOptions) {
    this.firstChars = opts.firstChunkChars ?? FIRST_CHUNK_CHARS
    this.nextChars = opts.chunkChars ?? CHUNK_CHARS
    this.forceChars = opts.forceFirstChars ?? FORCE_FIRST_CHARS
  }

  /** True once a non-empty chunk was emitted. */
  get hasSpoken(): boolean {
    return this.chunks > 0
  }

  get closed(): boolean {
    return this.state === 'closed'
  }

  push(delta: string): void {
    if (this.state !== 'open' || !delta) return
    this.raw += delta
    if (!/[.!?…\n]/.test(delta) && this.raw.length - this.scannedAt < RESCAN_CHARS) return
    this.process('stream')
  }

  /** The model paused (e.g. before a tool call): speak everything written so far. */
  flush(): void {
    if (this.state === 'open') this.process('flush')
  }

  /** End of the reply: speaks the rest and always emits a `final` chunk. */
  finish(): void {
    if (this.state === 'closed') return
    if (this.state === 'open') this.process('final')
    else this.opts.emit('', true)
    this.state = 'closed'
  }

  /** Stops without a final chunk (cancelled or failed turn). */
  cancel(): void {
    this.state = 'closed'
  }

  private process(mode: 'stream' | 'flush' | 'final'): void {
    this.scannedAt = this.raw.length
    const text = toSpeakableText(this.raw, { lang: this.lang ?? detectSpeechLang(this.raw) })
    if (this.sent > text.length) this.sent = text.length
    const end = mode === 'stream' ? this.streamEnd(text) : text.length
    if (mode === 'stream' && end <= this.sent) return
    this.send(text.slice(this.sent, end), end, mode === 'final')
  }

  /** End offset for the next streaming chunk; ≤ sent means "wait". */
  private streamEnd(text: string): number {
    const bounds = sentenceBoundaries(text, this.sent)
    const last = bounds.length ? bounds[bounds.length - 1] : -1
    const min = this.chunks === 0 ? this.firstChars : this.nextChars
    if (last > this.sent && text.slice(this.sent, last).trim().length >= min) return last
    if (this.chunks > 0 || text.length - this.sent < this.forceChars) return this.sent
    // A long opening sentence is still streaming: speak up to its last confirmed clause or word.
    const open = text.slice(this.sent, text.length - 1)
    let cut = -1
    for (const m of open.matchAll(/[,;:](?=\s)|\s(?=[—–]\s)/g)) {
      if (m.index >= this.firstChars) cut = m[0] === ' ' ? m.index : m.index + 1
    }
    if (cut < 0) {
      const space = open.lastIndexOf(' ')
      cut = space >= this.firstChars ? space : -1
    }
    return cut < 0 ? this.sent : this.sent + cut
  }

  private send(slice: string, end: number, final: boolean): void {
    const chunk = slice.replace(/\s+/g, ' ').trim()
    if (!this.lang && chunk) this.lang = detectSpeechLang(this.raw)
    this.sent = end
    const budget = this.opts.maxChars - this.spoken
    if (chunk.length > budget) {
      const part = this.fit(chunk, budget)
      this.state = final ? 'closed' : 'cut'
      this.out(`${part ? `${part} ` : ''}${cutPhrase(this.lang ?? 'ru', this.opts.userTitle)}`, final)
      return
    }
    if (chunk) this.out(chunk, final)
    else if (final) this.opts.emit('', true)
  }

  /** Longest prefix of whole sentences within the budget. */
  private fit(chunk: string, budget: number): string {
    if (budget <= 0) return ''
    const ends = sentenceBoundaries(chunk).filter((b) => b <= budget)
    if (ends.length) return chunk.slice(0, ends[ends.length - 1]).trim()
    if (this.spoken > 0) return ''
    // Nothing said yet: part of the first sentence beats silence.
    const head = chunk
      .slice(0, clauseCut(chunk, budget))
      .trim()
      .replace(/[\s,;:—–-]+$/, '')
    return head ? `${head}…` : ''
  }

  private out(text: string, final: boolean): void {
    this.chunks++
    this.spoken += text.length
    this.opts.emit(text, final)
  }
}
