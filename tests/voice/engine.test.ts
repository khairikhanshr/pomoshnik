import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { SendChatResult, SpeechDoneReport } from '@shared/ipc'
import type { PublicSettings, SpeakChunk, VoicePhaseReport } from '@shared/types'
import {
  importRenderer,
  type CaptureControl,
  type ChimeKind,
  type EngineModule,
  type LocalRecognizer,
  type Logger,
  type MainBridge,
  type Segment,
  type SegmenterOptions,
  type SpeechOutput
} from './support/renderer'

const { VoiceEngine, WAKE_WINDOW_MS } = await importRenderer<EngineModule>('voice/engine')

const SR = 16000

function settings(patch: Partial<PublicSettings> = {}): PublicSettings {
  return {
    ...DEFAULT_SETTINGS,
    hasApiKey: true,
    apiKeyHint: 'sk-…test',
    hasElevenLabsKey: false,
    elevenLabsKeyHint: '',
    platform: 'darwin',
    appVersion: '1.0.0',
    resolvedModels: { luna: 'gpt-5.6-luna', terra: 'gpt-5.6-terra', sol: 'gpt-5.6-sol' },
    ...patch
  }
}

/** A speech segment: 0.4 s pre-pad, `speech` seconds of speech, 0.25 s tail. */
function segment(id: number, speech: number): Segment {
  const speechStart = 0.4 * SR
  const speechEnd = speechStart + Math.round(speech * SR)
  return { id, audio: new Float32Array(speechEnd + 0.25 * SR), speechStart, speechEnd, reason: 'silence' }
}

class FakeCapture implements CaptureControl {
  running = false
  segmentId = 0
  options: Partial<SegmenterOptions> = {}
  current: Segment | null = null
  starts: string[] = []
  stops = 0
  async start(deviceId: string): Promise<void> {
    this.running = true
    this.starts.push(deviceId)
  }
  async stop(): Promise<void> {
    this.running = false
    this.stops++
  }
  configure(options: Partial<SegmenterOptions>): void {
    Object.assign(this.options, options)
  }
  snapshot(): Segment | null {
    return this.current
  }
}

class FakeLocal implements LocalRecognizer {
  ready = false
  failLoad = false
  replies: string[] = []
  calls: Array<{ samples: number; languages: string[]; maxNewTokens: number }> = []
  disposed = 0
  async load(): Promise<void> {
    if (this.failLoad) throw new Error('model missing')
    this.ready = true
  }
  async transcribe(audio: Float32Array, languages: string[], maxNewTokens: number) {
    this.calls.push({ samples: audio.length, languages, maxNewTokens })
    return { text: this.replies.shift() ?? '', language: 'ru' }
  }
  dispose(): void {
    this.ready = false
    this.disposed++
  }
}

class FakeTts implements SpeechOutput {
  playing = false
  activeTurn: string | null = null
  chunks: SpeakChunk[] = []
  phrases: string[] = []
  spoken: string[] = []
  stops = 0
  onDone: (turnId: string, interrupted: boolean) => void = () => undefined
  configure(): void {}
  enqueue(chunk: SpeakChunk): void {
    this.chunks.push(chunk)
    this.activeTurn = chunk.turnId
  }
  stop(): void {
    this.stops++
    const turn = this.activeTurn
    this.activeTurn = null
    this.playing = false
    if (turn) this.onDone(turn, true)
  }
  async speakPhrase(text: string): Promise<void> {
    this.phrases.push(text)
  }
  prefetchPhrase(): void {}
  recentlySpoken(): string[] {
    return this.spoken
  }
}

class FakeBridge implements MainBridge {
  phases: VoicePhaseReport[] = []
  levels: number[] = []
  done: SpeechDoneReport[] = []
  submitted: string[] = []
  cancels = 0
  cloud: Array<string | Error> = []
  transcribeCalls = 0
  submitError: Error | null = null
  async submit(text: string): Promise<SendChatResult> {
    if (this.submitError) throw this.submitError
    this.submitted.push(text)
    return { chatId: 'c1', turnId: `t${this.submitted.length}` }
  }
  async cancelTurn(): Promise<void> {
    this.cancels++
  }
  async transcribe(wav: ArrayBuffer): Promise<string> {
    this.transcribeCalls++
    expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe('RIFF')
    const next = this.cloud.shift() ?? ''
    if (next instanceof Error) throw next
    return next
  }
  reportPhase(report: VoicePhaseReport): void {
    this.phases.push(report)
  }
  reportLevel(level: number): void {
    this.levels.push(level)
  }
  reportSpeechDone(report: SpeechDoneReport): void {
    this.done.push(report)
  }
  get phase(): string | undefined {
    return this.phases.at(-1)?.phase
  }
}

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

function setup(patch: Partial<PublicSettings> = {}) {
  const capture = new FakeCapture()
  const local = new FakeLocal()
  const tts = new FakeTts()
  const bridge = new FakeBridge()
  const chimes: ChimeKind[] = []
  const engine = new VoiceEngine({
    bridge,
    capture,
    local,
    tts,
    chime: async (kind) => {
      chimes.push(kind)
    },
    log: quiet
  })
  tts.onDone = (turn, interrupted) => engine.onTurnDone(turn, interrupted)
  engine.applySettings(settings(patch))
  engine.onMicStream()
  return { engine, capture, local, tts, bridge, chimes }
}

type Ctx = ReturnType<typeof setup>

const flush = () => vi.advanceTimersByTimeAsync(0)

/** Simulates one VAD segment: speech start, then end. */
async function say(ctx: Ctx, seg: Segment): Promise<void> {
  ctx.capture.segmentId = seg.id
  ctx.engine.onSpeechStart(seg.id)
  ctx.capture.segmentId = 0
  await ctx.engine.onSpeechEnd(seg)
  await flush()
}

/** Plays a whole spoken turn through the engine. */
function speakTurn(ctx: Ctx, turnId: string, text = 'Готово, сэр.'): void {
  ctx.engine.speak({ turnId, seq: 0, text, final: false })
  ctx.tts.playing = true
  ctx.tts.spoken = [text]
  ctx.engine.onTurnStart(turnId)
}

function finishTurn(ctx: Ctx, turnId: string): void {
  ctx.tts.playing = false
  ctx.tts.activeTurn = null
  ctx.engine.onTurnDone(turnId, false)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('VoiceEngine — wake word (local)', () => {
  it('starts capture and loads the model; reports wakeActive', async () => {
    const ctx = setup({ micDeviceId: 'mic-1' })
    await flush()
    expect(ctx.capture.starts).toContain('mic-1')
    expect(ctx.local.ready).toBe(true)
    expect(ctx.bridge.phases.at(-1)).toEqual({ phase: 'idle', wakeActive: true, engineError: null })
  })

  it('wake word + command in one breath → cloud transcript of the whole segment is submitted', async () => {
    const ctx = setup()
    await flush()
    ctx.local.replies = ['Джарвис, открой калькулятор']
    ctx.bridge.cloud = ['Джарвис, открой калькулятор.']
    await say(ctx, segment(1, 1.8))
    expect(ctx.local.calls).toHaveLength(1)
    expect(ctx.local.calls[0].languages).toEqual(['ru', 'en'])
    expect(ctx.local.calls[0].maxNewTokens).toBe(24)
    expect(ctx.bridge.transcribeCalls).toBe(1)
    expect(ctx.bridge.submitted).toEqual(['открой калькулятор.'])
    expect(ctx.bridge.phases.map((p) => p.phase)).toContain('transcribing')
    expect(ctx.bridge.phases.at(-1)).toMatchObject({ phase: 'thinking', transcript: 'открой калькулятор.' })
  })

  it('checks only the first ~3 s of a segment locally', async () => {
    const ctx = setup()
    await flush()
    ctx.local.replies = ['Привет']
    await say(ctx, segment(1, 2.0))
    expect(ctx.local.calls[0].samples).toBeLessThanOrEqual(0.4 * SR + (WAKE_WINDOW_MS / 1000) * SR)
  })

  it('ignores speech without the wake word (no cloud call, no phase change)', async () => {
    const ctx = setup()
    await flush()
    const before = ctx.bridge.phases.length
    ctx.local.replies = ['Привет, как дела?']
    await say(ctx, segment(1, 1.2))
    ctx.local.replies = ['Дарвин был великим учёным']
    await say(ctx, segment(2, 1.5))
    expect(ctx.bridge.transcribeCalls).toBe(0)
    expect(ctx.bridge.submitted).toEqual([])
    expect(ctx.bridge.phases.length).toBe(before)
  })

  it('bare wake word → chime, listening; the next speech is the command', async () => {
    const ctx = setup()
    await flush()
    ctx.local.replies = ['Джарвис.']
    await say(ctx, segment(1, 0.6))
    expect(ctx.chimes).toEqual(['listen'])
    const phases = ctx.bridge.phases.map((p) => p.phase)
    expect(phases).toContain('wake')
    expect(ctx.bridge.phase).toBe('listening')
    ctx.bridge.cloud = ['Открой калькулятор']
    await say(ctx, segment(2, 1.2))
    expect(ctx.local.calls).toHaveLength(1) // no wake check for the command
    expect(ctx.bridge.submitted).toEqual(['Открой калькулятор'])
  })

  it('speaks "Да, сэр?" when acknowledge is voice', async () => {
    const ctx = setup({ acknowledge: 'voice' })
    await flush()
    ctx.local.replies = ['Джарвис']
    await say(ctx, segment(1, 0.6))
    expect(ctx.chimes).toEqual([])
    expect(ctx.tts.phrases).toEqual(['Да, сэр?'])
    expect(ctx.bridge.phase).toBe('listening')
  })

  it('closes the command window after commandTimeoutSeconds without speech', async () => {
    const ctx = setup({ commandTimeoutSeconds: 5 })
    await flush()
    ctx.local.replies = ['Джарвис']
    await say(ctx, segment(1, 0.6))
    expect(ctx.bridge.phase).toBe('listening')
    await vi.advanceTimersByTimeAsync(4900)
    expect(ctx.bridge.phase).toBe('listening')
    await vi.advanceTimersByTimeAsync(200)
    expect(ctx.bridge.phase).toBe('idle')
  })

  it('keeps listening while the command is being spoken past the timeout', async () => {
    const ctx = setup({ commandTimeoutSeconds: 3 })
    await flush()
    ctx.local.replies = ['Джарвис']
    await say(ctx, segment(1, 0.6))
    ctx.capture.segmentId = 2
    ctx.engine.onSpeechStart(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctx.bridge.phase).toBe('listening')
    ctx.capture.segmentId = 0
    ctx.bridge.cloud = ['Напиши длинное письмо маме']
    await ctx.engine.onSpeechEnd(segment(2, 10))
    await flush()
    expect(ctx.bridge.submitted).toEqual(['Напиши длинное письмо маме'])
  })

  it('early check: wake word detected while the user is still talking promotes the segment to a command', async () => {
    const ctx = setup()
    await flush()
    const partial = segment(1, 3.0)
    ctx.capture.segmentId = 1
    ctx.capture.current = partial
    ctx.engine.onSpeechStart(1)
    ctx.local.replies = ['Джарвис, напиши письмо']
    ctx.engine.onProgress(1, WAKE_WINDOW_MS)
    await flush()
    expect(ctx.bridge.phase).toBe('listening')
    expect(ctx.capture.options).toMatchObject({ redemptionMs: 1300, maxSegmentMs: 30_000 })
    ctx.capture.segmentId = 0
    ctx.bridge.cloud = ['Джарвис, напиши письмо маме о том, что я приеду в субботу']
    await ctx.engine.onSpeechEnd(segment(1, 6))
    await flush()
    expect(ctx.local.calls).toHaveLength(1)
    expect(ctx.bridge.submitted).toEqual(['напиши письмо маме о том, что я приеду в субботу'])
  })

  it('early check without the wake word rejects the segment', async () => {
    const ctx = setup()
    await flush()
    ctx.capture.segmentId = 1
    ctx.capture.current = segment(1, 3.0)
    ctx.engine.onSpeechStart(1)
    ctx.local.replies = ['Ну и вот я ему говорю']
    ctx.engine.onProgress(1, WAKE_WINDOW_MS)
    await flush()
    ctx.capture.segmentId = 0
    await ctx.engine.onSpeechEnd(segment(1, 8))
    await flush()
    expect(ctx.local.calls).toHaveLength(1)
    expect(ctx.bridge.transcribeCalls).toBe(0)
  })

  it('a long segment whose window holds only the wake word is still a command', async () => {
    const ctx = setup()
    await flush()
    ctx.local.replies = ['Джарвис']
    ctx.bridge.cloud = ['Джарвис, сделай скриншот и ответь на вопросы']
    await say(ctx, segment(1, 5))
    expect(ctx.bridge.submitted).toEqual(['сделай скриншот и ответь на вопросы'])
  })

  it('falls back to the local transcript when cloud transcription fails', async () => {
    const ctx = setup()
    await flush()
    ctx.local.replies = ['Джарвис, открой почту', 'Джарвис, открой почту']
    ctx.bridge.cloud = [new Error('network down')]
    await say(ctx, segment(1, 1.5))
    expect(ctx.local.calls.map((c) => c.maxNewTokens)).toEqual([24, 200])
    expect(ctx.bridge.submitted).toEqual(['открой почту'])
  })

  it('reports an error when nothing can transcribe the command', async () => {
    const ctx = setup()
    await flush()
    ctx.local.replies = ['Джарвис']
    await say(ctx, segment(1, 0.6))
    ctx.local.ready = false
    ctx.bridge.cloud = [new Error('Не задан API-ключ OpenAI.')]
    await say(ctx, segment(2, 1.0))
    expect(ctx.bridge.phases.at(-1)).toMatchObject({ phase: 'error' })
    expect(ctx.bridge.phases.at(-1)?.error).toContain('Не задан API-ключ OpenAI.')
    await vi.advanceTimersByTimeAsync(4100)
    expect(ctx.bridge.phase).toBe('idle')
  })

  it('ignores hallucinated commands and keeps the window open', async () => {
    const ctx = setup({ commandTimeoutSeconds: 8 })
    await flush()
    ctx.local.replies = ['Джарвис']
    await say(ctx, segment(1, 0.6))
    ctx.bridge.cloud = ['Продолжение следует...']
    await say(ctx, segment(2, 1.0))
    expect(ctx.bridge.submitted).toEqual([])
    expect(ctx.bridge.phase).toBe('listening')
    ctx.bridge.cloud = ['Который час?']
    await say(ctx, segment(3, 1.0))
    expect(ctx.bridge.submitted).toEqual(['Который час?'])
  })
})

describe('VoiceEngine — speaking, barge-in, follow-up', () => {
  it('reports speaking and speech done; follow-up window after a voice turn', async () => {
    const ctx = setup({ followUpSeconds: 6 })
    await flush()
    ctx.local.replies = ['Джарвис, который час']
    ctx.bridge.cloud = ['Джарвис, который час?']
    await say(ctx, segment(1, 1.2))
    speakTurn(ctx, 't1', 'Сейчас три часа, сэр.')
    expect(ctx.bridge.phase).toBe('speaking')
    expect(ctx.capture.options.positiveThreshold).toBe(0.7)
    finishTurn(ctx, 't1')
    expect(ctx.bridge.done).toEqual([{ turnId: 't1', interrupted: false }])
    expect(ctx.bridge.phase).toBe('listening')
    expect(ctx.capture.options.positiveThreshold).toBe(0.5)
    ctx.bridge.cloud = ['А завтра?']
    await vi.advanceTimersByTimeAsync(3000)
    await say(ctx, segment(2, 1.0))
    expect(ctx.bridge.submitted).toEqual(['который час?', 'А завтра?'])
  })

  it('follow-up window expires', async () => {
    const ctx = setup({ followUpSeconds: 4 })
    await flush()
    ctx.local.replies = ['Джарвис, привет']
    ctx.bridge.cloud = ['Джарвис, привет']
    await say(ctx, segment(1, 1))
    speakTurn(ctx, 't1')
    finishTurn(ctx, 't1')
    expect(ctx.bridge.phase).toBe('listening')
    await vi.advanceTimersByTimeAsync(4100)
    expect(ctx.bridge.phase).toBe('idle')
  })

  it('no follow-up for turns not started by voice or with followUpSeconds = 0', async () => {
    const ctx = setup({ followUpSeconds: 6 })
    await flush()
    speakTurn(ctx, 'replay-abc')
    finishTurn(ctx, 'replay-abc')
    expect(ctx.bridge.phase).toBe('idle')
    const ctx2 = setup({ followUpSeconds: 0 })
    await flush()
    ctx2.local.replies = ['Джарвис, привет']
    ctx2.bridge.cloud = ['Джарвис, привет']
    await say(ctx2, segment(1, 1))
    speakTurn(ctx2, 't1')
    finishTurn(ctx2, 't1')
    expect(ctx2.bridge.phase).toBe('idle')
  })

  it('barge-in: the wake word while speaking stops playback and runs the new command', async () => {
    const ctx = setup()
    await flush()
    speakTurn(ctx, 'reminder-1', 'Напоминаю: пора на встречу.')
    ctx.local.replies = ['Джарвис, который час?']
    ctx.bridge.cloud = ['Джарвис, который час?']
    await say(ctx, segment(1, 1.3))
    expect(ctx.tts.stops).toBe(1)
    expect(ctx.bridge.done).toEqual([{ turnId: 'reminder-1', interrupted: true }])
    expect(ctx.bridge.submitted).toEqual(['который час?'])
    // speaking → transcribing directly: no idle flash in between.
    const phases = ctx.bridge.phases.map((p) => p.phase)
    const from = phases.lastIndexOf('speaking')
    expect(phases.slice(from, from + 2)).toEqual(['speaking', 'transcribing'])
  })

  it('while speaking, speech without the wake word is ignored', async () => {
    const ctx = setup()
    await flush()
    speakTurn(ctx, 'x1', 'Сегодня солнечно.')
    ctx.local.replies = ['Ну да, конечно']
    await say(ctx, segment(1, 1.3))
    expect(ctx.tts.stops).toBe(0)
    expect(ctx.bridge.transcribeCalls).toBe(0)
  })

  it('echo guard: our own speech containing the wake word does not trigger', async () => {
    const ctx = setup()
    await flush()
    speakTurn(ctx, 'x1', 'Джарвис к вашим услугам, сэр.')
    ctx.local.replies = ['Джарвис к вашим услугам']
    await say(ctx, segment(1, 1.5))
    expect(ctx.tts.stops).toBe(0)
    expect(ctx.bridge.submitted).toEqual([])
  })

  it('"Джарвис, стоп" stops speaking and cancels the turn without a model call', async () => {
    const ctx = setup()
    await flush()
    speakTurn(ctx, 't9', 'Длинный ответ про погоду.')
    ctx.local.replies = ['Джарвис, стоп']
    ctx.bridge.cloud = ['Джарвис, стоп!']
    await say(ctx, segment(1, 1.0))
    expect(ctx.tts.stops).toBeGreaterThanOrEqual(1)
    expect(ctx.bridge.cancels).toBe(1)
    expect(ctx.bridge.submitted).toEqual([])
    expect(ctx.chimes).toContain('cancel')
  })

  it('stop-speaking from main reports an interrupted turn', async () => {
    const ctx = setup()
    await flush()
    speakTurn(ctx, 't3')
    ctx.engine.stopSpeaking()
    expect(ctx.bridge.done).toEqual([{ turnId: 't3', interrupted: true }])
    expect(ctx.bridge.phase).toBe('idle')
  })

  it('a new turn starting during the follow-up window closes it', async () => {
    const ctx = setup({ followUpSeconds: 6 })
    await flush()
    ctx.local.replies = ['Джарвис, привет']
    ctx.bridge.cloud = ['Джарвис, привет']
    await say(ctx, segment(1, 1))
    speakTurn(ctx, 't1')
    finishTurn(ctx, 't1')
    expect(ctx.bridge.phase).toBe('listening')
    speakTurn(ctx, 'reminder-7')
    expect(ctx.bridge.phase).toBe('speaking')
  })
})

describe('VoiceEngine — push-to-talk and settings', () => {
  it('push-to-talk: chime, listening, next speech is the command (no wake word)', async () => {
    const ctx = setup()
    await flush()
    ctx.engine.listen()
    await flush()
    expect(ctx.chimes).toEqual(['listen'])
    expect(ctx.bridge.phase).toBe('listening')
    ctx.bridge.cloud = ['Открой Telegram']
    await say(ctx, segment(1, 1.0))
    expect(ctx.local.calls).toHaveLength(0)
    expect(ctx.bridge.submitted).toEqual(['Открой Telegram'])
  })

  it('push-to-talk stops current speech first', async () => {
    const ctx = setup()
    await flush()
    speakTurn(ctx, 't1')
    ctx.engine.listen()
    await flush()
    expect(ctx.bridge.done).toEqual([{ turnId: 't1', interrupted: true }])
    expect(ctx.bridge.phase).toBe('listening')
  })

  it('push-to-talk strips a leading wake word', async () => {
    const ctx = setup()
    await flush()
    ctx.engine.listen()
    await flush()
    ctx.bridge.cloud = ['Джарвис, включи музыку']
    await say(ctx, segment(1, 1.0))
    expect(ctx.bridge.submitted).toEqual(['включи музыку'])
  })

  it('with the wake engine off the microphone runs only for a push-to-talk session', async () => {
    const ctx = setup({ wakeEngine: 'off', followUpSeconds: 0 })
    await flush()
    expect(ctx.capture.running).toBe(false)
    expect(ctx.local.ready).toBe(false)
    expect(ctx.bridge.phases.at(-1)).toMatchObject({ phase: 'idle', wakeActive: false })
    ctx.engine.listen()
    await flush()
    expect(ctx.capture.running).toBe(true)
    ctx.bridge.cloud = ['Который час?']
    await say(ctx, segment(1, 1.0))
    expect(ctx.bridge.submitted).toEqual(['Который час?'])
    expect(ctx.capture.running).toBe(true) // waiting for the reply
    ctx.engine.onAssistantState({ phase: 'thinking', wakeActive: false, updatedAt: 0 })
    speakTurn(ctx, 't1')
    finishTurn(ctx, 't1')
    ctx.engine.onAssistantState({ phase: 'idle', wakeActive: false, updatedAt: 0 })
    await flush()
    expect(ctx.capture.running).toBe(false)
  })

  it('applies settings live: engine off/on, device change, tray toggle', async () => {
    const ctx = setup({ micDeviceId: 'a' })
    await flush()
    ctx.engine.applySettings(settings({ micDeviceId: 'b' }))
    expect(ctx.capture.starts.at(-1)).toBe('b')
    ctx.engine.applySettings(settings({ micDeviceId: 'b', wakeEngine: 'off' }))
    await flush()
    expect(ctx.capture.running).toBe(false)
    expect(ctx.local.disposed).toBeGreaterThan(0)
    ctx.engine.setWakeEnabled(true)
    await flush()
    expect(ctx.capture.running).toBe(true)
    expect(ctx.local.ready).toBe(true)
    ctx.engine.setWakeEnabled(false)
    await flush()
    expect(ctx.capture.running).toBe(false)
  })

  it('uses changed wake phrases and sensitivity immediately', async () => {
    const ctx = setup()
    await flush()
    ctx.engine.applySettings(settings({ wakePhrases: ['пятница'] }))
    ctx.local.replies = ['Джарвис, привет']
    await say(ctx, segment(1, 1.0))
    expect(ctx.bridge.transcribeCalls).toBe(0)
    ctx.local.replies = ['Пятница, привет']
    ctx.bridge.cloud = ['Пятница, привет']
    await say(ctx, segment(2, 1.0))
    expect(ctx.bridge.submitted).toEqual(['привет'])
  })

  it('cloud engine: one transcription per segment, wake word stripped', async () => {
    const ctx = setup({ wakeEngine: 'cloud' })
    await flush()
    expect(ctx.local.ready).toBe(false)
    ctx.bridge.cloud = ['Привет, как дела']
    await say(ctx, segment(1, 1.0))
    ctx.bridge.cloud = ['Джарвис, открой почту.']
    await say(ctx, segment(2, 1.2))
    expect(ctx.bridge.transcribeCalls).toBe(2)
    expect(ctx.bridge.submitted).toEqual(['открой почту.'])
  })

  it('cloud engine without an API key reports an engine error', async () => {
    const ctx = setup({ wakeEngine: 'cloud', hasApiKey: false })
    await flush()
    expect(ctx.bridge.phases.at(-1)).toMatchObject({ wakeActive: false })
    expect(ctx.bridge.phases.at(-1)?.engineError).toMatch(/API-ключ/)
  })

  it('reports microphone errors and recovers', async () => {
    const ctx = setup()
    await flush()
    ctx.engine.onMicError('Нет доступа к микрофону.')
    expect(ctx.bridge.phases.at(-1)).toMatchObject({ wakeActive: false, engineError: 'Нет доступа к микрофону.' })
    ctx.engine.onMicStream()
    expect(ctx.bridge.phases.at(-1)).toMatchObject({ wakeActive: true, engineError: null })
  })

  it('model load failure → engine error, retried later', async () => {
    const capture = new FakeCapture()
    const local = new FakeLocal()
    local.failLoad = true
    const bridge = new FakeBridge()
    const engine = new VoiceEngine({ bridge, capture, local, tts: new FakeTts(), chime: async () => undefined, log: quiet })
    engine.applySettings(settings())
    engine.onMicStream()
    await flush()
    expect(bridge.phases.at(-1)?.engineError).toMatch(/локальную модель/)
    local.failLoad = false
    await vi.advanceTimersByTimeAsync(10_100)
    expect(local.ready).toBe(true)
    expect(bridge.phases.at(-1)).toMatchObject({ wakeActive: true, engineError: null })
  })

  it('submit failure is reported as an error phase', async () => {
    const ctx = setup()
    await flush()
    ctx.bridge.submitError = new Error("Error invoking remote method 'voice:submit': Error: boom")
    ctx.engine.listen()
    await flush()
    ctx.bridge.cloud = ['Привет']
    await say(ctx, segment(1, 1.0))
    expect(ctx.bridge.phases.at(-1)).toMatchObject({ phase: 'error', error: 'Не удалось отправить команду: boom' })
  })

  it('does not report idle over the assistant thinking', async () => {
    const ctx = setup()
    await flush()
    ctx.engine.onAssistantState({ phase: 'thinking', wakeActive: true, updatedAt: 0 })
    ctx.engine.onMicError('x')
    expect(ctx.bridge.phases.at(-1)?.phase).toBe('thinking')
  })

  it('throttles mic levels and drops background noise', async () => {
    const ctx = setup()
    await flush()
    for (let i = 0; i < 30; i++) ctx.engine.onMicLevel(i % 2 ? 0.6 : 0.05)
    await vi.advanceTimersByTimeAsync(70)
    expect(ctx.bridge.levels).toEqual([0.6])
    for (let i = 0; i < 30; i++) ctx.engine.onMicLevel(0.05)
    await vi.advanceTimersByTimeAsync(300)
    expect(ctx.bridge.levels).toEqual([0.6, 0])
  })
})
