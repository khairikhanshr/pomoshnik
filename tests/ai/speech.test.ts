import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SettingsPatch } from '@shared/types'
import { DEFAULT_HTTP_TUNING, OpenAiClient } from '../../src/main/ai/http'
import { MAX_TTS_CHARS, SpeechServiceImpl, audioUpload } from '../../src/main/ai/speech'
import { FakeSecrets, FakeSettings, memoryLog } from './helpers/fakes'
import { MockServer, json, openAiError, type Handler, type RecordedRequest } from './helpers/mock-server'

let server: MockServer
beforeAll(async () => {
  server = await MockServer.start()
})
afterAll(() => server.close())
beforeEach(() => {
  server.reset()
  process.env.JARVIS_ELEVENLABS_BASE_URL = `${server.url}/eleven`
})
afterEach(() => {
  delete process.env.JARVIS_ELEVENLABS_BASE_URL
})

const STT = 'POST /v1/audio/transcriptions'
const TTS = 'POST /v1/audio/speech'
const VOICE = 'JBFqnCBsd6RMkjVDRZzb'
const ELEVEN_TTS = `POST /eleven/v1/text-to-speech/${VOICE}`
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 1, 2, 3, 4])

function speech(patch: SettingsPatch = {}, keys: { openai?: string | null; eleven?: string | null } = {}) {
  const settings = new FakeSettings({ baseUrl: `${server.url}/v1`, ...patch })
  const secrets = new FakeSecrets(
    keys.openai === undefined ? 'sk-test-0123456789abcdef' : keys.openai,
    keys.eleven === undefined ? 'eleven-key-123' : keys.eleven
  )
  const log = memoryLog()
  const tuning = { ...DEFAULT_HTTP_TUNING, retryBaseDelayMs: 5 }
  const http = new OpenAiClient({ settings, secrets, tuning, log })
  return new SpeechServiceImpl({ http, settings, secrets, tuning, log })
}

async function form(req: RecordedRequest): Promise<FormData> {
  return new Request('http://mock/', {
    method: 'POST',
    headers: { 'content-type': String(req.headers['content-type']) },
    body: req.body
  }).formData()
}

const audio = (): Buffer => Buffer.alloc(4000, 7)

const mp3: Handler = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
  res.end(MP3)
}

describe('transcribe', () => {
  it('posts multipart audio with model, filename, language and a vocabulary prompt', async () => {
    server.on(STT, json(200, { text: '  Джарвис, открой Telegram.  ' }))
    const text = await speech({ sttLanguage: 'ru' }).transcribe(audio(), 'audio/webm;codecs=opus')
    expect(text).toBe('Джарвис, открой Telegram.')
    const [req] = server.requestsTo(STT)
    expect(req.headers.authorization).toBe('Bearer sk-test-0123456789abcdef')
    expect(String(req.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/)
    const data = await form(req)
    expect(data.get('model')).toBe('gpt-4o-mini-transcribe')
    expect(data.get('language')).toBe('ru')
    expect(data.get('response_format')).toBe('json')
    expect(String(data.get('prompt'))).toMatch(/^Джарвис, Jarvis, /)
    const file = data.get('file') as File
    expect(file.name).toBe('audio.webm')
    expect(file.type).toBe('audio/webm')
    expect(Buffer.from(await file.arrayBuffer()).equals(audio())).toBe(true)
  })

  it('omits language for auto-detect and names WAV uploads correctly', async () => {
    server.on(STT, json(200, { text: 'hello' }))
    await speech({ sttLanguage: '' }).transcribe(audio(), 'audio/wav')
    const data = await form(server.requestsTo(STT)[0])
    expect(data.has('language')).toBe(false)
    expect((data.get('file') as File).name).toBe('audio.wav')
    expect(audioUpload('audio/ogg;codecs=opus')).toEqual({ name: 'audio.ogg', type: 'audio/ogg' })
    expect(audioUpload('audio/mp4')).toEqual({ name: 'audio.m4a', type: 'audio/mp4' })
  })

  it('falls back sttModel → gpt-4o-transcribe → whisper-1 on model errors', async () => {
    server.enqueue(STT, openAiError(404, 'The model `gpt-9-transcribe` does not exist', 'model_not_found'))
    server.enqueue(STT, openAiError(400, 'Invalid model gpt-4o-transcribe for this endpoint', null, 'invalid_request_error', 'model'))
    server.enqueue(STT, json(200, { text: 'Привет' }))
    const text = await speech({ sttModel: 'gpt-9-transcribe' }).transcribe(audio(), 'audio/wav')
    expect(text).toBe('Привет')
    const models = await Promise.all(server.requestsTo(STT).map(async (r) => (await form(r)).get('model')))
    expect(models).toEqual(['gpt-9-transcribe', 'gpt-4o-transcribe', 'whisper-1'])
  })

  it('does not fall back on auth errors', async () => {
    server.on(STT, openAiError(401, 'Incorrect API key provided', 'invalid_api_key'))
    await expect(speech().transcribe(audio(), 'audio/wav')).rejects.toThrow(/недействителен/)
    expect(server.requestsTo(STT)).toHaveLength(1)
  })

  it('returns "" for tiny uploads, too-short audio and silence hallucinations', async () => {
    expect(await speech().transcribe(Buffer.alloc(44), 'audio/wav')).toBe('')
    expect(server.requests).toHaveLength(0)
    server.enqueue(STT, openAiError(400, 'Audio file is too short. Minimum audio length is 0.1 seconds.', 'audio_too_short'))
    expect(await speech().transcribe(audio(), 'audio/wav')).toBe('')
    server.enqueue(STT, json(200, { text: 'Субтитры сделал DimaTorzok' }))
    expect(await speech().transcribe(audio(), 'audio/wav')).toBe('')
  })
})

describe('synthesize (OpenAI)', () => {
  it('posts the speech request with style instructions for gpt-4o-mini-tts', async () => {
    server.on(TTS, mp3)
    const result = await speech({ ttsSpeed: 1.1 }).synthesize('Добрый вечер, сэр.')
    expect(result.mime).toBe('audio/mpeg')
    expect(result.data.equals(MP3)).toBe(true)
    const body = server.requestsTo(TTS)[0].json()
    expect(body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'onyx',
      input: 'Добрый вечер, сэр.',
      response_format: 'mp3',
      speed: 1.1
    })
    expect(body.instructions).toContain('British AI butler')
  })

  it('falls back to tts-1 without instructions and with a supported voice', async () => {
    server.enqueue(TTS, openAiError(404, 'The model `gpt-4o-mini-tts` does not exist or you do not have access to it.', 'model_not_found'))
    server.enqueue(TTS, mp3)
    await speech({ ttsVoice: 'ballad' }).synthesize('Привет')
    const [first, second] = server.requestsTo(TTS).map((r) => r.json())
    expect(first.model).toBe('gpt-4o-mini-tts')
    expect(first.voice).toBe('ballad')
    expect(second.model).toBe('tts-1')
    expect(second.voice).toBe('onyx')
    expect(second).not.toHaveProperty('instructions')
  })

  it('never sends instructions to tts-1 / tts-1-hd and caps input at 4000 chars', async () => {
    server.on(TTS, mp3)
    const long = 'Это предложение для проверки длины. '.repeat(200)
    await speech({ ttsModel: 'tts-1-hd' }).synthesize(long)
    const body = server.requestsTo(TTS)[0].json()
    expect(body).not.toHaveProperty('instructions')
    expect(body.input.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
    expect(body.input.endsWith('.')).toBe(true)
  })

  it('retries without speed when a server rejects it', async () => {
    server.enqueue(TTS, openAiError(400, "Unsupported parameter: 'speed'", null, 'invalid_request_error', 'speed'))
    server.enqueue(TTS, mp3)
    await speech().synthesize('Тест')
    const bodies = server.requestsTo(TTS).map((r) => r.json())
    expect(bodies[0].speed).toBe(1)
    expect(bodies[1]).not.toHaveProperty('speed')
  })

  it('refuses the system provider and empty text', async () => {
    await expect(speech({ ttsProvider: 'system' }).synthesize('Привет')).rejects.toThrow(/системный голос/i)
    await expect(speech().synthesize('   ')).rejects.toThrow('Нет текста для озвучивания.')
    expect(server.requests).toHaveLength(0)
  })
})

describe('ElevenLabs', () => {
  const eleven: SettingsPatch = {
    ttsProvider: 'elevenlabs',
    elevenVoiceId: VOICE,
    elevenModel: 'eleven_multilingual_v2',
    elevenStability: 0.4,
    elevenSimilarity: 0.8,
    ttsSpeed: 1.6
  }

  it('posts text-to-speech exactly as specified', async () => {
    server.on(ELEVEN_TTS, mp3)
    const result = await speech(eleven).synthesize('Добрый вечер, сэр.')
    expect(result).toEqual({ data: MP3, mime: 'audio/mpeg' })
    const [req] = server.requestsTo(ELEVEN_TTS)
    expect(req.url).toBe(`/eleven/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`)
    expect(req.headers['xi-api-key']).toBe('eleven-key-123')
    expect(req.headers.authorization).toBeUndefined()
    expect(req.json()).toEqual({
      text: 'Добрый вечер, сэр.',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.8, use_speaker_boost: true, speed: 1.2 }
    })
  })

  it('snaps stability for eleven_v3', async () => {
    server.on(ELEVEN_TTS, mp3)
    await speech({ ...eleven, elevenModel: 'eleven_v3', elevenStability: 0.3, ttsSpeed: 0.5 }).synthesize('Тест')
    expect(server.requestsTo(ELEVEN_TTS)[0].json().voice_settings).toMatchObject({ stability: 0.5, speed: 0.7 })
  })

  it('reports missing key and voice in Russian without a request', async () => {
    await expect(speech(eleven, { eleven: null }).synthesize('Тест')).rejects.toThrow(/^Не задан ключ ElevenLabs/)
    await expect(speech({ ...eleven, elevenVoiceId: '' }).synthesize('Тест')).rejects.toThrow(/^Не выбран голос ElevenLabs/)
    expect(server.requests).toHaveLength(0)
  })

  it('maps 401, 404, 422 and quota errors', async () => {
    const s = speech(eleven)
    server.enqueue(ELEVEN_TTS, json(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }))
    await expect(s.synthesize('Тест')).rejects.toThrow('Ключ ElevenLabs недействителен (401). Проверьте ключ в Настройках → Голос.')
    server.enqueue(ELEVEN_TTS, json(404, { detail: { status: 'voice_not_found', message: 'Voice not found' } }))
    await expect(s.synthesize('Тест')).rejects.toThrow(/^Голос ElevenLabs не найден/)
    server.enqueue(ELEVEN_TTS, json(422, { detail: [{ loc: ['body', 'text'], msg: 'Field required', type: 'missing' }] }))
    await expect(s.synthesize('Тест')).rejects.toThrow('ElevenLabs отклонил запрос: text: Field required')
    server.enqueue(ELEVEN_TTS, json(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } }))
    await expect(s.synthesize('Тест')).rejects.toThrow(/^Лимит ElevenLabs исчерпан/)
    server.reset()
    server.on(ELEVEN_TTS, json(429, { detail: { status: 'quota_exceeded', message: 'quota' } }))
    await expect(s.synthesize('Тест')).rejects.toThrow(/^Лимит ElevenLabs исчерпан/)
    expect(server.requests).toHaveLength(1)
  })

  it('retries concurrency 429s, then reports the limit', async () => {
    server.on(ELEVEN_TTS, json(429, { detail: { status: 'too_many_concurrent_requests', message: 'Too many concurrent requests' } }))
    await expect(speech(eleven).synthesize('Тест')).rejects.toThrow(/^Лимит ElevenLabs исчерпан/)
    expect(server.requests).toHaveLength(3)
  })

  it('lists voices with descriptions from labels, sorted by name', async () => {
    server.on(
      'GET /eleven/v1/voices',
      json(200, {
        voices: [
          {
            voice_id: 'v2',
            name: 'George',
            category: 'premade',
            labels: { accent: 'british', description: 'warm', age: 'middle_aged', gender: 'male', use_case: 'narrative_story' },
            preview_url: 'https://storage.example.com/george.mp3'
          },
          { voice_id: 'v1', name: 'alice', labels: {}, preview_url: null },
          { name: 'broken' }
        ]
      })
    )
    const voices = await speech().listElevenLabsVoices()
    expect(voices).toEqual([
      { id: 'v1', name: 'alice' },
      {
        id: 'v2',
        name: 'George',
        description: 'male, british, middle aged, warm, narrative story',
        previewUrl: 'https://storage.example.com/george.mp3'
      }
    ])
    expect(server.requests[0].headers['xi-api-key']).toBe('eleven-key-123')
  })

  it('maps voice listing errors', async () => {
    server.on('GET /eleven/v1/voices', json(401, { detail: { status: 'missing_permissions', message: 'The API key is missing the permission voices_read.' } }))
    await expect(speech().listElevenLabsVoices()).rejects.toThrow(/^У ключа ElevenLabs нет нужных прав/)
    await expect(speech({}, { eleven: null }).listElevenLabsVoices()).rejects.toThrow(/^Не задан ключ ElevenLabs/)
  })
})
