// Voice window entry: wires the engine to window.jarvis (settings, speak/listen events, reports).
import type { JarvisApi } from '@shared/ipc'
import type { PublicSettings } from '@shared/types'
import { Capture } from './capture'
import { playChime } from './chime'
import { DebugPanel } from './debug-panel'
import { VoiceEngine } from './engine'
import { createLogger, errorText, type LogLevel } from './log'
import { TtsQueue } from './tts'
import { WhisperClient } from './whisper-client'

const panel = new DebugPanel(document.getElementById('status'))

async function loadSettings(api: JarvisApi, log: ReturnType<typeof createLogger>): Promise<PublicSettings> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.settings.get()
    } catch (err) {
      const delay = Math.min(10_000, 500 * 2 ** attempt)
      log.warn(`settings.get failed (${errorText(err)}), retrying in ${delay} ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

async function boot(api: JarvisApi): Promise<void> {
  const log = createLogger((level: LogLevel, message: string) => {
    panel.log(level, message)
    api.voice.log(level, message)
  })

  window.addEventListener('error', (ev) => log.error(`Uncaught: ${ev.message} (${ev.filename}:${ev.lineno})`))
  window.addEventListener('unhandledrejection', (ev) => {
    ev.preventDefault()
    log.error(`Unhandled rejection: ${errorText(ev.reason)}`)
  })

  // The engine is created below; callbacks only fire after start-up.
  let engine: VoiceEngine | null = null
  const tts = new TtsQueue(
    (text) => api.speech.synthesize(text),
    {
      onTurnStart: (id) => engine?.onTurnStart(id),
      onTurnDone: (id, interrupted) => engine?.onTurnDone(id, interrupted),
      onLevel: (level) => engine?.onOutputLevel(level)
    },
    log
  )
  const capture = new Capture(log, {
    onSpeechStart: (id) => engine?.onSpeechStart(id),
    onProgress: (id, ms) => engine?.onProgress(id, ms),
    onSpeechEnd: (segment) => void engine?.onSpeechEnd(segment),
    onMisfire: (id) => engine?.onMisfire(id),
    onLevel: (level) => engine?.onMicLevel(level),
    onMicStream: () => engine?.onMicStream(),
    onMicLost: () => engine?.onMicLost(),
    onMicError: (message) => engine?.onMicError(message)
  })
  const local = new WhisperClient(log)
  engine = new VoiceEngine({
    bridge: {
      submit: (text) => api.voice.submit(text),
      cancelTurn: () => api.chats.cancel(),
      transcribe: (wav) => api.speech.transcribe(wav, 'audio/wav'),
      reportPhase: (report) => {
        panel.phase(report)
        api.voice.reportPhase(report)
      },
      reportLevel: (level) => api.voice.reportLevel(level),
      reportSpeechDone: (report) => api.voice.reportSpeechDone(report)
    },
    capture,
    local,
    tts,
    chime: (kind) => playChime(tts.audioContext(), kind),
    log
  })
  const e = engine
  const guard =
    <A extends unknown[]>(name: string, fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args)
      } catch (err) {
        log.error(`${name} failed: ${errorText(err)}`)
      }
    }

  let changedEarly = false
  api.settings.onChanged(
    guard('settings', (s: PublicSettings) => {
      changedEarly = true
      e.applySettings(s)
    })
  )
  api.voice.onSpeak(guard('speak', (chunk) => e.speak(chunk)))
  api.voice.onStopSpeaking(guard('stop', () => e.stopSpeaking()))
  api.voice.onListen(guard('listen', () => e.listen()))
  api.voice.onSetWake(guard('set-wake', (enabled: boolean) => e.setWakeEnabled(enabled)))
  api.assistant.onState(guard('state', (state) => e.onAssistantState(state)))

  const initial = await loadSettings(api, log)
  // A change broadcast while get() was in flight is newer than its result.
  if (!changedEarly) e.applySettings(initial)
  api.assistant
    .getState()
    .then((state) => e.onAssistantState(state))
    .catch((err: unknown) => log.warn(`assistant.getState failed: ${errorText(err)}`))
  log.info(`Voice engine started (cross-origin isolated: ${String(globalThis.crossOriginIsolated)})`)

  window.addEventListener('beforeunload', () => {
    e.dispose()
    void capture.destroy()
    tts.dispose()
  })
}

const api = (window as Window & { jarvis?: JarvisApi }).jarvis
if (!api?.voice) {
  panel.log('error', 'window.jarvis недоступен: голосовой движок не может работать без preload-скрипта')
} else {
  boot(api).catch((err: unknown) => {
    const message = `Voice engine failed to start: ${errorText(err)}`
    panel.log('error', message)
    try {
      api.voice.log('error', message)
      api.voice.reportPhase({ phase: 'idle', wakeActive: false, engineError: message })
    } catch {
      // nothing else we can do
    }
  })
}
