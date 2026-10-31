// Speech output: ordered playback of a turn's SpeakChunks. Cloud voices (OpenAI / ElevenLabs via main's
// speech.synthesize) are prefetched up to 2 chunks ahead and played through WebAudio; the OS voice
// (speechSynthesis) is used for ttsProvider 'system' and whenever cloud synthesis fails.
import type { SynthesizeResult } from '@shared/ipc'
import type { SpeakChunk } from '@shared/types'
import { levelFromRms } from './audio'
import type { TtsConfig } from './engine-types'
import { errorText, type Logger } from './log'
import { loadVoices, pickVoice, speakSystem } from './system-voice'

export interface TtsEvents {
  /** First audio of a turn started playing. */
  onTurnStart(turnId: string): void
  /** All chunks of the turn were played (interrupted=false) or playback was stopped. */
  onTurnDone(turnId: string, interrupted: boolean): void
  /** Output level 0..1 while audio plays (~15/s). */
  onLevel(level: number): void
}

interface QueuedChunk {
  seq: number
  text: string
  final: boolean
  audio: Promise<AudioBuffer | null> | null
}

interface Turn {
  id: string
  firstSeq: number
  seen: Set<number>
  queue: QueuedChunk[]
  finalSeen: boolean
  started: boolean
  useSystem: boolean
  wake: (() => void) | null
}

interface Playback {
  done: Promise<void>
  stop(): void
}

const PREFETCH_AHEAD = 2
const MISSING_FINAL_TIMEOUT_MS = 90_000
const CLOUD_RETRY_AFTER_MS = 60_000
const PHRASE_SYNTH_TIMEOUT_MS = 2500
const LEVEL_INTERVAL_MS = 66
const SPOKEN_MEMORY_MS = 15_000

export class TtsQueue {
  private config: TtsConfig = { provider: 'system', systemVoiceName: '', speed: 1, voiceKey: '' }
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private turn: Turn | null = null
  /** Recently finished turns: late chunks of a stopped turn must not restart it. */
  private finished: Array<{ id: string; firstSeq: number }> = []
  private current: Playback | null = null
  private cloudDownUntil = 0
  private phraseCache = new Map<string, Promise<AudioBuffer | null>>()
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private synthetic = false
  private spoken: Array<{ text: string; until: number }> = []
  private activeTexts = new Set<string>()

  constructor(
    private readonly synthesize: (text: string) => Promise<SynthesizeResult>,
    private readonly events: TtsEvents,
    private readonly log: Logger
  ) {}

  /** Audio of ours is currently playing (turn speech or a short phrase). */
  get playing(): boolean {
    return this.current !== null
  }

  get activeTurn(): string | null {
    return this.turn?.id ?? null
  }

  configure(config: TtsConfig): void {
    if (config.voiceKey !== this.config.voiceKey || config.provider !== this.config.provider) {
      this.phraseCache.clear()
      this.cloudDownUntil = 0
    }
    this.config = config
  }

  /** Shared output context (also used for chimes). */
  audioContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined)
    return this.ctx
  }

  enqueue(chunk: SpeakChunk): void {
    const done = this.finished.find((f) => f.id === chunk.turnId)
    if (done) {
      // A replay reuses its turn id and starts again from the first chunk; anything else is a late chunk.
      if (chunk.seq > done.firstSeq) return
      this.finished = this.finished.filter((f) => f !== done)
    }
    let turn = this.turn
    if (turn && turn.id === chunk.turnId && turn.seen.has(chunk.seq)) {
      if (chunk.seq !== turn.firstSeq) return
      this.interrupt(turn) // the same message replayed again while still speaking
      this.finished = this.finished.filter((f) => f.id !== chunk.turnId)
      turn = null
    }
    if (!turn || turn.id !== chunk.turnId) {
      if (turn) this.interrupt(turn)
      turn = {
        id: chunk.turnId,
        firstSeq: chunk.seq,
        seen: new Set(),
        queue: [],
        finalSeen: false,
        started: false,
        useSystem: false,
        wake: null
      }
      this.turn = turn
      void this.run(turn)
    }
    turn.seen.add(chunk.seq)
    turn.firstSeq = Math.min(turn.firstSeq, chunk.seq)
    const item: QueuedChunk = { seq: chunk.seq, text: chunk.text ?? '', final: chunk.final, audio: null }
    const at = turn.queue.findIndex((c) => c.seq > chunk.seq)
    if (at < 0) turn.queue.push(item)
    else turn.queue.splice(at, 0, item)
    if (chunk.final) turn.finalSeen = true
    this.prefetch(turn)
    turn.wake?.()
  }

  /** Stops playback and drops queued chunks; the active turn is reported as interrupted. */
  stop(): void {
    const turn = this.turn
    this.current?.stop()
    if (turn) this.interrupt(turn)
  }

  /** Speaks a short phrase outside of any turn (acknowledgement); resolves when it has been played. */
  async speakPhrase(text: string): Promise<void> {
    const phrase = text.trim()
    if (!phrase) return
    let buffer: AudioBuffer | null = null
    if (this.cloudUsable()) {
      const key = `${this.config.voiceKey}\n${phrase}`
      let cached = this.phraseCache.get(key)
      if (!cached) {
        cached = this.fetchAudio(phrase)
        this.phraseCache.set(key, cached)
        void cached.then((b) => b === null && this.phraseCache.delete(key))
      }
      // Never keep the user waiting on a slow first synthesis; the cached result serves next time.
      buffer = await Promise.race([cached, delay(PHRASE_SYNTH_TIMEOUT_MS).then(() => null)])
    }
    this.current?.stop()
    const playback = buffer ? this.playBuffer(buffer, phrase) : await this.playSystem(phrase)
    await playback.done
  }

  /** Warms the phrase cache so the first acknowledgement is instant. */
  prefetchPhrase(text: string): void {
    const phrase = text.trim()
    if (!phrase || !this.cloudUsable()) return
    const key = `${this.config.voiceKey}\n${phrase}`
    if (this.phraseCache.has(key)) return
    const p = this.fetchAudio(phrase, true)
    this.phraseCache.set(key, p)
    void p.then((b) => b === null && this.phraseCache.delete(key))
  }

  /** Texts that are playing or finished playing recently (echo guard). */
  recentlySpoken(windowMs: number): string[] {
    const now = Date.now()
    this.spoken = this.spoken.filter((s) => now - s.until < SPOKEN_MEMORY_MS)
    return [...this.activeTexts, ...this.spoken.filter((s) => now - s.until <= windowMs).map((s) => s.text)]
  }

  dispose(): void {
    this.stop()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }

  private async run(turn: Turn): Promise<void> {
    try {
      while (this.turn === turn) {
        const next = turn.queue[0]
        if (!next) {
          if (turn.finalSeen) {
            this.finish(turn, false)
            return
          }
          const gotChunk = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), MISSING_FINAL_TIMEOUT_MS)
            turn.wake = () => {
              clearTimeout(timer)
              turn.wake = null
              resolve(true)
            }
          })
          if (!gotChunk && this.turn === turn) {
            this.log.warn(`Turn ${turn.id}: no final speech chunk received, finishing`)
            this.finish(turn, false)
            return
          }
          continue
        }
        turn.queue.shift()
        this.prefetch(turn)
        if (next.text.trim()) await this.playChunk(turn, next)
      }
    } catch (err) {
      this.log.error(`Speech playback failed: ${errorText(err)}`)
      if (this.turn === turn) this.finish(turn, true)
    }
  }

  private async playChunk(turn: Turn, chunk: QueuedChunk): Promise<void> {
    let playback: Playback | null = null
    if (!turn.useSystem && this.cloudUsable()) {
      chunk.audio ??= this.fetchAudio(chunk.text)
      const buffer = await chunk.audio
      if (this.turn !== turn) return
      if (buffer) playback = this.playBuffer(buffer, chunk.text)
      else turn.useSystem = true // keep one voice for the rest of the turn
    }
    if (!playback) {
      playback = await this.playSystem(chunk.text)
      if (this.turn !== turn) {
        playback.stop()
        return
      }
    }
    if (!turn.started) {
      turn.started = true
      this.events.onTurnStart(turn.id)
    }
    await playback.done
  }

  private prefetch(turn: Turn): void {
    if (turn.useSystem || !this.cloudUsable()) return
    let ahead = 0
    for (const c of turn.queue) {
      if (ahead >= PREFETCH_AHEAD + (this.current ? 0 : 1)) break
      if (!c.text.trim()) continue
      c.audio ??= this.fetchAudio(c.text)
      ahead++
    }
  }

  private cloudUsable(): boolean {
    return this.config.provider !== 'system' && Date.now() >= this.cloudDownUntil
  }

  private async fetchAudio(text: string, quiet = false): Promise<AudioBuffer | null> {
    try {
      const res = await this.synthesize(text)
      const bytes = res.audio
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      return await this.audioContext().decodeAudioData(data)
    } catch (err) {
      this.cloudDownUntil = Date.now() + CLOUD_RETRY_AFTER_MS
      const msg = `Cloud speech (${this.config.provider}) failed, using the system voice: ${errorText(err)}`
      if (quiet) this.log.info(msg)
      else this.log.warn(msg)
      return null
    }
  }

  private playBuffer(buffer: AudioBuffer, text: string): Playback {
    const ctx = this.audioContext()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser ?? ctx.destination)
    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((resolve) => (resolveDone = resolve))
    const playback: Playback = {
      done,
      stop: () => {
        try {
          source.stop()
        } catch {
          // already stopped
        }
        finish()
      }
    }
    const finish = (): void => {
      source.onended = null
      source.disconnect()
      this.ended(playback, text)
      resolveDone()
    }
    source.onended = finish
    this.began(playback, text, false)
    source.start()
    return playback
  }

  private async playSystem(text: string): Promise<Playback> {
    const voices = await loadVoices()
    const voice = pickVoice(voices, text, this.config.systemVoiceName)
    const utterance = speakSystem(text, voice, this.config.speed)
    const playback: Playback = {
      done: utterance.done.then(() => this.ended(playback, text)),
      stop: () => utterance.cancel()
    }
    this.began(playback, text, true)
    return playback
  }

  private began(playback: Playback, text: string, synthetic: boolean): void {
    this.current = playback
    this.activeTexts.add(text)
    this.synthetic = synthetic
    if (!this.levelTimer) this.levelTimer = setInterval(() => this.meter(), LEVEL_INTERVAL_MS)
  }

  private ended(playback: Playback, text: string): void {
    this.activeTexts.delete(text)
    this.spoken.push({ text, until: Date.now() })
    if (this.current !== playback) return
    this.current = null
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.levelTimer = null
    this.events.onLevel(0)
  }

  private meter(): void {
    if (!this.current) return
    if (this.synthetic || !this.analyser) {
      // speechSynthesis output cannot be measured; animate a plausible speaking level.
      const t = performance.now() / 1000
      this.events.onLevel(0.45 + 0.25 * Math.sin(t * 9.1) * Math.sin(t * 3.7) + 0.1 * Math.random())
      return
    }
    const data = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    this.events.onLevel(levelFromRms(Math.sqrt(sum / data.length)))
  }

  private interrupt(turn: Turn): void {
    if (this.turn === turn) this.current?.stop()
    this.finish(turn, true)
  }

  private finish(turn: Turn, interrupted: boolean): void {
    if (this.turn === turn) this.turn = null
    turn.queue = []
    turn.wake?.()
    if (this.finished.some((f) => f.id === turn.id)) return
    this.finished.push({ id: turn.id, firstSeq: turn.firstSeq })
    if (this.finished.length > 50) this.finished.shift()
    this.events.onTurnDone(turn.id, interrupted)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
