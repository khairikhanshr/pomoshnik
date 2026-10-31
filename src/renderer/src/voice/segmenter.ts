// Turns per-frame speech probabilities (Silero VAD) into speech segments. Unlike vad-web's own frame processor
// it exposes the segment in progress, so the engine can check the wake word while the user is still talking,
// and its limits can change while a segment is running (wake word → command).
import { concatFloat32 } from './audio'

export interface SegmenterOptions {
  sampleRate: number
  positiveThreshold: number
  negativeThreshold: number
  /** Audio kept from before the speech onset. */
  preSpeechPadMs: number
  /** Silence after speech that ends a segment. */
  redemptionMs: number
  /** Segments with less speech than this are misfires. */
  minSpeechMs: number
  /** Segments are cut at this length. */
  maxSegmentMs: number
  /** Silence kept after the last speech frame in emitted audio. */
  tailPadMs: number
}

export type SegmentEndReason = 'silence' | 'max-length' | 'flush'

export interface Segment {
  id: number
  audio: Float32Array
  /** Sample index in `audio` where speech starts (after the pre-speech pad). */
  speechStart: number
  /** Sample index in `audio` right after the last speech frame. */
  speechEnd: number
  reason: SegmentEndReason
}

export interface SegmenterEvents {
  /** Enough speech to be a real segment (fires once per segment). */
  onSpeechStart(id: number): void
  /** Called for every frame of a real segment with the amount of audio since the speech onset. */
  onProgress(id: number, speechMs: number): void
  onSpeechEnd(segment: Segment): void
  /** Speech onset that ended before `minSpeechMs` of speech. */
  onMisfire(id: number): void
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  sampleRate: 16_000,
  positiveThreshold: 0.5,
  negativeThreshold: 0.35,
  preSpeechPadMs: 400,
  redemptionMs: 900,
  minSpeechMs: 250,
  maxSegmentMs: 15_000,
  tailPadMs: 250
}

export class Segmenter {
  private options: SegmenterOptions
  private pre: Float32Array[] = []
  private frames: Float32Array[] = []
  private samples = 0
  private speaking = false
  private realStart = false
  private speechSamples = 0
  private silenceSamples = 0
  private speechStart = 0
  private speechEnd = 0
  private nextId = 1
  private currentId = 0

  constructor(
    private readonly events: SegmenterEvents,
    options: Partial<SegmenterOptions> = {}
  ) {
    this.options = { ...DEFAULT_SEGMENTER_OPTIONS, ...options }
  }

  get active(): boolean {
    return this.speaking
  }

  /** Id of the segment in progress (0 when silent). */
  get segmentId(): number {
    return this.speaking ? this.currentId : 0
  }

  setOptions(update: Partial<SegmenterOptions>): void {
    this.options = { ...this.options, ...update }
  }

  getOptions(): Readonly<SegmenterOptions> {
    return this.options
  }

  push(frame: Float32Array, probability: number): void {
    const o = this.options
    if (!this.speaking) {
      if (probability >= o.positiveThreshold) {
        this.begin(frame)
      } else {
        this.pre.push(frame)
        let padSamples = 0
        for (const f of this.pre) padSamples += f.length
        while (this.pre.length && padSamples - this.pre[0].length >= this.ms(o.preSpeechPadMs)) {
          padSamples -= this.pre[0].length
          this.pre.shift()
        }
      }
      return
    }

    this.frames.push(frame)
    this.samples += frame.length
    if (probability >= o.positiveThreshold) {
      this.speechSamples += frame.length
      this.silenceSamples = 0
      this.speechEnd = this.samples
    } else if (probability < o.negativeThreshold) {
      this.silenceSamples += frame.length
    }

    if (!this.realStart && this.speechSamples >= this.ms(o.minSpeechMs)) {
      this.realStart = true
      this.events.onSpeechStart(this.currentId)
    }
    if (this.realStart) this.events.onProgress(this.currentId, this.toMs(this.samples - this.speechStart))

    if (!this.speaking) return // a callback may have reset us
    if (this.silenceSamples >= this.ms(o.redemptionMs)) this.end('silence')
    else if (this.samples >= this.ms(o.maxSegmentMs)) this.end('max-length')
  }

  /** Audio of the segment in progress (null when silent). */
  snapshot(): Segment | null {
    if (!this.speaking) return null
    return {
      id: this.currentId,
      audio: concatFloat32(this.frames),
      speechStart: this.speechStart,
      speechEnd: this.speechEnd,
      reason: 'flush'
    }
  }

  /** Ends the segment in progress now (emits it or a misfire). */
  flush(): void {
    if (this.speaking) this.end('flush')
  }

  /** Drops the segment in progress without emitting anything. */
  reset(): void {
    this.speaking = false
    this.realStart = false
    this.frames = []
    this.pre = []
    this.samples = 0
    this.speechSamples = 0
    this.silenceSamples = 0
  }

  private begin(frame: Float32Array): void {
    this.speaking = true
    this.realStart = false
    this.currentId = this.nextId++
    this.frames = [...this.pre, frame]
    this.pre = []
    this.samples = 0
    for (const f of this.frames) this.samples += f.length
    this.speechStart = this.samples - frame.length
    this.speechEnd = this.samples
    this.speechSamples = frame.length
    this.silenceSamples = 0
  }

  private end(reason: SegmentEndReason): void {
    const id = this.currentId
    const real = this.realStart || this.speechSamples >= this.ms(this.options.minSpeechMs)
    const audio = concatFloat32(this.frames)
    const keep = Math.min(audio.length, this.speechEnd + this.ms(this.options.tailPadMs))
    const segment: Segment = {
      id,
      audio: keep < audio.length ? audio.slice(0, keep) : audio,
      speechStart: this.speechStart,
      speechEnd: this.speechEnd,
      reason
    }
    // Trailing silence becomes the pre-speech pad of the next segment.
    const tail: Float32Array[] = []
    for (let i = this.frames.length - 1, n = 0; i >= 0 && n < this.ms(this.options.preSpeechPadMs); i--) {
      tail.unshift(this.frames[i])
      n += this.frames[i].length
    }
    this.reset()
    this.pre = reason === 'silence' ? tail : []
    if (real) this.events.onSpeechEnd(segment)
    else this.events.onMisfire(id)
  }

  private ms(value: number): number {
    return Math.round((value * this.options.sampleRate) / 1000)
  }

  private toMs(samples: number): number {
    return (samples * 1000) / this.options.sampleRate
  }
}
