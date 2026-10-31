import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, IPC_EVENT, IPC_SEND } from '@shared/ipc'
import type { SpeakChunk } from '@shared/types'

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    listeners,
    ipcMain: {
      handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn),
      on: (ch: string, fn: (...args: unknown[]) => unknown) => listeners.set(ch, fn),
      removeHandler: (ch: string) => handlers.delete(ch),
      removeAllListeners: (ch: string) => listeners.delete(ch)
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {} },
    nativeImage: {
      createFromBuffer: () => ({ isEmpty: () => true }),
      createEmpty: () => ({ isEmpty: () => true })
    }
  }
})

vi.mock('electron', () => electron)
vi.mock('../../src/main/tools', () => ({
  captureScreen: async () => ({ id: 's1', url: 'jarvis-media://image/s1', kind: 'screenshot' })
}))

import { AppBus } from '../../src/main/bus'
import { registerIpcHandlers } from '../../src/main/ipc/handlers'
import { createChatStore } from '../../src/main/store/chats'
import { createMediaStore } from '../../src/main/store/media'
import { createSecretStore } from '../../src/main/store/secrets'
import { createSettingsStore } from '../../src/main/store/settings'
import { createVoiceBridge } from '../../src/main/voice-bridge'

const trusted = { senderFrame: { url: 'app://jarvis/index.html?window=main' } }
const untrusted = { senderFrame: { url: 'https://evil.example.com/' } }

let dir: string

function setup() {
  const settings = createSettingsStore(dir)
  const secrets = createSecretStore(dir, {
    cipher: { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }
  })
  const bus = new AppBus()
  const media = createMediaStore(join(dir, 'media'))
  const chats = createChatStore(join(dir, 'chats'), { onEvent: (ev) => bus.emit('chat', ev) })
  const windows = {
    broadcast: vi.fn(),
    sendTo: vi.fn(),
    sendToVoice: vi.fn(),
    showMain: vi.fn(),
    hideOverlay: vi.fn(),
    showOverlay: vi.fn(),
    getMainWindow: () => null
  }
  const ai = {
    models: {
      list: vi.fn(async () => {
        throw new Error('Не задан API-ключ OpenAI.')
      }),
      resolve: () => 'gpt-5.6-terra',
      resolvedAll: () => ({ luna: 'gpt-6-luna', terra: 'gpt-6-terra', sol: 'gpt-6-sol' }),
      refresh: vi.fn(async () => {})
    },
    speech: {
      transcribe: vi.fn(async () => 'привет'),
      synthesize: vi.fn(async () => ({ data: Buffer.from([1, 2, 3]), mime: 'audio/mpeg' })),
      listElevenLabsVoices: vi.fn(async () => {
        throw new Error('Не задан ключ ElevenLabs.')
      })
    },
    assistant: {
      send: vi.fn(async () => ({ chatId: 'c1', turnId: 't1' })),
      cancel: vi.fn(),
      currentTurn: vi.fn(() => null),
      testConnection: vi.fn(async () => ({ ok: true, message: 'Подключение работает. Доступно моделей: 3' }))
    }
  }
  const voice = createVoiceBridge({ bus, windows, assistant: ai.assistant })
  const permissions = {
    status: () => ({ microphone: 'granted', screen: 'granted', accessibility: 'granted' }) as const,
    request: vi.fn(async () => ({ microphone: 'granted', screen: 'granted', accessibility: 'granted' }) as const),
    openSettings: vi.fn(async () => {}),
    ensureMicrophone: async () => {}
  }
  const setWakeEnabled = vi.fn()
  const listen = vi.fn()
  const ipc = registerIpcHandlers({
    settings,
    secrets,
    chats,
    media,
    windows: windows as never,
    bus,
    ai: ai as never,
    toolHost: {} as never,
    voice,
    permissions,
    platform: 'darwin',
    appVersion: '1.2.3',
    origins: ['app://jarvis'],
    tmpDir: join(dir, 'tmp'),
    setWakeEnabled,
    listen,
    quit: vi.fn()
  })
  const call = (channel: string, ...args: unknown[]) => {
    const fn = electron.handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(fn(trusted, ...args))
  }
  const emit = (channel: string, ...args: unknown[]) => electron.listeners.get(channel)?.(trusted, ...args)
  return { settings, secrets, bus, chats, windows, ai, ipc, call, emit, setWakeEnabled, listen }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-ipc-'))
  electron.handlers.clear()
  electron.listeners.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('registerIpcHandlers', () => {
  it('registers every contract channel and removes them on dispose', () => {
    const { ipc } = setup()
    expect([...electron.handlers.keys()].sort()).toEqual(Object.values(IPC).sort())
    expect([...electron.listeners.keys()].sort()).toEqual(Object.values(IPC_SEND).sort())
    ipc.dispose()
    expect(electron.handlers.size).toBe(0)
    expect(electron.listeners.size).toBe(0)
  })

  it('rejects requests from foreign frames', async () => {
    setup()
    const fn = electron.handlers.get(IPC.settingsGet)!
    await expect(Promise.resolve().then(() => fn(untrusted))).rejects.toThrow(/недоверенный/)
    await expect(Promise.resolve().then(() => fn({ senderFrame: null }))).rejects.toThrow()
  })

  it('serves PublicSettings and broadcasts changes', async () => {
    const { call, windows, ai, bus } = setup()
    const pub = await call(IPC.settingsGet)
    expect(pub).toMatchObject({
      hasApiKey: false,
      apiKeyHint: '',
      hasElevenLabsKey: false,
      platform: 'darwin',
      appVersion: '1.2.3',
      resolvedModels: { sol: 'gpt-6-sol' }
    })

    const changed = vi.fn()
    bus.on('settings-changed', changed)
    const updated = await call(IPC.settingsUpdate, { defaultTier: 'sol', ttsSpeed: 9 })
    expect(updated).toMatchObject({ defaultTier: 'sol', ttsSpeed: 2 })
    expect(changed).toHaveBeenCalledOnce()
    expect(windows.broadcast).toHaveBeenCalledWith(IPC_EVENT.settingsChanged, expect.objectContaining({ defaultTier: 'sol' }))

    const withKey = await call(IPC.settingsSetApiKey, '  sk-test-abcdef123456  ')
    expect(withKey).toMatchObject({ hasApiKey: true, apiKeyHint: 'sk-…3456' })
    expect(JSON.stringify(withKey)).not.toContain('abcdef')
    expect(ai.models.refresh).toHaveBeenCalled()
    await expect(call(IPC.settingsSetApiKey, '   ')).rejects.toThrow('Введите ключ')

    const eleven = await call(IPC.settingsSetElevenLabsKey, 'xi-abcdef9876')
    expect(eleven).toMatchObject({ hasElevenLabsKey: true, elevenLabsKeyHint: 'xi-…9876' })
    expect(await call(IPC.settingsClearElevenLabsKey)).toMatchObject({ hasElevenLabsKey: false })
    expect(await call(IPC.settingsClearApiKey)).toMatchObject({ hasApiKey: false })
    await call(IPC.settingsUpdate, { baseUrl: 'https://proxy.example.com/v1/' })
    expect(ai.models.refresh).toHaveBeenCalledTimes(3)
    expect(await call(IPC.settingsReset)).toMatchObject({ defaultTier: 'terra', baseUrl: 'https://api.openai.com/v1' })
  })

  it('wraps model and ElevenLabs errors into result objects', async () => {
    const { call } = setup()
    expect(await call(IPC.modelsList, true)).toEqual({ models: [], error: 'Не задан API-ключ OpenAI.' })
    expect(await call(IPC.speechListElevenLabsVoices)).toEqual({ voices: [], error: 'Не задан ключ ElevenLabs.' })
    expect(await call(IPC.modelsTest)).toEqual({ ok: true, message: 'Подключение работает. Доступно моделей: 3' })
  })

  it('handles chats with validation', async () => {
    const { call, settings, ai } = setup()
    settings.update({ defaultTier: 'luna' })
    const chat = (await call(IPC.chatsCreate, {})) as { id: string; tier: string }
    expect(chat.tier).toBe('luna')
    expect(((await call(IPC.chatsCreate, { tier: 'sol' })) as { tier: string }).tier).toBe('sol')
    await call(IPC.chatsRename, chat.id, '  Мой план ')
    expect(((await call(IPC.chatsGet, chat.id)) as { title: string }).title).toBe('Мой план')
    await expect(call(IPC.chatsRename, chat.id, '')).rejects.toThrow()
    await expect(call(IPC.chatsSetTier, chat.id, 'mars')).rejects.toThrow()
    expect(await call(IPC.chatsGet, 'missing')).toBeNull()
    expect((await call(IPC.chatsList)) as unknown[]).toHaveLength(2)
    expect((await call(IPC.chatsSearch, 'план')) as unknown[]).toHaveLength(1)

    await call(IPC.chatsSend, { chatId: chat.id, text: 'Привет' })
    expect(ai.assistant.send).toHaveBeenCalledWith({ chatId: chat.id, text: 'Привет', source: 'text' })
    await expect(call(IPC.chatsSend, { chatId: 'gone123', text: 'x' })).rejects.toThrow('Чат не найден')
    await expect(call(IPC.chatsSend, { text: 'x', images: ['u404'] })).rejects.toThrow('не найдено')

    ai.assistant.currentTurn.mockReturnValue({ chatId: chat.id, turnId: 't9' } as never)
    await call(IPC.chatsRemove, chat.id)
    expect(ai.assistant.cancel).toHaveBeenCalledWith('t9')
    expect(await call(IPC.chatsGet, chat.id)).toBeNull()
    await call(IPC.chatsCancel)
    expect(ai.assistant.cancel).toHaveBeenLastCalledWith(undefined)
  })

  it('speaks replays as one synthetic turn and stops speech', async () => {
    const { call, bus } = setup()
    const chunks: SpeakChunk[] = []
    const stops = vi.fn()
    bus.on('speak', (c) => chunks.push(c))
    bus.on('stop-speaking', stops)
    await call(IPC.speechSpeak, '**Готово**, сэр. Telegram открыт.')
    expect(stops).toHaveBeenCalledOnce()
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].turnId).toMatch(/^replay-[a-z0-9]+$/)
    expect(chunks[chunks.length - 1].final).toBe(true)
    // The HUD shows the replayed text instead of the previous reply.
    expect(bus.getState().response).toBe('**Готово**, сэр. Telegram открыт.')
    await call(IPC.speechStop)
    expect(stops).toHaveBeenCalledTimes(2)
  })

  it('keeps the running turn\'s reply on the HUD while a message is replayed', async () => {
    const { call, bus, ai } = setup()
    ai.assistant.currentTurn.mockReturnValue({ chatId: 'c1', turnId: 't1' } as never)
    bus.patchState({ phase: 'thinking', response: 'Текущий ответ' })
    await call(IPC.speechSpeak, 'Старое сообщение.')
    expect(bus.getState().response).toBe('Текущий ответ')
  })

  it('converts synthesized audio and validates transcription input', async () => {
    const { call, ai } = setup()
    const res = (await call(IPC.speechSynthesize, 'Добрый вечер')) as { audio: Uint8Array; mime: string }
    expect(res.mime).toBe('audio/mpeg')
    expect([...res.audio]).toEqual([1, 2, 3])
    expect(await call(IPC.speechTranscribe, new Uint8Array([1, 2]).buffer, 'audio/wav')).toBe('привет')
    expect(ai.speech.transcribe).toHaveBeenCalledWith(Buffer.from([1, 2]), 'audio/wav')
    await expect(call(IPC.speechTranscribe, new ArrayBuffer(25 * 1024 * 1024 + 1), 'audio/wav')).rejects.toThrow('25 МБ')
    await expect(call(IPC.speechTranscribe, new ArrayBuffer(4), 'text/plain')).rejects.toThrow()
    await expect(call(IPC.mediaImportImage, new ArrayBuffer(20 * 1024 * 1024 + 1), 'image/png')).rejects.toThrow('20 МБ')
  })

  it('routes voice-window traffic and app commands', async () => {
    const { call, emit, bus, ai, windows, setWakeEnabled, listen } = setup()
    expect(await call(IPC.voiceSubmit, 'открой калькулятор')).toEqual({ chatId: 'c1', turnId: 't1' })
    expect(ai.assistant.send).toHaveBeenCalledWith({ text: 'открой калькулятор', source: 'voice' })
    emit(IPC_SEND.voicePhase, { phase: 'listening', wakeActive: true })
    expect(bus.getState()).toMatchObject({ phase: 'listening', wakeActive: true })
    const done = vi.fn()
    bus.on('speech-done', done)
    emit(IPC_SEND.voiceSpeechDone, { turnId: 't1', interrupted: false })
    expect(done).toHaveBeenCalledWith({ turnId: 't1', interrupted: false })
    expect(await call(IPC.assistantGetState)).toMatchObject({ phase: 'listening' })

    await call(IPC.assistantSetWake, false)
    expect(setWakeEnabled).toHaveBeenCalledWith(false)
    await expect(call(IPC.assistantSetWake, 'yes')).rejects.toThrow()
    await call(IPC.assistantListen)
    expect(listen).toHaveBeenCalledOnce()
    await call(IPC.appShowMain, { chatId: 'abc', view: 'chat' })
    expect(windows.showMain).toHaveBeenCalledWith({ chatId: 'abc', view: 'chat' })
    await call(IPC.appHideOverlay)
    expect(windows.hideOverlay).toHaveBeenCalledOnce()
    await expect(call(IPC.appOpenExternal, 'file:///etc/passwd')).rejects.toThrow('http')
    await expect(call(IPC.appRequestPermission, 'camera')).rejects.toThrow()
    expect(await call(IPC.appGetPermissions)).toEqual({ microphone: 'granted', screen: 'granted', accessibility: 'granted' })
    expect(await call(IPC.mediaPickImage)).toBeNull()
  })
})
