import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_EVENT } from '@shared/ipc'
import type { SpeechDoneReport } from '@shared/ipc'
import { AppBus } from '../../src/main/bus'
import { createWakeToggle } from '../../src/main/app/wake'
import { startBusForwarding } from '../../src/main/ipc/forward'
import { createAppStateStore } from '../../src/main/store/app-state'
import { createSettingsStore } from '../../src/main/store/settings'
import { createVoiceBridge } from '../../src/main/voice-bridge'

function setup(turn: { chatId: string; turnId: string } | null = null) {
  const bus = new AppBus()
  const windows = { sendToVoice: vi.fn(), showOverlay: vi.fn() }
  const assistant = {
    send: vi.fn(async () => ({ chatId: 'c1', turnId: 't1' })),
    currentTurn: vi.fn(() => turn)
  }
  const bridge = createVoiceBridge({ bus, windows, assistant })
  return { bus, windows, assistant, bridge }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('voice bridge', () => {
  it('submits voice commands to the assistant', async () => {
    const { bridge, assistant } = setup()
    await expect(bridge.submit('  открой Telegram ')).resolves.toEqual({ chatId: 'c1', turnId: 't1' })
    expect(assistant.send).toHaveBeenCalledWith({ text: 'открой Telegram', source: 'voice' })
    await expect(bridge.submit('   ')).rejects.toThrow()
    await expect(bridge.submit(42)).rejects.toThrow()
  })

  it('forwards bus speak / stop / listen to the voice window', () => {
    const { bus, windows } = setup()
    const chunk = { turnId: 't', seq: 0, text: 'Да, сэр.', final: true }
    bus.emit('speak', chunk)
    bus.emit('stop-speaking')
    bus.emit('listen')
    expect(windows.sendToVoice.mock.calls).toEqual([
      [IPC_EVENT.voiceSpeak, chunk],
      [IPC_EVENT.voiceStopSpeaking],
      [IPC_EVENT.voiceListen]
    ])
    expect(windows.showOverlay).toHaveBeenCalledOnce()
  })

  it('maps phase reports onto the assistant state', () => {
    const { bus, bridge } = setup()
    bus.patchState({ toolTitle: 'Старое действие', error: 'старая ошибка' })
    bridge.reportPhase({ phase: 'listening', wakeActive: true, engineError: 'нет микрофона' })
    expect(bus.getState()).toMatchObject({ phase: 'listening', wakeActive: true, engineError: 'нет микрофона' })
    expect(bus.getState().toolTitle).toBeUndefined()
    expect(bus.getState().error).toBeUndefined()

    bridge.reportPhase({ phase: 'transcribing', transcript: 'открой телеграм', engineError: null })
    expect(bus.getState()).toMatchObject({ phase: 'transcribing', transcript: 'открой телеграм' })
    expect(bus.getState()).not.toHaveProperty('engineError')

    bridge.reportPhase({ phase: 'error' })
    expect(bus.getState()).toMatchObject({ phase: 'error', error: 'Ошибка голосового движка.' })

    const before = bus.getState()
    bridge.reportPhase({ phase: 'bogus' })
    expect(bus.getState()).toBe(before)
  })

  it('does not let the engine report idle over a running turn', () => {
    const { bus, bridge } = setup({ chatId: 'c', turnId: 't' })
    bus.patchState({ phase: 'thinking' })
    bridge.reportPhase({ phase: 'idle', wakeActive: true })
    expect(bus.getState()).toMatchObject({ phase: 'thinking', wakeActive: true })
    bridge.reportPhase({ phase: 'speaking' })
    expect(bus.getState().phase).toBe('speaking')
  })

  it("keeps a failed turn's error until the assistant resets it, but not the engine's own errors", () => {
    const { bus, bridge } = setup()
    bus.patchState({ phase: 'thinking' })
    bus.patchState({ phase: 'error', error: 'API-ключ недействителен' }) // assistant: turn failed
    bridge.reportPhase({ phase: 'idle', wakeActive: true }) // e.g. the wake model finished loading
    expect(bus.getState()).toMatchObject({ phase: 'error', error: 'API-ключ недействителен', wakeActive: true })
    bridge.reportPhase({ phase: 'speaking' }) // the spoken error message plays
    expect(bus.getState().phase).toBe('speaking')
    bridge.reportPhase({ phase: 'idle' })
    expect(bus.getState().phase).toBe('idle')

    bus.patchState({ phase: 'error', error: 'ещё ошибка' })
    bus.patchState({ phase: 'idle', error: undefined }) // assistant reset after errorResetMs
    bridge.reportPhase({ phase: 'listening' })
    expect(bus.getState().phase).toBe('listening')

    // The engine's own error ends with its own idle report.
    bridge.reportPhase({ phase: 'error', error: 'Не удалось распознать команду' })
    expect(bus.getState()).toMatchObject({ phase: 'error', error: 'Не удалось распознать команду' })
    bridge.reportPhase({ phase: 'idle' })
    expect(bus.getState().phase).toBe('idle')
  })

  it('validates level and speech-done reports', () => {
    const { bus, bridge } = setup()
    const levels: number[] = []
    const done: SpeechDoneReport[] = []
    bus.on('level', (l) => levels.push(l))
    bus.on('speech-done', (r) => done.push(r))
    bridge.reportLevel(0.4)
    bridge.reportLevel(7)
    bridge.reportLevel(Number.NaN)
    bridge.reportLevel('loud')
    bridge.speechDone({ turnId: 't1', interrupted: true })
    bridge.speechDone({ interrupted: true })
    expect(levels).toEqual([0.4, 1])
    expect(done).toEqual([{ turnId: 't1', interrupted: true }])
  })

  it('stops forwarding after dispose', () => {
    const { bus, windows, bridge } = setup()
    bridge.dispose()
    bus.emit('listen')
    expect(windows.sendToVoice).not.toHaveBeenCalled()
  })
})

describe('bus forwarding', () => {
  it('broadcasts chat and state events and throttles levels to overlay + main', () => {
    vi.useFakeTimers()
    try {
      const bus = new AppBus()
      const targets = { broadcast: vi.fn(), sendTo: vi.fn() }
      const stop = startBusForwarding(bus, targets)
      bus.emit('chat', { type: 'chats-changed' })
      const state = bus.patchState({ phase: 'thinking' })
      for (let i = 0; i < 10; i++) bus.emit('level', i / 10)
      vi.advanceTimersByTime(100)
      expect(targets.broadcast).toHaveBeenCalledWith(IPC_EVENT.chatEvent, { type: 'chats-changed' })
      expect(targets.broadcast).toHaveBeenCalledWith(IPC_EVENT.assistantState, state)
      const levelCalls = targets.sendTo.mock.calls.filter((c) => c[1] === IPC_EVENT.level)
      expect(new Set(levelCalls.map((c) => c[0]))).toEqual(new Set(['overlay', 'main']))
      expect(levelCalls.length).toBe(4) // leading + trailing, to two windows
      expect(levelCalls[levelCalls.length - 1][2]).toBe(0.9)
      stop()
      bus.emit('chat', { type: 'chats-changed' })
      expect(targets.broadcast).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('wake toggle', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-wake-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('remembers the last engine that was on', () => {
    const settings = createSettingsStore(dir)
    const appState = createAppStateStore(dir)
    const windows = { sendToVoice: vi.fn() }
    const wake = createWakeToggle({ settings, appState, windows })

    settings.update({ wakeEngine: 'cloud' })
    wake.setEnabled(false)
    expect(settings.get().wakeEngine).toBe('off')

    wake.setEnabled(true)
    expect(settings.get().wakeEngine).toBe('cloud')
    // Transitions travel with settingsChanged (the engine must not guess the engine from stale settings).
    expect(windows.sendToVoice).not.toHaveBeenCalled()

    // persisted across restarts
    wake.setEnabled(false)
    wake.dispose()
    const again = createWakeToggle({ settings, appState: createAppStateStore(dir), windows })
    again.setEnabled(true)
    expect(settings.get().wakeEngine).toBe('cloud')

    // already on: the engine is told again
    windows.sendToVoice.mockClear()
    again.setEnabled(true)
    expect(windows.sendToVoice).toHaveBeenCalledWith(IPC_EVENT.voiceSetWake, true)
  })

  it('defaults to the local engine', () => {
    const settings = createSettingsStore(dir)
    settings.update({ wakeEngine: 'off' })
    const wake = createWakeToggle({ settings, appState: createAppStateStore(dir), windows: { sendToVoice: vi.fn() } })
    wake.setEnabled(true)
    expect(settings.get().wakeEngine).toBe('local')
  })
})
