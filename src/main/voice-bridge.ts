// Wiring between the hidden voice-engine window and the rest of the app (electron-free).
// voice window → main: submit (→ assistant), phase / level / speech-done reports (→ bus), logs.
// bus → voice window: speak chunks, stop-speaking, listen (also shows the overlay).
import { IPC_EVENT } from '@shared/ipc'
import type { SendChatResult } from '@shared/ipc'
import type { AssistantState } from '@shared/types'
import type { AppBus } from './bus'
import { createLogger } from './log'
import type { AssistantService, WindowService } from './services'
import { asLevel, asSpeechDone, asText, asVoicePhaseReport, IpcInputError } from './ipc/validate'

const log = createLogger('voice-bridge')
const voiceLog = createLogger('voice')

export interface VoiceBridgeDeps {
  bus: AppBus
  windows: Pick<WindowService, 'sendToVoice' | 'showOverlay'>
  assistant: Pick<AssistantService, 'send' | 'currentTurn'>
}

export interface VoiceBridge {
  submit(text: unknown): Promise<SendChatResult>
  reportPhase(report: unknown): void
  reportLevel(level: unknown): void
  speechDone(report: unknown): void
  log(level: unknown, message: unknown): void
  dispose(): void
}

/** Phases that start a new spoken interaction (stale tool titles / errors are cleared). */
const INTERACTION_START = new Set(['wake', 'listening', 'transcribing'])

export function createVoiceBridge(deps: VoiceBridgeDeps): VoiceBridge {
  const { bus, windows } = deps
  /** The current 'error' phase was set by the assistant (a failed turn), not by the voice engine. */
  let assistantError = false
  let ownPatch = false

  const offs = [
    bus.on('assistant-state', (state) => {
      if (!ownPatch) assistantError = state.phase === 'error'
    }),
    bus.on('speak', (chunk) => windows.sendToVoice(IPC_EVENT.voiceSpeak, chunk)),
    bus.on('stop-speaking', () => windows.sendToVoice(IPC_EVENT.voiceStopSpeaking)),
    bus.on('listen', () => {
      windows.showOverlay()
      windows.sendToVoice(IPC_EVENT.voiceListen)
    })
  ]

  return {
    async submit(raw) {
      const text = asText(raw, { allowEmpty: false }).trim()
      if (!text) throw new IpcInputError('Пустая команда.')
      return deps.assistant.send({ text, source: 'voice' })
    },

    reportPhase(raw) {
      const report = asVoicePhaseReport(raw)
      if (!report) {
        log.warn('invalid phase report ignored')
        return
      }
      const patch: Partial<AssistantState> = {}
      const current = bus.getState().phase
      // While the model is thinking / running tools the voice engine goes back to waiting for the
      // wake word; that must not make the HUD look idle.
      const turnBusy = (current === 'thinking' || current === 'acting') && deps.assistant.currentTurn() !== null
      // A failed turn shows 'error' until the assistant resets it; routine engine reports (model loaded,
      // follow-up window closed) must not hide it early.
      const showingTurnError = current === 'error' && assistantError
      if (!((turnBusy || showingTurnError) && report.phase === 'idle')) patch.phase = report.phase
      if (report.transcript !== undefined) patch.transcript = report.transcript
      if (report.phase === 'error') patch.error = report.error || 'Ошибка голосового движка.'
      else if (report.error) patch.error = report.error
      else if (INTERACTION_START.has(report.phase)) {
        patch.error = undefined
        patch.toolTitle = undefined
      }
      if (report.wakeActive !== undefined) patch.wakeActive = report.wakeActive
      if (report.engineError === null) patch.engineError = undefined
      else if (report.engineError !== undefined) patch.engineError = report.engineError
      if (!Object.keys(patch).length) return
      ownPatch = true
      try {
        bus.patchState(patch)
      } finally {
        ownPatch = false
      }
    },

    reportLevel(raw) {
      const level = asLevel(raw)
      if (level !== null) bus.emit('level', level)
    },

    speechDone(raw) {
      const report = asSpeechDone(raw)
      if (report) bus.emit('speech-done', report)
      else log.warn('invalid speech-done report ignored')
    },

    log(level, message) {
      const text = typeof message === 'string' ? message.slice(0, 4000) : String(message).slice(0, 4000)
      if (level === 'error') voiceLog.error(text)
      else if (level === 'warn') voiceLog.warn(text)
      else voiceLog.info(text)
    },

    dispose() {
      for (const off of offs) off()
    }
  }
}
