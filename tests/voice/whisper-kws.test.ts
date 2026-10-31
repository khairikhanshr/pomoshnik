// Keyword spotting with the bundled Whisper model: phrases synthesized by macOS voices (say + afconvert, 16 kHz
// mono PCM16) run through transformers.js in Node with remote models disabled, using the same model files,
// decoder prompt, audio window and token limit as the renderer's Whisper worker.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type DataType } from '@huggingface/transformers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_WAKE_PHRASES } from '@shared/defaults'
import { hasWords, matchWake, normalizeText } from '@shared/wake'
import {
  importRenderer,
  type AudioModule,
  type EngineModule,
  type WhisperGenerationConfig,
  type WhisperPromptModule
} from './support/renderer'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MODEL = JSON.parse(readFileSync(join(ROOT, 'src/renderer/src/voice/whisper-model.json'), 'utf8')) as {
  id: string
  dtype: Record<string, DataType>
}
const MODELS_DIR = join(ROOT, 'src/renderer/public/models')
const modelPresent = existsSync(join(MODELS_DIR, MODEL.id, 'config.json'))
const canSynthesize = process.platform === 'darwin' && existsSync('/usr/bin/say') && existsSync('/usr/bin/afconvert')
if (!modelPresent) console.warn(`[kws] skipped: ${MODEL.id} is not in public/models (run node scripts/fetch-models.mjs)`)

const { decodeWav, SPEECH_SAMPLE_RATE } = await importRenderer<AudioModule>('voice/audio')
const { WAKE_WINDOW_MS, WAKE_MAX_TOKENS } = await importRenderer<EngineModule>('voice/engine')
const { isWhisperGenerationConfig, promptOptions } = await importRenderer<WhisperPromptModule>('voice/whisper-prompt')

/** Same as the VAD pre-speech pad: segments start with a little audio before the onset. */
const PRE_PAD_S = 0.4
const LANGUAGES = ['ru', 'en']

interface Case {
  name: string
  voice: string
  text: string
  wake: boolean
  /** Expected word in the remainder ('' = bare wake word). */
  remainder?: RegExp | ''
}

const CASES: Case[] = [
  { name: 'ru_open_calc', voice: 'Milena', text: 'Джарвис, открой калькулятор', wake: true, remainder: /открой/ },
  { name: 'ru_bare', voice: 'Milena', text: 'Джарвис', wake: true, remainder: '' },
  { name: 'ru_time', voice: 'Milena', text: 'Джарвис, сколько сейчас времени', wake: true, remainder: /сколько/ },
  { name: 'en_time', voice: 'Daniel', text: 'Jarvis, what time is it', wake: true, remainder: /time/ },
  { name: 'neg_privet', voice: 'Milena', text: 'Привет, как дела', wake: false },
  { name: 'neg_darwin', voice: 'Milena', text: 'Дарвин был великим учёным', wake: false }
]

function synthesize(dir: string, c: Case): Float32Array {
  const aiff = join(dir, `${c.name}.aiff`)
  const wav = join(dir, `${c.name}.wav`)
  execFileSync('say', ['-v', c.voice, '-o', aiff, c.text])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SPEECH_SAMPLE_RATE}`, '-c', '1', aiff, wav])
  const { samples, sampleRate } = decodeWav(readFileSync(wav))
  expect(sampleRate).toBe(SPEECH_SAMPLE_RATE)
  // Like an engine segment: pre-pad + speech, cut to the wake window the engine transcribes.
  const pad = Math.round(PRE_PAD_S * SPEECH_SAMPLE_RATE)
  const windowEnd = pad + (WAKE_WINDOW_MS / 1000) * SPEECH_SAMPLE_RATE
  const out = new Float32Array(Math.min(pad + samples.length, windowEnd))
  out.set(samples.subarray(0, out.length - pad), pad)
  return out
}

describe.skipIf(!canSynthesize || !modelPresent)(`local wake word detection with ${MODEL.id}`, () => {
  let dir = ''
  let asr: AutomaticSpeechRecognitionPipeline | null = null
  let gc: WhisperGenerationConfig | null = null
  const audio = new Map<string, Float32Array>()
  const timings: number[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-kws-'))
    for (const c of CASES) audio.set(c.name, synthesize(dir, c))
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = `${MODELS_DIR}/`
    env.useFSCache = false
    env.useBrowserCache = false
    const started = performance.now()
    asr = await pipeline('automatic-speech-recognition', MODEL.id, { dtype: MODEL.dtype, device: 'cpu' })
    const config = (asr.model as unknown as { generation_config?: unknown }).generation_config
    if (!isWhisperGenerationConfig(config)) throw new Error('not a multilingual Whisper model')
    gc = config
    console.log(`[kws] loaded ${MODEL.id} ${JSON.stringify(MODEL.dtype)} in ${Math.round(performance.now() - started)} ms`)
  }, 120_000)

  afterAll(async () => {
    if (timings.length) {
      const avg = timings.reduce((a, b) => a + b, 0) / timings.length
      console.log(`[kws] average inference ${Math.round(avg)} ms over ${timings.length} phrases (onnxruntime-node CPU)`)
    }
    await asr?.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  for (const c of CASES) {
    it(`${c.wake ? 'detects' : 'rejects'} "${c.text}" (${c.voice})`, async () => {
      if (!asr || !gc) throw new Error('model not loaded')
      const { options, language } = promptOptions(gc, LANGUAGES, WAKE_MAX_TOKENS)
      const started = performance.now()
      const out = await asr(audio.get(c.name)!, options as Parameters<AutomaticSpeechRecognitionPipeline>[1])
      const ms = Math.round(performance.now() - started)
      timings.push(ms)
      const text = (Array.isArray(out) ? out[0]?.text : out.text)?.trim() ?? ''
      const match = matchWake(text, DEFAULT_WAKE_PHRASES, 'medium')
      console.log(`[kws] ${c.name}: "${text}" [${language()}] ${ms} ms -> ${match.matched ? `wake, rest "${match.remainder}"` : 'no wake'}`)
      expect(match.matched, `transcript "${text}"`).toBe(c.wake)
      if (c.remainder === '') expect(hasWords(match.remainder), `remainder "${match.remainder}"`).toBe(false)
      else if (c.remainder) expect(normalizeText(match.remainder)).toMatch(c.remainder)
    }, 60_000)
  }
})
