// Voice engine state machine: wake word → command → submit, push-to-talk, follow-up window, barge-in while
// speaking, echo guard, phase / level reports. Browser specifics live behind EngineDeps (tested with fakes).
import { LIMITS } from '@shared/defaults'
import type { AssistantPhase, AssistantState, PublicSettings, SpeakChunk, VoicePhaseReport, WakeEngine } from '@shared/types'
import { hasWords, isEchoOf, isLikelyHallucination, isStopCommand, matchWake, type WakeMatch } from '@shared/wake'
import { encodeSpeechWav, SPEECH_SAMPLE_RATE } from './audio'
import type { EngineDeps, TtsConfig } from './engine-types'
import { InferenceGate } from './inference-gate'
import { LevelReporter } from './level-reporter'
import { errorText } from './log'
import type { Segment, SegmenterOptions } from './segmenter'

/** Local wake detection looks at this much audio after the speech onset (the encoder cost is fixed anyway). */
export const WAKE_WINDOW_MS = 3000
/** Enough tokens for the wake word plus the first words after it. */
export const WAKE_MAX_TOKENS = 24
const COMMAND_MAX_TOKENS = 200
/** Segments starting this soon after our own audio get the echo guard. */
const ECHO_WINDOW_MS = 2500
const MIC_LEVEL_FLOOR = 0.12
const ERROR_SHOW_MS = 4000
const THINKING_HOLD_MS = 15_000
const MIN_RESUMED_WINDOW_MS = 3000
const SESSION_MAX_IDLE_MS = 180_000
const MODEL_RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000]

const WAKE_PROFILE: Partial<SegmenterOptions> = { redemptionMs: 900, maxSegmentMs: LIMITS.maxWakeSegmentSeconds * 1000 }
const COMMAND_PROFILE: Partial<SegmenterOptions> = { redemptionMs: 1300, maxSegmentMs: LIMITS.maxCommandSeconds * 1000 }
// Our own speech leaks into the microphone despite echo cancellation; only clear speech counts while it plays.
const NORMAL_THRESHOLDS: Partial<SegmenterOptions> = { positiveThreshold: 0.5, negativeThreshold: 0.35 }
const PLAYBACK_THRESHOLDS: Partial<SegmenterOptions> = { positiveThreshold: 0.7, negativeThreshold: 0.5 }

type WindowReason = 'wake' | 'ptt' | 'followup'

type Mode =
  | { kind: 'idle' }
  | { kind: 'ack' }
  | { kind: 'command'; reason: WindowReason; until: number }
  | { kind: 'transcribing' }

type Role = 'wake' | 'command' | 'ignore'

interface SegState {
  id: number
  role: Role
  /** Started while (or right after) our own audio played. */
  nearPlayback: boolean
  /** The command window this segment belongs to (for resuming after unusable speech). */
  window: { reason: WindowReason; until: number } | null
  check: 'none' | 'pending' | 'matched' | 'rejected'
  checkResult?: Promise<WakeCheck | null>
  match?: WakeMatch
}

interface WakeCheck {
  text: string
  match: WakeMatch
  /** Sample index where the checked audio ended. */
  windowEnd: number
  echo: boolean
}

export function ttsConfigFrom(s: PublicSettings): TtsConfig {
  const voiceKey =
    s.ttsProvider === 'elevenlabs'
      ? ['eleven', s.elevenVoiceId, s.elevenModel, s.elevenStability, s.elevenSimilarity, s.ttsSpeed].join('|')
      : ['openai', s.ttsModel, s.ttsVoice, s.ttsSpeed, s.ttsInstructions].join('|')
  return { provider: s.ttsProvider, systemVoiceName: s.systemVoiceName, speed: s.ttsSpeed, voiceKey }
}

export class VoiceEngine {
  private settings: PublicSettings | null = null
  private override: WakeEngine | null = null
  private engine: WakeEngine = 'off'
  private mode: Mode = { kind: 'idle' }
  private modeSeq = 0
  private modeTimer: ReturnType<typeof setTimeout> | null = null
  private segs = new Map<number, SegState>()
  private readonly gate = new InferenceGate()
  private readonly levels: LevelReporter
  private micLive = false
  private micError: string | null = null
  private modelError: string | null = null
  private modelLoading = false
  private modelAttempt = 0
  private modelRetryTimer: ReturnType<typeof setTimeout> | null = null
  private cloudError: string | null = null
  private voiceTurns: string[] = []
  private speakingTurn: string | null = null
  private mainPhase: AssistantPhase = 'idle'
  private awaitingSince = 0
  private awaitingText = ''
  private lastPlaybackEnd = 0
  private errorMessage = ''
  private errorUntil = 0
  private errorTimer: ReturnType<typeof setTimeout> | null = null
  private session = false
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  private ackSeq = 0
  private lastReport = ''
  private holdReports = false
  private disposed = false

  constructor(private readonly deps: EngineDeps) {
    this.levels = new LevelReporter((level) => deps.bridge.reportLevel(level))
  }

  // --- inputs from main -----------------------------------------------------------------------------------

  applySettings(s: PublicSettings): void {
    this.settings = s
    this.override = null
    this.deps.tts.configure(ttsConfigFrom(s))
    if (s.acknowledge !== 'chime') this.deps.tts.prefetchPhrase(this.ackText())
    this.reconcile()
  }

  /** Tray / UI toggle; the persisted setting follows through settingsChanged. */
  setWakeEnabled(enabled: boolean): void {
    if (!this.settings) return
    const configured = this.settings.wakeEngine
    this.override = enabled ? (configured === 'off' ? 'local' : configured) : 'off'
    this.reconcile()
  }

  /** Push-to-talk: the next speech is a command, no wake word needed. */
  listen(): void {
    const s = this.settings
    if (!s || this.disposed) return
    this.bargeIn()
    this.beginSession()
    void this.startPushToTalk(s)
  }

  speak(chunk: SpeakChunk): void {
    this.deps.tts.enqueue(chunk)
  }

  stopSpeaking(): void {
    this.deps.tts.stop()
  }

  onAssistantState(state: AssistantState): void {
    this.mainPhase = state.phase
    if (state.phase !== 'thinking' && state.phase !== 'transcribing') this.awaitingSince = 0
    if (state.phase === 'idle' || state.phase === 'error') this.endSessionIfIdle()
  }

  // --- inputs from capture --------------------------------------------------------------------------------

  onMicStream(): void {
    this.micLive = true
    this.micError = null
    this.report()
  }

  onMicLost(): void {
    this.micLive = false
    this.deps.capture.configure(WAKE_PROFILE)
    this.report()
  }

  onMicError(message: string | null): void {
    this.micError = message
    if (message) this.micLive = false
    this.report()
  }

  onMicLevel(level: number): void {
    if (this.deps.tts.playing) return
    this.levels.push(level < MIC_LEVEL_FLOOR ? 0 : level)
  }

  onSpeechStart(id: number): void {
    const role = this.roleForNewSegment()
    const window = this.mode.kind === 'command' ? { reason: this.mode.reason, until: this.mode.until } : null
    this.segs.set(id, { id, role, nearPlayback: this.nearPlayback(), window, check: 'none' })
    if (this.segs.size > 16) this.segs.delete(this.segs.keys().next().value as number)
    if (role === 'command') {
      this.armSpeechGuard() // the user is talking: the window no longer expires
      this.deps.capture.configure(COMMAND_PROFILE)
    } else {
      this.deps.capture.configure(WAKE_PROFILE)
    }
  }

  onProgress(id: number, speechMs: number): void {
    const seg = this.segs.get(id)
    if (!seg || seg.role !== 'wake' || seg.check !== 'none' || this.engine !== 'local' || speechMs < WAKE_WINDOW_MS) {
      return
    }
    const snap = this.deps.capture.snapshot()
    if (!snap || snap.id !== id) return
    seg.check = 'pending'
    seg.checkResult = this.localWakeCheck(snap, seg)
    void seg.checkResult.then((res) => this.onEarlyCheck(seg, res))
  }

  onMisfire(id: number): void {
    this.segs.delete(id)
  }

  async onSpeechEnd(segment: Segment): Promise<void> {
    const seg = this.segs.get(segment.id) ?? {
      id: segment.id,
      role: this.roleForNewSegment(),
      nearPlayback: this.nearPlayback(),
      window: null,
      check: 'none' as const
    }
    this.deps.capture.configure(WAKE_PROFILE)
    try {
      if (seg.role === 'command') await this.handleCommandSegment(segment, seg)
      else if (seg.role === 'wake' && this.engine === 'cloud') await this.handleCloudWake(segment, seg)
      else if (seg.role === 'wake' && this.engine === 'local') await this.handleLocalWake(segment, seg)
    } catch (err) {
      this.fail(`Ошибка голосового движка: ${errorText(err)}`)
    } finally {
      this.segs.delete(segment.id)
    }
  }

  // --- inputs from speech output --------------------------------------------------------------------------

  onTurnStart(turnId: string): void {
    this.speakingTurn = turnId
    this.awaitingSince = 0
    if (this.mode.kind === 'command' && this.mode.reason === 'followup' && !this.commandSegmentActive()) {
      this.closeWindow()
    }
    this.applyThresholds()
    this.report()
  }

  onTurnDone(turnId: string, interrupted: boolean): void {
    this.deps.bridge.reportSpeechDone({ turnId, interrupted })
    if (this.speakingTurn === turnId) this.speakingTurn = null
    this.lastPlaybackEnd = Date.now()
    this.applyThresholds()
    const s = this.settings
    const followUp = !interrupted && !!s && s.followUpSeconds > 0 && this.voiceTurns.includes(turnId)
    if (followUp && this.mode.kind === 'idle' && s) {
      this.beginSession()
      this.openWindow('followup', s.followUpSeconds)
      return
    }
    this.report()
    this.endSessionIfIdle()
  }

  onOutputLevel(level: number): void {
    this.levels.push(level)
  }

  dispose(): void {
    this.disposed = true
    this.clearModeTimer()
    if (this.errorTimer) clearTimeout(this.errorTimer)
    if (this.modelRetryTimer) clearTimeout(this.modelRetryTimer)
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.gate.clear()
    this.levels.dispose()
    this.deps.tts.stop()
    this.deps.local.dispose()
    void this.deps.capture.stop()
  }

  // --- configuration --------------------------------------------------------------------------------------

  private reconcile(): void {
    const s = this.settings
    if (!s || this.disposed) return
    const engine = this.override ?? s.wakeEngine
    const changed = engine !== this.engine
    this.engine = engine
    if (engine === 'local') this.ensureModel()
    else if (changed) this.unloadModel()
    this.cloudError = engine === 'cloud' && !s.hasApiKey ? 'Для облачной активации нужен API-ключ OpenAI.' : null
    if (changed) this.deps.log.info(`Wake engine: ${engine}`)
    this.syncCapture()
    this.report()
  }

  private syncCapture(): void {
    const s = this.settings
    if (!s) return
    if (this.engine !== 'off' || this.session) {
      this.deps.capture.start(s.micDeviceId).catch((err: unknown) => {
        this.deps.log.error(`Capture start failed: ${errorText(err)}`)
        this.micError = `Не удалось запустить захват звука: ${errorText(err)}`
        this.report()
      })
    } else if (this.deps.capture.running) {
      this.micLive = false
      void this.deps.capture.stop()
    }
  }

  private ensureModel(): void {
    if (this.deps.local.ready || this.modelLoading || this.modelRetryTimer) return
    this.modelLoading = true
    const started = Date.now()
    this.deps.local
      .load()
      .then(() => {
        this.modelError = null
        this.modelAttempt = 0
        this.deps.log.info(`Local wake word model loaded in ${Date.now() - started} ms`)
      })
      .catch((err: unknown) => {
        this.modelError = `Не удалось загрузить локальную модель распознавания: ${errorText(err)}`
        this.deps.log.error(this.modelError)
        const delay = MODEL_RETRY_MS[Math.min(this.modelAttempt++, MODEL_RETRY_MS.length - 1)]
        this.modelRetryTimer = setTimeout(() => {
          this.modelRetryTimer = null
          if (this.engine === 'local' && !this.disposed) this.ensureModel()
        }, delay)
      })
      .finally(() => {
        this.modelLoading = false
        if (this.engine !== 'local') this.deps.local.dispose()
        this.report()
      })
  }

  private unloadModel(): void {
    if (this.modelRetryTimer) clearTimeout(this.modelRetryTimer)
    this.modelRetryTimer = null
    this.modelError = null
    this.modelAttempt = 0
    this.gate.clear()
    if (!this.modelLoading) this.deps.local.dispose()
  }

  // --- wake word ------------------------------------------------------------------------------------------

  private roleForNewSegment(): Role {
    if (this.mode.kind === 'command' || this.mode.kind === 'ack') return 'command'
    return this.engine === 'off' ? 'ignore' : 'wake'
  }

  private languages(): string[] {
    const preferred = (this.settings?.sttLanguage || 'ru').toLowerCase().slice(0, 2)
    return [...new Set([preferred, 'en'])]
  }

  private async localWakeCheck(segment: Segment, seg: SegState): Promise<WakeCheck | null> {
    const windowEnd = Math.min(segment.audio.length, segment.speechStart + (WAKE_WINDOW_MS * SPEECH_SAMPLE_RATE) / 1000)
    const audio = segment.audio.subarray(0, windowEnd)
    let out: { text: string; language: string | null; ms?: number } | null
    try {
      out = await this.gate.run(() => this.deps.local.transcribe(audio, this.languages(), WAKE_MAX_TOKENS))
    } catch (err) {
      this.deps.log.warn(`Local wake check failed: ${errorText(err)}`)
      return null
    }
    const s = this.settings
    if (!out || !s) return null
    const match = matchWake(out.text, s.wakePhrases, s.wakeSensitivity)
    const echo = match.matched && this.isEcho(out.text, seg)
    if (match.matched) {
      const timing = out.ms === undefined ? '' : `, ${out.ms} ms, ${out.language ?? '?'}`
      this.deps.log.info(`Wake word "${match.matchedWord}" heard${timing}${echo ? ' — our own speech, ignored' : ''}`)
    }
    return { text: out.text, match, windowEnd, echo }
  }

  private onEarlyCheck(seg: SegState, res: WakeCheck | null): void {
    if (seg.check !== 'pending' || this.disposed) return
    if (!res || !res.match.matched || res.echo) {
      seg.check = 'rejected'
      return
    }
    seg.check = 'matched'
    seg.match = res.match
    if (this.deps.capture.segmentId !== seg.id) return // already ended: onSpeechEnd continues
    // Wake word said and the user keeps talking: the rest of this segment is the command.
    seg.role = 'command'
    this.deps.capture.configure(COMMAND_PROFILE)
    this.bargeIn()
    this.setMode({ kind: 'command', reason: 'wake', until: Date.now() + LIMITS.maxCommandSeconds * 1000 })
    this.armSpeechGuard()
  }

  private async handleLocalWake(segment: Segment, seg: SegState): Promise<void> {
    if (seg.check === 'rejected') return
    const res = seg.check === 'none' ? await this.localWakeCheck(segment, seg) : await seg.checkResult
    if (!res || !res.match.matched || res.echo) return
    seg.match = res.match
    const moreSpeech = segment.speechEnd > res.windowEnd + 0.3 * SPEECH_SAMPLE_RATE
    this.bargeIn()
    if (moreSpeech || hasWords(res.match.remainder)) await this.handleCommandSegment(segment, seg)
    else await this.acknowledge()
  }

  private async handleCloudWake(segment: Segment, seg: SegState): Promise<void> {
    const s = this.settings
    if (!s || !s.hasApiKey) return
    let text: string
    try {
      text = await this.deps.bridge.transcribe(encodeSpeechWav(segment.audio))
      if (this.cloudError) {
        this.cloudError = null
        this.report()
      }
    } catch (err) {
      const message = `Облачное распознавание недоступно: ${errorText(err)}`
      this.deps.log.warn(message)
      if (this.cloudError !== message) {
        this.cloudError = message
        this.report()
      }
      return
    }
    const match = matchWake(text, s.wakePhrases, s.wakeSensitivity)
    if (!match.matched || this.isEcho(text, seg)) return
    this.deps.log.info(`Wake word "${match.matchedWord}" heard (cloud)`)
    this.bargeIn()
    const command = this.cleanCommand(match.remainder)
    if (command) await this.dispatch(command)
    else await this.acknowledge()
  }

  private isEcho(text: string, seg: SegState): boolean {
    if (!seg.nearPlayback && !this.nearPlayback()) return false
    return isEchoOf(text, this.deps.tts.recentlySpoken(ECHO_WINDOW_MS + LIMITS.maxCommandSeconds * 1000))
  }

  private nearPlayback(): boolean {
    return this.deps.tts.playing || Date.now() - this.lastPlaybackEnd < ECHO_WINDOW_MS
  }

  /** Stops our speech when the user addresses Jarvis while it talks. */
  private bargeIn(): void {
    if (!this.deps.tts.activeTurn && !this.deps.tts.playing) return
    this.deps.log.info('Barge-in: stopping speech')
    // The caller switches mode right after; an intermediate "idle" would make the overlay start hiding.
    this.holdReports = true
    try {
      this.deps.tts.stop()
    } finally {
      this.holdReports = false
    }
  }

  private async acknowledge(): Promise<void> {
    const s = this.settings
    if (!s) return
    const seq = ++this.ackSeq
    this.setMode({ kind: 'ack' })
    try {
      if (s.acknowledge !== 'voice') await this.deps.chime('listen')
      if (seq === this.ackSeq && this.mode.kind === 'ack' && s.acknowledge !== 'chime') {
        await this.deps.tts.speakPhrase(this.ackText())
        this.lastPlaybackEnd = Date.now()
      }
    } catch (err) {
      this.deps.log.warn(`Acknowledgement failed: ${errorText(err)}`)
    }
    if (seq === this.ackSeq && this.mode.kind === 'ack') this.openWindow('wake', s.commandTimeoutSeconds)
  }

  private ackText(): string {
    const title = this.settings?.userTitle.trim()
    return title ? `Да, ${title}?` : 'Да?'
  }

  // --- commands -------------------------------------------------------------------------------------------

  private async startPushToTalk(s: PublicSettings): Promise<void> {
    const id = this.deps.capture.segmentId
    const seg = id ? this.segs.get(id) : undefined
    if (seg && seg.role !== 'command') {
      // Speech already in progress when the hotkey was pressed belongs to the command.
      seg.role = 'command'
      seg.check = 'rejected'
      this.deps.capture.configure(COMMAND_PROFILE)
    }
    if (!this.deps.capture.running) {
      try {
        await this.deps.capture.start(s.micDeviceId)
      } catch (err) {
        this.fail(`Не удалось включить микрофон: ${errorText(err)}`)
        this.endSessionIfIdle()
        return
      }
    }
    this.openWindow('ptt', s.commandTimeoutSeconds)
    if (seg && seg.role === 'command' && this.deps.capture.segmentId === seg.id) this.armSpeechGuard()
    try {
      await this.deps.chime('listen')
    } catch (err) {
      this.deps.log.warn(`Chime failed: ${errorText(err)}`)
    }
  }

  private async handleCommandSegment(segment: Segment, seg: SegState): Promise<void> {
    this.setMode({ kind: 'transcribing' })
    const seq = this.modeSeq
    let text: string
    try {
      text = await this.transcribeCommand(segment)
    } catch (err) {
      if (seq === this.modeSeq) this.fail(`Не удалось распознать команду: ${errorText(err)}`)
      return
    }
    if (seg.nearPlayback && this.isEcho(text, seg)) {
      this.deps.log.info('Ignoring our own speech picked up as a command')
      if (seq === this.modeSeq) this.resume(seg)
      return
    }
    const command = this.extractCommand(text, seg)
    if (!command) {
      if (seq !== this.modeSeq) return
      // "Джарвис" alone (the cloud transcript had nothing else): ask what to do.
      if (seg.match && !seg.window) await this.acknowledge()
      else this.resume(seg)
      return
    }
    await this.dispatch(command, seq !== this.modeSeq)
  }

  private async transcribeCommand(segment: Segment): Promise<string> {
    let cloudErr: unknown = null
    try {
      return await this.deps.bridge.transcribe(encodeSpeechWav(segment.audio))
    } catch (err) {
      cloudErr = err
      this.deps.log.warn(`Cloud transcription failed: ${errorText(err)}`)
    }
    if (this.deps.local.ready) {
      const out = await this.gate.run(() => this.deps.local.transcribe(segment.audio, this.languages(), COMMAND_MAX_TOKENS))
      if (out) return out.text
    }
    throw cloudErr instanceof Error ? cloudErr : new Error(errorText(cloudErr))
  }

  private extractCommand(text: string, seg: SegState): string {
    const s = this.settings
    if (!s) return ''
    let command = text.trim()
    const m = matchWake(command, s.wakePhrases, s.wakeSensitivity)
    if (m.matched) command = m.remainder
    else if (seg.match) {
      // The wake word was heard locally; the cloud transcript may spell it more loosely.
      const loose = matchWake(command, s.wakePhrases, 'high')
      if (loose.matched) command = loose.remainder
    }
    return this.cleanCommand(command)
  }

  private cleanCommand(text: string): string {
    const command = text.trim()
    return hasWords(command) && !isLikelyHallucination(command) ? command : ''
  }

  private async dispatch(command: string, keepMode = false): Promise<void> {
    if (isStopCommand(command)) {
      this.deps.log.info('Stop command')
      this.deps.tts.stop()
      this.deps.bridge.cancelTurn().catch((err: unknown) => this.deps.log.warn(`Cancel failed: ${errorText(err)}`))
      if (!keepMode) this.setMode({ kind: 'idle' })
      void this.deps.chime('cancel').catch(() => undefined)
      this.endSessionIfIdle()
      return
    }
    this.awaitingSince = Date.now()
    this.awaitingText = command
    if (!keepMode) this.setMode({ kind: 'idle' })
    else this.report()
    try {
      const res = await this.deps.bridge.submit(command)
      this.voiceTurns.push(res.turnId)
      if (this.voiceTurns.length > 20) this.voiceTurns.shift()
      this.deps.log.info(`Voice command sent (turn ${res.turnId}, ${command.length} chars)`)
    } catch (err) {
      this.awaitingSince = 0
      this.fail(`Не удалось отправить команду: ${errorText(err)}`)
      this.endSessionIfIdle()
    }
  }

  /** Unusable speech inside a command window: keep listening for the rest of the window. */
  private resume(seg: SegState): void {
    const remaining = seg.window ? seg.window.until - Date.now() : 0
    if (seg.window && remaining > 0) {
      this.openWindow(seg.window.reason, Math.max(remaining, MIN_RESUMED_WINDOW_MS) / 1000)
    } else {
      this.setMode({ kind: 'idle' })
      this.endSessionIfIdle()
    }
  }

  // --- modes, timers, sessions ----------------------------------------------------------------------------

  private setMode(mode: Mode): void {
    if (mode.kind !== 'command') this.clearModeTimer()
    if (mode.kind !== 'ack') this.ackSeq++
    this.mode = mode
    this.modeSeq++
    this.report()
  }

  private openWindow(reason: WindowReason, seconds: number): void {
    const ms = Math.max(1000, seconds * 1000)
    this.setMode({ kind: 'command', reason, until: Date.now() + ms })
    this.clearModeTimer()
    this.modeTimer = setTimeout(() => this.onWindowExpired(), ms)
  }

  private onWindowExpired(): void {
    this.modeTimer = null
    if (this.mode.kind !== 'command' || this.commandSegmentActive()) return
    this.closeWindow()
  }

  private closeWindow(): void {
    this.setMode({ kind: 'idle' })
    this.endSessionIfIdle()
  }

  private commandSegmentActive(): boolean {
    const id = this.deps.capture.segmentId
    return id !== 0 && this.segs.get(id)?.role === 'command'
  }

  /**
   * While a command is being spoken the window must not expire, but a segment that never ends (microphone
   * lost mid-sentence) must not leave us listening forever either.
   */
  private armSpeechGuard(): void {
    this.clearModeTimer()
    this.modeTimer = setTimeout(() => this.onWindowExpired(), LIMITS.maxCommandSeconds * 1000 + 5000)
  }

  private clearModeTimer(): void {
    if (this.modeTimer) clearTimeout(this.modeTimer)
    this.modeTimer = null
  }

  /** With the wake engine off, the microphone runs only during a push-to-talk conversation. */
  private beginSession(): void {
    this.session = true
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null
      this.session = false
      this.syncCapture()
    }, SESSION_MAX_IDLE_MS)
    this.syncCapture()
  }

  private endSessionIfIdle(): void {
    if (!this.session || this.mode.kind !== 'idle' || this.deps.tts.activeTurn || this.speakingTurn) return
    if (this.awaitingSince || this.mainPhase === 'thinking' || this.mainPhase === 'acting') return
    this.session = false
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.sessionTimer = null
    this.syncCapture()
  }

  private applyThresholds(): void {
    const playing = this.deps.tts.playing || this.speakingTurn !== null
    this.deps.capture.configure(playing ? PLAYBACK_THRESHOLDS : NORMAL_THRESHOLDS)
  }

  // --- reports --------------------------------------------------------------------------------------------

  private fail(message: string): void {
    this.deps.log.error(message)
    this.errorMessage = message
    this.errorUntil = Date.now() + ERROR_SHOW_MS
    this.setMode({ kind: 'idle' })
    if (this.errorTimer) clearTimeout(this.errorTimer)
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null
      this.report()
    }, ERROR_SHOW_MS + 10)
  }

  private phase(): AssistantPhase {
    switch (this.mode.kind) {
      case 'ack':
        return 'wake'
      case 'command':
        return 'listening'
      case 'transcribing':
        return 'transcribing'
    }
    if (this.speakingTurn || this.deps.tts.playing) return 'speaking'
    const now = Date.now()
    if (this.awaitingSince && now - this.awaitingSince < THINKING_HOLD_MS) return 'thinking'
    if (now < this.errorUntil) return 'error'
    // Never report idle over the assistant's own progress.
    if (this.mainPhase === 'thinking' || this.mainPhase === 'acting') return this.mainPhase
    return 'idle'
  }

  private wakeActive(): boolean {
    if (this.engine === 'off' || !this.micLive) return false
    return this.engine === 'cloud' ? !this.cloudError : this.deps.local.ready
  }

  private engineError(): string | null {
    if (this.micError) return this.micError
    if (this.engine === 'local') return this.modelError
    if (this.engine === 'cloud') return this.cloudError
    return null
  }

  private report(): void {
    if (this.disposed || this.holdReports) return
    const phase = this.phase()
    const report: VoicePhaseReport = { phase, wakeActive: this.wakeActive(), engineError: this.engineError() }
    if (phase === 'error') report.error = this.errorMessage
    if (phase === 'thinking' && this.awaitingSince) report.transcript = this.awaitingText
    const key = JSON.stringify(report)
    if (key === this.lastReport) return
    this.lastReport = key
    try {
      this.deps.bridge.reportPhase(report)
    } catch (err) {
      this.deps.log.warn(`reportPhase failed: ${errorText(err)}`)
    }
  }
}
