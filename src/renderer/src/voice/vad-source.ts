// Audio capture + Silero VAD (@ricky0123/vad-web). MicVAD runs the AudioWorklet (resampling to 16 kHz frames)
// and the Silero model; segmentation itself is done by our Segmenter from the per-frame probabilities.
// Deep import: the package index also loads NonRealTimeVAD, which bundles a second, full onnxruntime-web build.
import { MicVAD } from '@ricky0123/vad-web/dist/real-time-vad'
import { levelFromRms, rms, SPEECH_SAMPLE_RATE } from './audio'
import { errorText, type Logger } from './log'
import { Segmenter, type SegmenterEvents } from './segmenter'
import { assetUrl } from './whisper-client'

export interface VadSourceEvents extends SegmenterEvents {
  /** Microphone level 0..1 for every 32 ms frame. */
  onLevel(level: number): void
}

export class VadSource {
  readonly segmenter: Segmenter
  private vad: MicVAD | null = null
  private creating: Promise<MicVAD> | null = null
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private running = false
  private switching: Promise<void> = Promise.resolve()

  constructor(
    private readonly log: Logger,
    private readonly events: VadSourceEvents
  ) {
    this.segmenter = new Segmenter(events, { sampleRate: SPEECH_SAMPLE_RATE })
  }

  get listening(): boolean {
    return this.running
  }

  /** Starts (or switches) capture to the given stream. */
  attach(stream: MediaStream): Promise<void> {
    this.switching = this.switching.then(() => this.doAttach(stream)).catch((err: unknown) => {
      this.running = false
      throw err
    })
    return this.switching
  }

  /** Stops feeding audio (keeps the model loaded). The segment in progress is dropped. */
  detach(): Promise<void> {
    this.switching = this.switching
      .then(async () => {
        this.stream = null
        if (this.vad && this.running) await this.vad.pause()
        this.running = false
        this.segmenter.reset()
      })
      .catch((err: unknown) => this.log.warn(`VAD pause failed: ${errorText(err)}`))
    return this.switching
  }

  async destroy(): Promise<void> {
    await this.detach()
    const vad = this.vad
    this.vad = null
    try {
      await vad?.destroy()
    } catch (err) {
      this.log.warn(`VAD destroy failed: ${errorText(err)}`)
    }
    await this.context?.close().catch(() => undefined)
    this.context = null
  }

  private async doAttach(stream: MediaStream): Promise<void> {
    this.stream = stream
    const vad = await this.ensureVad()
    if (this.stream !== stream) return
    if (this.running) await vad.pause()
    this.segmenter.reset()
    await this.ensureContext().resume()
    await vad.start()
    this.running = true
  }

  private ensureContext(): AudioContext {
    if (this.context && this.context.state !== 'closed') return this.context
    try {
      // Let Chromium resample the microphone (better than the worklet's averaging resampler).
      this.context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE, latencyHint: 'interactive' })
    } catch (err) {
      this.log.warn(`16 kHz AudioContext unavailable (${errorText(err)}), using the device rate`)
      this.context = new AudioContext({ latencyHint: 'interactive' })
    }
    return this.context
  }

  private ensureVad(): Promise<MicVAD> {
    if (this.vad) return Promise.resolve(this.vad)
    if (this.creating) return this.creating
    this.creating = MicVAD.new({
      model: 'v5',
      baseAssetPath: assetUrl('vad/'),
      onnxWASMBasePath: assetUrl('ort/'),
      audioContext: this.ensureContext(),
      processorType: 'AudioWorklet',
      startOnLoad: false,
      getStream: async () => this.currentStream(),
      pauseStream: async () => undefined,
      resumeStream: async () => this.currentStream(),
      ortConfig: (ort) => {
        ort.env.logLevel = 'error'
        // Silero is tiny; threads would only add worker overhead.
        ort.env.wasm.numThreads = 1
      },
      // vad-web's own segmentation is neutralised (we only want probabilities): nothing ever counts as speech.
      positiveSpeechThreshold: 1,
      negativeSpeechThreshold: 1,
      redemptionMs: 0,
      preSpeechPadMs: 0,
      minSpeechMs: 0,
      submitUserSpeechOnPause: false,
      onFrameProcessed: (probs, frame) => this.onFrame(probs.isSpeech, frame)
    })
      .then((vad) => {
        this.vad = vad
        return vad
      })
      .finally(() => {
        this.creating = null
      })
    return this.creating
  }

  private currentStream(): MediaStream {
    if (!this.stream) throw new Error('No microphone stream')
    return this.stream
  }

  private onFrame(probability: number, frame: Float32Array): void {
    if (!this.running) return
    try {
      this.events.onLevel(levelFromRms(rms(frame)))
      this.segmenter.push(frame, Number.isFinite(probability) ? probability : 0)
    } catch (err) {
      this.log.error(`VAD frame handling failed: ${errorText(err)}`)
    }
  }
}
