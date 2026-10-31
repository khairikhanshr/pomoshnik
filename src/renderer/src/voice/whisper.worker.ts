/// <reference lib="webworker" />
// Local Whisper (transformers.js + onnxruntime-web WASM) for wake-word detection. Model files are served
// from the app origin; remote model downloads are disabled.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type DataType } from '@huggingface/transformers'
import { isWhisperGenerationConfig, promptOptions, type WhisperGenerationConfig } from './whisper-prompt'
import type { WhisperLoadRequest, WhisperRequest, WhisperResponse, WhisperTranscribeRequest } from './whisper-protocol'

declare const self: DedicatedWorkerGlobalScope

let asr: AutomaticSpeechRecognitionPipeline | null = null
let generation: WhisperGenerationConfig | null = null
let queue: Promise<void> = Promise.resolve()

function post(msg: WhisperResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function load(req: WhisperLoadRequest): Promise<void> {
  const started = performance.now()
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = req.modelBaseUrl
  env.useBrowserCache = false
  env.useWasmCache = false
  const isolated = self.crossOriginIsolated === true
  const threads = isolated ? Math.max(1, req.threads) : 1
  const wasm = env.backends.onnx.wasm
  if (!wasm) throw new Error('onnxruntime-web WASM backend is unavailable')
  // Without this, transformers.js points onnxruntime at a CDN.
  wasm.wasmPaths = {
    mjs: `${req.ortBaseUrl}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${req.ortBaseUrl}ort-wasm-simd-threaded.asyncify.wasm`
  }
  wasm.numThreads = threads
  wasm.proxy = false

  const loaded = await pipeline('automatic-speech-recognition', req.modelId, {
    device: 'wasm',
    dtype: req.dtype as Record<string, DataType>
  })
  const gc = (loaded.model as unknown as { generation_config?: unknown }).generation_config
  if (!isWhisperGenerationConfig(gc)) {
    await loaded.dispose()
    throw new Error(`${req.modelId} is not a multilingual Whisper model`)
  }
  asr = loaded
  generation = gc
  // The first inference compiles kernels and allocates arenas; do it now instead of on the first wake word.
  await transcribe(new Float32Array(16_000), ['ru'], 4)
  post({ type: 'ready', loadMs: Math.round(performance.now() - started), threads, isolated })
}

async function transcribe(
  audio: Float32Array,
  languages: string[],
  maxNewTokens: number
): Promise<{ text: string; language: string | null }> {
  if (!asr || !generation) throw new Error('Whisper model is not loaded')
  const { options, language } = promptOptions(generation, languages, maxNewTokens)
  const out = await asr(audio, options as unknown as Parameters<AutomaticSpeechRecognitionPipeline>[1])
  const text = (Array.isArray(out) ? out[0]?.text : out.text) ?? ''
  return { text: text.trim(), language: language() }
}

async function handleTranscribe(req: WhisperTranscribeRequest): Promise<void> {
  const started = performance.now()
  try {
    const { text, language } = await transcribe(req.audio, req.languages, req.maxNewTokens)
    post({ type: 'result', id: req.id, text, language, ms: Math.round(performance.now() - started) })
  } catch (err) {
    post({ type: 'error', id: req.id, message: errorMessage(err) })
  }
}

self.onmessage = (ev: MessageEvent<WhisperRequest>) => {
  const msg = ev.data
  // Requests are processed strictly one at a time; the engine drops stale ones before sending.
  queue = queue.then(async () => {
    if (msg.type === 'load') {
      try {
        if (!asr) await load(msg)
        else post({ type: 'ready', loadMs: 0, threads: env.backends.onnx.wasm?.numThreads ?? 1, isolated: self.crossOriginIsolated })
      } catch (err) {
        asr = null
        generation = null
        post({ type: 'load-error', message: errorMessage(err) })
      }
    } else if (msg.type === 'transcribe') {
      await handleTranscribe(msg)
    }
  })
}

self.addEventListener('unhandledrejection', (ev) => {
  post({ type: 'log', level: 'error', message: `Whisper worker: ${errorMessage(ev.reason)}` })
})
