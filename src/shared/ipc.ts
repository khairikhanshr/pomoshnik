// IPC contract between main and renderers. CONTRACT FILE: additive changes only.
// The preload script exposes `window.jarvis: JarvisApi`; main registers handlers for every channel.
import type {
  AssistantState,
  Chat,
  ChatEvent,
  ChatSummary,
  ElevenLabsVoice,
  ImageRef,
  NavigateRequest,
  PermissionKind,
  PermissionsStatus,
  Platform,
  PublicSettings,
  SettingsPatch,
  SpeakChunk,
  Tier,
  VoicePhaseReport
} from './types'

/** ipcRenderer.invoke channels (request/response). */
export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSetApiKey: 'settings:set-api-key',
  settingsClearApiKey: 'settings:clear-api-key',
  settingsSetElevenLabsKey: 'settings:set-elevenlabs-key',
  settingsClearElevenLabsKey: 'settings:clear-elevenlabs-key',
  settingsReset: 'settings:reset',

  modelsList: 'models:list',
  modelsTest: 'models:test',

  chatsList: 'chats:list',
  chatsGet: 'chats:get',
  chatsCreate: 'chats:create',
  chatsRename: 'chats:rename',
  chatsSetTier: 'chats:set-tier',
  chatsRemove: 'chats:remove',
  chatsClearAll: 'chats:clear-all',
  chatsSearch: 'chats:search',
  chatsSend: 'chats:send',
  chatsCancel: 'chats:cancel',
  chatsRetry: 'chats:retry',

  mediaCaptureScreen: 'media:capture-screen',
  mediaImportImage: 'media:import-image',
  mediaPickImage: 'media:pick-image',

  speechTranscribe: 'speech:transcribe',
  speechSynthesize: 'speech:synthesize',
  speechSpeak: 'speech:speak',
  speechStop: 'speech:stop',
  speechListElevenLabsVoices: 'speech:list-elevenlabs-voices',

  assistantGetState: 'assistant:get-state',
  assistantListen: 'assistant:listen',
  assistantSetWake: 'assistant:set-wake',
  assistantSetDictating: 'assistant:set-dictating',

  voiceSubmit: 'voice:submit',

  appShowMain: 'app:show-main',
  appHideOverlay: 'app:hide-overlay',
  appGetPermissions: 'app:get-permissions',
  appRequestPermission: 'app:request-permission',
  appOpenPermissionSettings: 'app:open-permission-settings',
  appOpenExternal: 'app:open-external',
  appRelaunch: 'app:relaunch',
  appQuit: 'app:quit'
} as const

/** ipcRenderer.send channels (renderer -> main, fire and forget). */
export const IPC_SEND = {
  voicePhase: 'voice:phase',
  voiceLevel: 'voice:level',
  voiceSpeechDone: 'voice:speech-done',
  voiceLog: 'voice:log',
  /** Overlay: pointer is over the HUD panel (true) / left it (false) — toggles click-through of the transparent area. */
  overlayInteractive: 'overlay:interactive',
  /** Main window: the chat currently shown (null = none / settings). Voice requests join it while the window is in use. */
  activeChat: 'app:active-chat'
} as const

/** webContents.send channels (main -> renderer events). */
export const IPC_EVENT = {
  settingsChanged: 'event:settings-changed',
  chatEvent: 'event:chat',
  assistantState: 'event:assistant-state',
  /** Mic / TTS output level 0..1 for the orb animation (~15/s). */
  level: 'event:level',
  /** To the voice window: speak this chunk. */
  voiceSpeak: 'event:voice-speak',
  /** To the voice window: stop playback and clear the queue. */
  voiceStopSpeaking: 'event:voice-stop-speaking',
  /** To the voice window: start recording a command right now (hotkey / tray / UI button). */
  voiceListen: 'event:voice-listen',
  /** To the voice window: wake engine on/off was toggled (payload boolean). */
  voiceSetWake: 'event:voice-set-wake',
  /** To the voice window: chat dictation started/stopped (payload boolean) — pause wake detection meanwhile. */
  voiceSetDictating: 'event:voice-set-dictating',
  /** To the main window: switch view / open a chat. */
  navigate: 'event:navigate'
} as const

export type Unsubscribe = () => void

export interface SendChatRequest {
  /** Omit to start a new chat. */
  chatId?: string
  text: string
  /** MediaStore image ids attached by the user. */
  images?: string[]
  /** Override the chat's tier for this message (also becomes the chat's tier). */
  tier?: Tier
  /** Force speaking the reply (default: settings.speakMode). */
  speak?: boolean
}

export interface SendChatResult {
  chatId: string
  turnId: string
}

export interface ModelsListResult {
  models: string[]
  error?: string
}

export interface TestConnectionResult {
  ok: boolean
  message: string
}

export interface TranscribeOptions {
  /**
   * wake = cloud wake-word check (no vocabulary prompt, short timeout); command = a voice command;
   * dictation = chat-box dictation. Default 'command'.
   */
  purpose?: 'wake' | 'command' | 'dictation'
}

export interface SynthesizeResult {
  audio: Uint8Array
  mime: string
}

/** Speech done report from the voice window (all chunks of a turn were played or playback was stopped). */
export interface SpeechDoneReport {
  turnId: string
  interrupted: boolean
}

export interface JarvisApi {
  platform: Platform

  settings: {
    get(): Promise<PublicSettings>
    update(patch: SettingsPatch): Promise<PublicSettings>
    setApiKey(key: string): Promise<PublicSettings>
    clearApiKey(): Promise<PublicSettings>
    setElevenLabsKey(key: string): Promise<PublicSettings>
    clearElevenLabsKey(): Promise<PublicSettings>
    reset(): Promise<PublicSettings>
    onChanged(cb: (s: PublicSettings) => void): Unsubscribe
  }

  models: {
    /** Model ids available to the key (GET /models). */
    list(force?: boolean): Promise<ModelsListResult>
    /** Validates key + base URL with a cheap request. */
    test(): Promise<TestConnectionResult>
  }

  chats: {
    list(): Promise<ChatSummary[]>
    get(id: string): Promise<Chat | null>
    create(opts?: { tier?: Tier }): Promise<Chat>
    rename(id: string, title: string): Promise<void>
    setTier(id: string, tier: Tier): Promise<void>
    remove(id: string): Promise<void>
    clearAll(): Promise<void>
    search(query: string): Promise<ChatSummary[]>
    send(req: SendChatRequest): Promise<SendChatResult>
    /** Cancel a running turn (omit id = current turn). */
    cancel(turnId?: string): Promise<void>
    /**
     * Retry a failed/cancelled assistant reply in place: main removes that reply and the user message before it,
     * then re-sends the same text, images and tier (no duplicated question).
     */
    retry(chatId: string, assistantMessageId: string): Promise<SendChatResult>
    onEvent(cb: (ev: ChatEvent) => void): Unsubscribe
  }

  media: {
    /** Screenshot of the display under the cursor, stored as an attachment. */
    captureScreen(): Promise<ImageRef>
    importImage(data: ArrayBuffer, mime: string): Promise<ImageRef>
    /** Native file dialog; null when cancelled. */
    pickImage(): Promise<ImageRef | null>
  }

  speech: {
    /** audio: WAV (16 kHz mono PCM16) or webm/ogg from MediaRecorder. */
    transcribe(audio: ArrayBuffer, mime: string, opts?: TranscribeOptions): Promise<string>
    /** Cloud TTS (OpenAI or ElevenLabs per settings.ttsProvider) with the current voice settings. */
    synthesize(text: string): Promise<SynthesizeResult>
    /** Voices of the user's ElevenLabs account (GET /v1/voices). */
    listElevenLabsVoices(): Promise<{ voices: ElevenLabsVoice[]; error?: string }>
    /** Speak arbitrary text through the voice window (e.g. replay a message). */
    speak(text: string): Promise<void>
    stop(): Promise<void>
  }

  assistant: {
    getState(): Promise<AssistantState>
    onState(cb: (s: AssistantState) => void): Unsubscribe
    onLevel(cb: (level: number) => void): Unsubscribe
    /** Start listening for a command now (push-to-talk). */
    listen(): Promise<void>
    /** Turn the wake-word engine on/off (persists settings.wakeEngine on->'local' default when re-enabled). */
    setWakeEnabled(enabled: boolean): Promise<void>
    /** Chat-box dictation started/stopped: the voice engine pauses wake detection meanwhile. */
    setDictating(active: boolean): Promise<void>
  }

  /** Used by the hidden voice window. */
  voice: {
    /** Submit a recognised voice command. Main runs the assistant and streams SpeakChunks back. */
    submit(text: string): Promise<SendChatResult>
    reportPhase(report: VoicePhaseReport): void
    reportLevel(level: number): void
    reportSpeechDone(report: SpeechDoneReport): void
    log(level: 'info' | 'warn' | 'error', message: string): void
    onSpeak(cb: (chunk: SpeakChunk) => void): Unsubscribe
    onStopSpeaking(cb: () => void): Unsubscribe
    onListen(cb: () => void): Unsubscribe
    onSetWake(cb: (enabled: boolean) => void): Unsubscribe
    onSetDictating(cb: (active: boolean) => void): Unsubscribe
  }

  app: {
    showMain(nav?: NavigateRequest): Promise<void>
    hideOverlay(): Promise<void>
    getPermissions(): Promise<PermissionsStatus>
    requestPermission(kind: PermissionKind): Promise<PermissionsStatus>
    openPermissionSettings(kind: PermissionKind): Promise<void>
    openExternal(url: string): Promise<void>
    /** Restart the app (e.g. after granting Screen Recording on macOS). */
    relaunch(): Promise<void>
    quit(): Promise<void>
    onNavigate(cb: (nav: NavigateRequest) => void): Unsubscribe
    /** Overlay only: pointer entered (true) / left (false) the HUD panel. */
    setOverlayInteractive(interactive: boolean): void
    /** Main window only: report the chat on screen (null when none). */
    reportActiveChat(chatId: string | null): void
  }
}
