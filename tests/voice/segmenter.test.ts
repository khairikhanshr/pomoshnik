import { describe, expect, it } from 'vitest'
import {
  importRenderer,
  type Segment,
  type SegmenterEvents,
  type SegmenterInstance,
  type SegmenterModule
} from './support/renderer'

const { Segmenter } = await importRenderer<SegmenterModule>('voice/segmenter')

const FRAME = 512 // 32 ms at 16 kHz

function frame(value: number): Float32Array {
  return new Float32Array(FRAME).fill(value)
}

function recorder() {
  const log: string[] = []
  const segments: Segment[] = []
  const progress: number[] = []
  const events: SegmenterEvents = {
    onSpeechStart: (id) => log.push(`start:${id}`),
    onProgress: (_id, ms) => progress.push(ms),
    onSpeechEnd: (s) => {
      log.push(`end:${s.id}:${s.reason}`)
      segments.push(s)
    },
    onMisfire: (id) => log.push(`misfire:${id}`)
  }
  return { log, segments, progress, events }
}

/** Pushes `count` frames with the given probability; samples carry the frame index for ordering checks. */
function feed(seg: SegmenterInstance, count: number, prob: number, marker = prob): void {
  for (let i = 0; i < count; i++) seg.push(frame(marker), prob)
}

const opts = { preSpeechPadMs: 96, redemptionMs: 320, minSpeechMs: 160, maxSegmentMs: 3200, tailPadMs: 64 }

describe('Segmenter', () => {
  it('emits a segment with pre-speech pad and trimmed trailing silence', () => {
    const r = recorder()
    const seg = new Segmenter(r.events, opts)
    feed(seg, 10, 0.05, 0.01) // silence, 3 frames (96 ms) kept as pad
    feed(seg, 10, 0.9, 0.5) // 320 ms speech
    feed(seg, 10, 0.05, 0.01) // 320 ms silence → end
    expect(r.log).toEqual(['start:1', 'end:1:silence'])
    const s = r.segments[0]
    expect(s.speechStart).toBe(3 * FRAME)
    expect(s.speechEnd).toBe(13 * FRAME)
    // pad (3) + speech (10) + tail pad 64 ms (2 frames)
    expect(s.audio.length).toBe(15 * FRAME)
    expect(s.audio[0]).toBeCloseTo(0.01)
    expect(s.audio[3 * FRAME]).toBeCloseTo(0.5)
    expect(seg.active).toBe(false)
  })

  it('reports short bursts as misfires', () => {
    const r = recorder()
    const seg = new Segmenter(r.events, opts)
    feed(seg, 3, 0.9) // 96 ms < minSpeechMs
    feed(seg, 12, 0.05)
    expect(r.log).toEqual(['misfire:1'])
    expect(r.segments).toHaveLength(0)
  })

  it('keeps a segment alive through short pauses (redemption)', () => {
    const r = recorder()
    const seg = new Segmenter(r.events, opts)
    feed(seg, 8, 0.9)
    feed(seg, 6, 0.05) // 192 ms pause < 320 ms
    feed(seg, 8, 0.9)
    feed(seg, 10, 0.05)
    expect(r.log).toEqual(['start:1', 'end:1:silence'])
    expect(r.segments[0].speechEnd).toBe(22 * FRAME)
  })

  it('ignores probabilities between the thresholds for redemption', () => {
    const r = recorder()
    const seg = new Segmenter(r.events, opts)
    feed(seg, 8, 0.9)
    feed(seg, 20, 0.4) // neither speech nor silence
    expect(r.log).toEqual(['start:1'])
    feed(seg, 10, 0.1)
    expect(r.log).toEqual(['start:1', 'end:1:silence'])
  })

  it('cuts segments at the maximum length and starts a new one for continuing speech', () => {
    const r = recorder()
    const seg = new Segmenter(r.events, opts)
    feed(seg, 100, 0.9) // 3.2 s of speech
    expect(r.log).toEqual(['start:1', 'end:1:max-length'])
    expect(r.segments[0].audio.length).toBe(100 * FRAME)
    feed(seg, 10, 0.9)
    expect(r.log).toEqual(['start:1', 'end:1:max-length', 'start:2'])
  })

  it('exposes the segment in progress and reports progress', () => {
    const r = recorder()
    const seg = new Segmenter(r.events, opts)
    expect(seg.snapshot()).toBeNull()
    feed(seg, 3, 0.05)
    feed(seg, 10, 0.9)
    const snap = seg.snapshot()
    expect(snap?.id).toBe(1)
    expect(snap?.audio.length).toBe(13 * FRAME)
    expect(seg.segmentId).toBe(1)
    expect(r.progress.at(-1)).toBeCloseTo(320, 0)
  })

  it('applies new limits to the running segment', () => {
    const r = recorder()
    const seg = new Segmenter(r.events, opts)
    feed(seg, 8, 0.9)
    seg.setOptions({ redemptionMs: 960 })
    feed(seg, 15, 0.05) // 480 ms: would have ended with 320 ms
    expect(r.log).toEqual(['start:1'])
    feed(seg, 15, 0.05)
    expect(r.log).toEqual(['start:1', 'end:1:silence'])
  })

  it('flushes and resets on demand', () => {
    const r = recorder()
    const seg = new Segmenter(r.events, opts)
    feed(seg, 8, 0.9)
    seg.flush()
    expect(r.log).toEqual(['start:1', 'end:1:flush'])
    feed(seg, 8, 0.9)
    seg.reset()
    feed(seg, 12, 0.05)
    expect(r.log).toEqual(['start:1', 'end:1:flush', 'start:2'])
    expect(seg.active).toBe(false)
  })

  it('tolerates a callback resetting the segmenter mid-frame', () => {
    const r = recorder()
    const seg: SegmenterInstance = new Segmenter({ ...r.events, onSpeechStart: () => seg.reset() }, opts)
    feed(seg, 10, 0.9)
    feed(seg, 10, 0.05)
    expect(r.segments).toHaveLength(0)
  })
})
