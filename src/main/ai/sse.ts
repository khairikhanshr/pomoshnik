// Incremental Server-Sent Events parser (WHATWG event-stream rules).
// Chunks may split lines, CRLF pairs or multi-byte UTF-8 sequences anywhere.

export interface SseEvent {
  /** `event:` field; 'message' when absent. Synthetic 'json' = non-streamed JSON body (see http.ts). */
  event: string
  data: string
  id?: string
}

const LF = 10
const CR = 13
const COLON = 58
const SPACE = 32

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8')
  /** Tail of the current line (never contains CR/LF). */
  private line = ''
  /** The previous chunk ended with CR: a leading LF in the next chunk belongs to it. */
  private skipLf = false
  private started = false
  private data: string[] = []
  private eventType = ''
  private lastId: string | undefined

  push(chunk: Uint8Array | string): SseEvent[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    const out: SseEvent[] = []
    this.feed(text, out)
    return out
  }

  /** Flushes the decoder and dispatches a trailing event that was not terminated by a blank line. */
  end(): SseEvent[] {
    const out: SseEvent[] = []
    this.feed(this.decoder.decode(), out)
    if (this.line) {
      this.processLine(this.line, out)
      this.line = ''
    }
    this.dispatch(out)
    return out
  }

  private feed(input: string, out: SseEvent[]): void {
    let text = input
    if (!text) return
    if (!this.started) {
      this.started = true
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    let i = 0
    if (this.skipLf && text.length > 0) {
      if (text.charCodeAt(0) === LF) i = 1
      this.skipLf = false
    }
    let start = i
    for (; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c !== LF && c !== CR) continue
      const line = this.line + text.slice(start, i)
      this.line = ''
      this.processLine(line, out)
      if (c === CR) {
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === LF) i++
        } else {
          this.skipLf = true
        }
      }
      start = i + 1
    }
    if (start < text.length) this.line += text.slice(start)
  }

  private processLine(line: string, out: SseEvent[]): void {
    if (line === '') {
      this.dispatch(out)
      return
    }
    if (line.charCodeAt(0) === COLON) return
    const colon = line.indexOf(':')
    let field = line
    let value = ''
    if (colon !== -1) {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.charCodeAt(0) === SPACE) value = value.slice(1)
    }
    switch (field) {
      case 'event':
        this.eventType = value
        break
      case 'data':
        this.data.push(value)
        break
      case 'id':
        if (!value.includes('\0')) this.lastId = value
        break
      default:
        // `retry` and unknown fields are irrelevant for a single HTTP response.
        break
    }
  }

  private dispatch(out: SseEvent[]): void {
    const data = this.data.join('\n')
    const event = this.eventType || 'message'
    this.data = []
    this.eventType = ''
    if (!data) return
    const ev: SseEvent = { event, data }
    if (this.lastId !== undefined) ev.id = this.lastId
    out.push(ev)
  }
}
