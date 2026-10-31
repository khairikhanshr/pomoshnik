// Messages between the voice engine and the Whisper Web Worker.

export interface WhisperLoadRequest {
  type: 'load'
  /** Absolute URL of the directory that contains `<org>/<repo>/…` model folders. */
  modelBaseUrl: string
  /** Absolute URL of the onnxruntime-web files that match the transformers.js build. */
  ortBaseUrl: string
  modelId: string
  dtype: Record<string, string>
  threads: number
}

export interface WhisperTranscribeRequest {
  type: 'transcribe'
  id: number
  /** 16 kHz mono samples (transferred). */
  audio: Float32Array
  /** Candidate languages (ISO-639-1); the model picks the most likely one. */
  languages: string[]
  maxNewTokens: number
}

export type WhisperRequest = WhisperLoadRequest | WhisperTranscribeRequest

export type WhisperResponse =
  | { type: 'ready'; loadMs: number; threads: number; isolated: boolean }
  | { type: 'load-error'; message: string }
  | { type: 'result'; id: number; text: string; language: string | null; ms: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
