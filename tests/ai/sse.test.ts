import { describe, expect, it } from 'vitest'
import { SseParser, type SseEvent } from '../../src/main/ai/sse'

function parseInChunks(input: string | Uint8Array, sizes: number[] | number): SseEvent[] {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  const parser = new SseParser()
  const out: SseEvent[] = []
  let i = 0
  let n = 0
  while (i < bytes.length) {
    const size = Array.isArray(sizes) ? sizes[n % sizes.length] : sizes
    out.push(...parser.push(bytes.subarray(i, i + size)))
    i += size
    n++
  }
  out.push(...parser.end())
  return out
}

const STREAM =
  'event: response.output_text.delta\n' +
  'data: {"type":"response.output_text.delta","delta":"Привет, сэр 🙂"}\n\n' +
  ': keep-alive comment\n\n' +
  'event: response.completed\r\n' +
  'data: {"type":"response.completed"}\r\n\r\n' +
  'data: [DONE]\n\n'

describe('SseParser', () => {
  it('parses events with event:, data:, comments, CRLF and [DONE]', () => {
    const events = parseInChunks(STREAM, 1000)
    expect(events).toEqual([
      { event: 'response.output_text.delta', data: '{"type":"response.output_text.delta","delta":"Привет, сэр 🙂"}' },
      { event: 'response.completed', data: '{"type":"response.completed"}' },
      { event: 'message', data: '[DONE]' }
    ])
  })

  it('gives identical results for every chunking, including split UTF-8 and split CRLF', () => {
    const expected = parseInChunks(STREAM, 100000)
    for (const size of [1, 2, 3, 5, 7, 13]) expect(parseInChunks(STREAM, size)).toEqual(expected)
    expect(parseInChunks(STREAM, [1, 4, 2, 9, 3])).toEqual(expected)
  })

  it('does not treat a CR at a chunk end plus LF in the next chunk as two line breaks', () => {
    const parser = new SseParser()
    const out = [...parser.push('data: a\r'), ...parser.push('\ndata: b\r'), ...parser.push('\n\r'), ...parser.push('\n')]
    out.push(...parser.end())
    expect(out).toEqual([{ event: 'message', data: 'a\nb' }])
  })

  it('joins multi-line data with \\n and handles fields without a space or value', () => {
    const events = parseInChunks('data:line1\ndata: line2\ndata\ndata:  two spaces\n\n', 4)
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2\n\n two spaces' }])
  })

  it('ignores events without data, resets the event type and keeps the last id', () => {
    const events = parseInChunks('event: ping\n\nid: 7\nevent: x\ndata: 1\n\ndata: 2\n\n', 3)
    expect(events).toEqual([
      { event: 'x', data: '1', id: '7' },
      { event: 'message', data: '2', id: '7' }
    ])
  })

  it('strips a UTF-8 BOM and supports bare CR line endings', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('data: x\r\rdata: y\r\r')])
    expect(parseInChunks(bom, 2)).toEqual([
      { event: 'message', data: 'x' },
      { event: 'message', data: 'y' }
    ])
  })

  it('dispatches an unterminated trailing event at end()', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"a":1}')).toEqual([])
    expect(parser.end()).toEqual([{ event: 'message', data: '{"a":1}' }])
  })

  it('handles a large data line split into many chunks', () => {
    const big = 'x'.repeat(200_000)
    const events = parseInChunks(`data: ${big}\n\n`, 4096)
    expect(events).toHaveLength(1)
    expect(events[0].data).toHaveLength(200_000)
  })
})
