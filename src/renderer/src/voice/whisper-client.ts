// Main-thread side of the Whisper worker: loading, one transcription at a time, crash recovery.
import whisperModel from './whisper-model.json'
import type { WhisperResponse, WhisperTranscribeRequest } from './whisper-protocol'
import type { Logger } from './log'

export interface LocalTranscript {
  text: string
  language: string | null
  ms: number
}

interface Pending {
  resolve: (r: LocalTranscript) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const LOAD_TIMEOUT_MS = 180_000
const TRANSCRIBE_TIMEOUT_MS = 30_000

export function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href
}

export function whisperThreads(): number {
  if (!globalThis.crossOriginIsolated) return 1
  return Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
}

export class WhisperClient {
  private worker: Worker | null = null
  private loading: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private loaded = false

  constructor(private readonly log: Logger) {}

  get ready(): boolean {
    return this.loaded
  }

  /** Starts the worker and loads the model (idempotent; a failed load can be retried). */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (this.loading) return this.loading
    this.loading = this.start().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  /** Transcribes 16 kHz mono audio. Rejects when the model is not loaded or the worker fails. */
  transcribe(audio: Float32Array, languages: string[], maxNewTokens: number): Promise<LocalTranscript> {
    const worker = this.worker
    if (!worker || !this.loaded) return Promise.reject(new Error('Локальная модель распознавания не загружена'))
    const id = this.nextId++
    return new Promise<LocalTranscript>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Локальное распознавание не ответило вовремя'))
        // A stuck worker would block every later request.
        this.restart('transcription timeout')
      }, TRANSCRIBE_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      const copy = audio.slice()
      const req: WhisperTranscribeRequest = { type: 'transcribe', id, audio: copy, languages, maxNewTokens }
      worker.postMessage(req, [copy.buffer])
    })
  }

  dispose(): void {
    this.loaded = false
    this.worker?.terminate()
    this.worker = null
    this.failPending(new Error('Локальная модель выгружена'))
  }

  private start(): Promise<void> {
    this.worker?.terminate()
    const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module', name: 'whisper' })
    this.worker = worker
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Загрузка локальной модели заняла слишком много времени')), LOAD_TIMEOUT_MS)
      const fail = (err: Error): void => {
        clearTimeout(timer)
        if (this.worker === worker) {
          worker.terminate()
          this.worker = null
          this.loaded = false
        }
        reject(err)
      }
      worker.onmessage = (ev: MessageEvent<WhisperResponse>) => {
        const msg = ev.data
        switch (msg.type) {
          case 'ready':
            clearTimeout(timer)
            this.loaded = true
            this.log.info(
              `Whisper ${whisperModel.id} ready in ${msg.loadMs} ms (threads ${msg.threads}, isolated ${msg.isolated})`
            )
            if (!msg.isolated) this.log.warn('Voice window is not cross-origin isolated: Whisper runs single-threaded')
            resolve()
            break
          case 'load-error':
            fail(new Error(msg.message))
            break
          case 'result':
          case 'error':
            this.settle(msg)
            break
          case 'log':
            this.log[msg.level](msg.message)
            break
        }
      }
      worker.onerror = (ev: ErrorEvent) => {
        ev.preventDefault()
        const err = new Error(`Whisper worker crashed: ${ev.message || 'unknown error'}`)
        this.log.error(err.message)
        if (!this.loaded) fail(err)
        else this.restart(err.message)
      }
      worker.postMessage({
        type: 'load',
        modelBaseUrl: assetUrl('models/'),
        ortBaseUrl: assetUrl('ort-tf/'),
        modelId: whisperModel.id,
        dtype: whisperModel.dtype,
        threads: whisperThreads()
      })
    })
  }

  private settle(msg: Extract<WhisperResponse, { type: 'result' | 'error' }>): void {
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.type === 'result') p.resolve({ text: msg.text, language: msg.language, ms: msg.ms })
    else p.reject(new Error(msg.message))
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private restart(reason: string): void {
    this.log.warn(`Restarting Whisper worker (${reason})`)
    this.dispose()
    this.load().catch((err: unknown) => this.log.error(`Whisper reload failed: ${String(err)}`))
  }
}
