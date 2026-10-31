// SpeechService: OpenAI transcription and TTS, ElevenLabs TTS and voice listing.
import { DEFAULT_ELEVENLABS_BASE_URL } from '@shared/defaults'
import { clauseCut, sentenceBoundaries } from '@shared/speech-text'
import type { ElevenLabsVoice, Settings } from '@shared/types'
import type { Logger } from '../log'
import type { SecretStore, SettingsStore, SpeechService } from '../services'
import { AiError, ELEVEN_MESSAGES, elevenLabsHttpError } from './errors'
import { Deadline, fetchWithRetry, type HttpTuning, type OpenAiClient } from './http'
import type { JsonObject } from './provider'

export const MAX_TTS_CHARS = 4000
const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe'
const STT_FALLBACK_MODELS = ['gpt-4o-transcribe', 'whisper-1']
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts'
const TTS_FALLBACK_MODEL = 'tts-1'
const DEFAULT_VOICE = 'onyx'
const TTS1_VOICES = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'])
/** Shorter uploads cannot hold speech (a WAV header alone is 44 bytes). */
const MIN_AUDIO_BYTES = 256
const AUDIO_TIMEOUT_MS = 120_000
const VOICES_TIMEOUT_MS = 30_000

const AUDIO_EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpga': 'mpga',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac'
}

/** Whisper-family hallucinations on silence / noise (subtitle credits and the like). */
const HALLUCINATIONS = [
  /dimatorzok/i,
  /amara\.org/i,
  /^(?:субтитры|редактор субтитров|корректор)\b/i,
  /^продолжение следует[.!…]*$/i,
  /^(?:thank you|thanks) for watching[.!]*$/i
]

export function audioUpload(mime: string): { name: string; type: string } {
  const type = mime.split(';')[0]?.trim().toLowerCase() || 'audio/wav'
  return { name: `audio.${AUDIO_EXT[type] ?? 'wav'}`, type }
}

export function vocabularyPrompt(settings: Pick<Settings, 'wakePhrases'>): string {
  const words = [
    'Джарвис',
    'Jarvis',
    ...(settings.wakePhrases ?? []).map((p) => p.charAt(0).toUpperCase() + p.slice(1)),
    'Telegram',
    'WhatsApp',
    'YouTube',
    'Google Chrome',
    'Safari',
    'Spotify',
    'Finder',
    'Discord',
    'Zoom',
    'Steam',
    'Visual Studio Code',
    'Microsoft Word',
    'Excel',
    'PowerPoint',
    'Notion',
    'Slack'
  ]
  const seen = new Set<string>()
  const unique = words.filter((w) => {
    const key = w.toLowerCase()
    if (!w.trim() || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return `${unique.join(', ')}.`
}

/** Cuts text to the TTS input limit at a sentence (else clause/word) boundary. */
export function capSpeechInput(text: string, max = MAX_TTS_CHARS): string {
  const t = text.trim()
  if (t.length <= max) return t
  const ends = sentenceBoundaries(t).filter((b) => b <= max)
  return t.slice(0, ends.length ? ends[ends.length - 1] : clauseCut(t, max)).trim()
}

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** eleven_v3 only accepts stability 0 (creative), 0.5 (natural) or 1 (robust). */
function elevenStability(model: string, value: number): number {
  const v = clamp(value, 0, 1, 0.5)
  return model.startsWith('eleven_v3') ? Math.round(v * 2) / 2 : v
}

function isModelProblem(err: unknown): boolean {
  if (!(err instanceof AiError)) return false
  if (err.code === 'model_not_found') return true
  return (err.code === 'bad_request' || err.code === 'forbidden') && /\bmodel\b/i.test(`${err.detail ?? ''} ${err.param ?? ''}`)
}

function isAudioTooShort(err: unknown): boolean {
  return err instanceof AiError && err.code === 'bad_request' && /too short|audio_too_short|minimum.*duration/i.test(`${err.detail ?? ''} ${err.apiCode ?? ''}`)
}

export interface SpeechDeps {
  http: OpenAiClient
  settings: SettingsStore
  secrets: SecretStore
  tuning: HttpTuning
  log: Logger
}

export class SpeechServiceImpl implements SpeechService {
  constructor(private readonly deps: SpeechDeps) {}

  async transcribe(audio: Buffer, mime: string, opts: { language?: string; prompt?: string } = {}): Promise<string> {
    if (audio.length < MIN_AUDIO_BYTES) return ''
    const settings = this.deps.settings.get()
    const primary = settings.sttModel?.trim() || DEFAULT_STT_MODEL
    const models = [primary, ...STT_FALLBACK_MODELS.filter((m) => m !== primary)]
    const language = (opts.language ?? settings.sttLanguage ?? '').trim().toLowerCase()
    const prompt = opts.prompt?.trim() || vocabularyPrompt(settings)
    const upload = audioUpload(mime)
    const bytes = new Uint8Array(audio)
    let lastError: unknown
    for (const model of models) {
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: upload.type }), upload.name)
      form.append('model', model)
      form.append('response_format', 'json')
      if (/^[a-z]{2,3}$/.test(language)) form.append('language', language)
      if (prompt) form.append('prompt', prompt)
      try {
        const res = await this.deps.http.postForm<{ text?: unknown }>('/audio/transcriptions', form, {
          model,
          timeoutMs: AUDIO_TIMEOUT_MS
        })
        const text = typeof res?.text === 'string' ? res.text.trim() : ''
        return HALLUCINATIONS.some((re) => re.test(text)) ? '' : text
      } catch (err) {
        if (isAudioTooShort(err)) return ''
        if (!isModelProblem(err)) throw err
        this.deps.log.warn(`transcription model ${model} unavailable, trying the next one`)
        lastError = err
      }
    }
    throw lastError
  }

  async synthesize(text: string): Promise<{ data: Buffer; mime: string }> {
    const settings = this.deps.settings.get()
    const input = capSpeechInput(text)
    if (!input) throw new AiError('bad_request', 'Нет текста для озвучивания.')
    if (settings.ttsProvider === 'system') {
      throw new AiError(
        'unsupported',
        'Выбран системный голос: облачный синтез речи не используется, озвучивают голоса операционной системы.'
      )
    }
    if (settings.ttsProvider === 'elevenlabs') return this.elevenLabsSpeech(input, settings)
    return this.openAiSpeech(input, settings)
  }

  async listElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
    const key = this.elevenKey()
    const text = await this.elevenRequest(
      `${this.elevenBase()}/v1/voices`,
      { method: 'GET', headers: { 'xi-api-key': key, Accept: 'application/json' } },
      'voices',
      VOICES_TIMEOUT_MS,
      (res) => res.text()
    )
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new AiError('invalid_response', 'ElevenLabs вернул некорректный ответ.')
    }
    const list = (json as { voices?: unknown } | null)?.voices
    if (!Array.isArray(list)) throw new AiError('invalid_response', 'ElevenLabs вернул некорректный ответ.')
    const voices: ElevenLabsVoice[] = []
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const v = raw as Record<string, unknown>
      const id = typeof v.voice_id === 'string' ? v.voice_id.trim() : ''
      if (!id) continue
      const voice: ElevenLabsVoice = { id, name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : id }
      const description = describeLabels(v.labels)
      if (description) voice.description = description
      if (typeof v.preview_url === 'string' && v.preview_url) voice.previewUrl = v.preview_url
      voices.push(voice)
    }
    return voices.sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }))
  }

  private async openAiSpeech(input: string, settings: Settings): Promise<{ data: Buffer; mime: string }> {
    const model = settings.ttsModel?.trim() || DEFAULT_TTS_MODEL
    try {
      return await this.openAiSpeechWith(model, input, settings)
    } catch (err) {
      if (model === TTS_FALLBACK_MODEL || !isModelProblem(err)) throw err
      this.deps.log.warn(`TTS model ${model} unavailable, falling back to ${TTS_FALLBACK_MODEL}`)
      return this.openAiSpeechWith(TTS_FALLBACK_MODEL, input, settings)
    }
  }

  private async openAiSpeechWith(model: string, input: string, settings: Settings): Promise<{ data: Buffer; mime: string }> {
    const legacy = /^tts-1/i.test(model)
    let voice = settings.ttsVoice?.trim() || DEFAULT_VOICE
    if (legacy && !TTS1_VOICES.has(voice)) voice = DEFAULT_VOICE
    const body: JsonObject = { model, voice, input, response_format: 'mp3', speed: clamp(settings.ttsSpeed, 0.25, 4, 1) }
    const instructions = settings.ttsInstructions?.trim()
    if (instructions && /^gpt-.*tts/i.test(model)) body.instructions = instructions
    let result: { data: Buffer; mime: string }
    try {
      result = await this.deps.http.postBinary('/audio/speech', body, { model, timeoutMs: AUDIO_TIMEOUT_MS })
    } catch (err) {
      // Some models/proxies reject `speed`: retry once without it.
      if (!(err instanceof AiError) || err.code !== 'bad_request' || !/speed/i.test(`${err.detail} ${err.param}`)) throw err
      delete body.speed
      result = await this.deps.http.postBinary('/audio/speech', body, { model, timeoutMs: AUDIO_TIMEOUT_MS })
    }
    if (!result.data.length) throw new AiError('invalid_response', 'Сервер вернул пустой звук.')
    return { data: result.data, mime: result.mime.startsWith('audio/') ? result.mime : 'audio/mpeg' }
  }

  private async elevenLabsSpeech(input: string, settings: Settings): Promise<{ data: Buffer; mime: string }> {
    const key = this.elevenKey()
    const voiceId = settings.elevenVoiceId?.trim() ?? ''
    if (!voiceId) throw new AiError('bad_request', ELEVEN_MESSAGES.noVoice)
    const model = settings.elevenModel?.trim() || 'eleven_multilingual_v2'
    const body = {
      text: input,
      model_id: model,
      voice_settings: {
        stability: elevenStability(model, settings.elevenStability),
        similarity_boost: clamp(settings.elevenSimilarity, 0, 1, 0.75),
        use_speaker_boost: true,
        speed: clamp(settings.ttsSpeed, 0.7, 1.2, 1)
      }
    }
    const url = `${this.elevenBase()}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`
    let mime = 'audio/mpeg'
    const data = await this.elevenRequest(
      url,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify(body)
      },
      'tts',
      AUDIO_TIMEOUT_MS,
      async (res) => {
        const type = res.headers.get('content-type')?.split(';')[0]?.trim()
        if (type?.startsWith('audio/')) mime = type
        return Buffer.from(await res.arrayBuffer())
      }
    )
    if (!data.length) throw new AiError('invalid_response', 'ElevenLabs вернул пустой звук.')
    return { data, mime }
  }

  private elevenBase(): string {
    return (process.env.JARVIS_ELEVENLABS_BASE_URL?.trim() || DEFAULT_ELEVENLABS_BASE_URL).replace(/\/+$/, '')
  }

  private elevenKey(): string {
    const key = this.deps.secrets.getElevenLabsKey()?.trim()
    if (!key) throw new AiError('no_key', ELEVEN_MESSAGES.noKey)
    return key
  }

  private async elevenRequest<T>(
    url: string,
    init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
    op: 'tts' | 'voices',
    timeoutMs: number,
    read: (res: Response) => Promise<T>
  ): Promise<T> {
    const { res, deadline } = await fetchWithRetry(
      {
        url,
        ...init,
        timeoutMs,
        retries: this.deps.tuning.retries,
        toError: (r, text) => elevenLabsHttpError(r.status, text, r.headers, op),
        networkMessage: ELEVEN_MESSAGES.network,
        log: this.deps.log
      },
      this.deps.tuning
    )
    return readWithin(deadline, () => read(res))
  }
}

async function readWithin<T>(deadline: Deadline, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (err) {
    if (deadline.timedOut) throw new AiError('timeout', 'ElevenLabs не отвечает. Попробуйте ещё раз.', { cause: err })
    throw new AiError('network', ELEVEN_MESSAGES.network, { cause: err })
  } finally {
    deadline.dispose()
  }
}

/** "male, british, middle aged, calm, narration" from ElevenLabs voice labels. */
export function describeLabels(labels: unknown): string | undefined {
  if (!labels || typeof labels !== 'object') return undefined
  const l = labels as Record<string, unknown>
  const values = ['gender', 'accent', 'age', 'description', 'use_case']
    .map((k) => l[k])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.replace(/[_-]+/g, ' ').trim())
  const unique = [...new Set(values)]
  return unique.length ? unique.join(', ') : undefined
}
