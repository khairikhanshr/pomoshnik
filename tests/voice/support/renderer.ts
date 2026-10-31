// tsconfig.node.json is a composite project that cannot include src/renderer, so tests load the (DOM-free)
// voice modules at runtime; the shapes below mirror the parts of their APIs the tests use.
import { fileURLToPath } from 'node:url'
import type { SendChatResult, SpeechDoneReport } from '@shared/ipc'
import type { AssistantState, PublicSettings, SpeakChunk, TtsProvider, VoicePhaseReport } from '@shared/types'

export async function importRenderer<T>(path: string): Promise<T> {
  const file = fileURLToPath(new URL(`../../../src/renderer/src/${path}.ts`, import.meta.url))
  return (await import(/* @vite-ignore */ file)) as T
}

export interface AudioModule {
  SPEECH_SAMPLE_RATE: number
  concatFloat32(chunks: readonly Float32Array[]): Float32Array
  resample(input: Float32Array, fromRate: number, toRate: number): Float32Array
  encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer
  encodeSpeechWav(samples: Float32Array, sampleRate?: number): ArrayBuffer
  decodeWav(data: ArrayBuffer | Uint8Array): { samples: Float32Array; sampleRate: number }
  rms(samples: Float32Array, from?: number, to?: number): number
  levelFromRms(value: number): number
}

export interface SegmenterOptions {
  sampleRate: number
  positiveThreshold: number
  negativeThreshold: number
  preSpeechPadMs: number
  redemptionMs: number
  minSpeechMs: number
  maxSegmentMs: number
  tailPadMs: number
}

export interface Segment {
  id: number
  audio: Float32Array
  speechStart: number
  speechEnd: number
  reason: 'silence' | 'max-length' | 'flush'
}

export interface SegmenterEvents {
  onSpeechStart(id: number): void
  onProgress(id: number, speechMs: number): void
  onSpeechEnd(segment: Segment): void
  onMisfire(id: number): void
}

export interface SegmenterInstance {
  readonly active: boolean
  readonly segmentId: number
  push(frame: Float32Array, probability: number): void
  snapshot(): Segment | null
  flush(): void
  reset(): void
  setOptions(update: Partial<SegmenterOptions>): void
}

export interface SegmenterModule {
  Segmenter: new (events: SegmenterEvents, options?: Partial<SegmenterOptions>) => SegmenterInstance
}

export type ChimeKind = 'listen' | 'cancel'

export interface CaptureControl {
  start(deviceId: string): Promise<void>
  stop(): Promise<void>
  readonly running: boolean
  configure(options: Partial<SegmenterOptions>): void
  snapshot(): Segment | null
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

export interface TtsConfig {
  provider: TtsProvider
  systemVoiceName: string
  speed: number
  voiceKey: string
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

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface EngineDeps {
  bridge: MainBridge
  capture: CaptureControl
  local: LocalRecognizer
  tts: SpeechOutput
  chime(kind: ChimeKind): Promise<void>
  log: Logger
}

export interface VoiceEngineInstance {
  applySettings(s: PublicSettings): void
  setWakeEnabled(enabled: boolean): void
  listen(): void
  speak(chunk: SpeakChunk): void
  stopSpeaking(): void
  onAssistantState(state: AssistantState): void
  onMicStream(): void
  onMicLost(): void
  onMicError(message: string | null): void
  onMicLevel(level: number): void
  onSpeechStart(id: number): void
  onProgress(id: number, speechMs: number): void
  onMisfire(id: number): void
  onSpeechEnd(segment: Segment): Promise<void>
  onTurnStart(turnId: string): void
  onTurnDone(turnId: string, interrupted: boolean): void
  onOutputLevel(level: number): void
  dispose(): void
}

export interface EngineModule {
  WAKE_WINDOW_MS: number
  WAKE_MAX_TOKENS: number
  VoiceEngine: new (deps: EngineDeps) => VoiceEngineInstance
  ttsConfigFrom(s: PublicSettings): TtsConfig
}

export interface WhisperGenerationConfig {
  decoder_start_token_id: number
  no_timestamps_token_id: number
  lang_to_id: Record<string, number>
  task_to_id: Record<string, number>
}

export interface WhisperPromptModule {
  isWhisperGenerationConfig(gc: unknown): gc is WhisperGenerationConfig
  promptOptions(
    gc: WhisperGenerationConfig,
    languages: string[],
    maxNewTokens: number
  ): { options: Record<string, unknown>; language(): string | null }
}

export interface VoiceLike {
  name: string
  lang: string
  localService: boolean
}

export interface SystemVoiceModule {
  detectTextLanguage(text: string): 'ru' | 'en'
  pickVoice<V extends VoiceLike>(voices: readonly V[], text: string, preferredName: string): V | null
}
