// Dependencies of the voice engine. The real implementations wrap the microphone/VAD, the Whisper worker,
// the TTS queue and window.jarvis; tests use fakes.
import type { SendChatResult, SpeechDoneReport } from '@shared/ipc'
import type { SpeakChunk, TtsProvider, VoicePhaseReport } from '@shared/types'
import type { Logger } from './log'
import type { Segment, SegmenterOptions } from './segmenter'

export type ChimeKind = 'listen' | 'cancel'

export interface TtsConfig {
  provider: TtsProvider
  systemVoiceName: string
  speed: number
  /** Identifies the cloud voice + its settings (cache key for short phrases). */
  voiceKey: string
}

export interface CaptureControl {
  /** Microphone + VAD on (idempotent; switches device when it changed). */
  start(deviceId: string): Promise<void>
  /** Microphone off; the segment in progress is dropped. */
  stop(): Promise<void>
  readonly running: boolean
  /** Updates segmentation limits (also for the segment in progress). */
  configure(options: Partial<SegmenterOptions>): void
  /** Segment in progress, or null. */
  snapshot(): Segment | null
  /** Id of the segment in progress (0 when silent). */
  readonly segmentId: number
}

export interface LocalRecognizer {
  readonly ready: boolean
  load(): Promise<void>
  transcribe(
    audio: Float32Array,
    languages: string[],
    maxNewTokens: number
  ): Promise<{ text: string; language: string | null; ms?: number }>
  dispose(): void
}

export interface SpeechOutput {
  readonly playing: boolean
  readonly activeTurn: string | null
  configure(config: TtsConfig): void
  enqueue(chunk: SpeakChunk): void
  stop(): void
  speakPhrase(text: string): Promise<void>
  prefetchPhrase(text: string): void
  recentlySpoken(windowMs: number): string[]
}

export interface MainBridge {
  submit(text: string): Promise<SendChatResult>
  cancelTurn(): Promise<void>
  transcribe(wav: ArrayBuffer): Promise<string>
  reportPhase(report: VoicePhaseReport): void
  reportLevel(level: number): void
  reportSpeechDone(report: SpeechDoneReport): void
}

export interface EngineDeps {
  bridge: MainBridge
  capture: CaptureControl
  local: LocalRecognizer
  tts: SpeechOutput
  chime(kind: ChimeKind): Promise<void>
  log: Logger
}
