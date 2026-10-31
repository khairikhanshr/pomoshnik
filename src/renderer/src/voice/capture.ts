// CaptureControl implementation: the microphone stream feeds the VAD; stream changes (device switch,
// unplug/replug) re-attach the VAD transparently.
import type { CaptureControl } from './engine-types'
import { errorText, type Logger } from './log'
import { Microphone } from './mic'
import type { Segment, SegmenterEvents, SegmenterOptions } from './segmenter'
import { VadSource } from './vad-source'

export interface CaptureEvents extends SegmenterEvents {
  onLevel(level: number): void
  onMicStream(): void
  onMicLost(): void
  onMicError(message: string | null): void
}

export class Capture implements CaptureControl {
  private readonly mic: Microphone
  private readonly vad: VadSource
  private wanted = false
  private attaching: Promise<void> = Promise.resolve()

  constructor(
    private readonly log: Logger,
    events: CaptureEvents
  ) {
    this.vad = new VadSource(log, events)
    this.mic = new Microphone(log, {
      onStream: (stream) => {
        this.attaching = this.vad
          .attach(stream)
          .then(() => events.onMicStream())
          .catch((err: unknown) => {
            const message = `Не удалось запустить детектор речи: ${errorText(err)}`
            log.error(message)
            events.onMicError(message)
          })
      },
      onLost: () => {
        void this.vad.detach()
        events.onMicLost()
      },
      onError: (message) => events.onMicError(message)
    })
  }

  get running(): boolean {
    return this.wanted
  }

  get segmentId(): number {
    return this.vad.segmenter.segmentId
  }

  /** Resolves once audio flows into the VAD (or the attempt failed; failures arrive as onMicError). */
  async start(deviceId: string): Promise<void> {
    this.wanted = true
    await this.mic.start(deviceId)
    await this.attaching
  }

  async stop(): Promise<void> {
    if (!this.wanted) return
    this.wanted = false
    this.mic.stop()
    await this.vad.detach()
    this.log.info('Microphone off')
  }

  configure(options: Partial<SegmenterOptions>): void {
    this.vad.segmenter.setOptions(options)
  }

  snapshot(): Segment | null {
    return this.vad.segmenter.snapshot()
  }

  async destroy(): Promise<void> {
    await this.stop()
    await this.vad.destroy()
  }
}
