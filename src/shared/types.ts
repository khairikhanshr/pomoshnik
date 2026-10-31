// Domain types shared by the main process, preload and all renderer windows.
// CONTRACT FILE: additive changes only (new optional fields / new types).

export type Tier = 'luna' | 'terra' | 'sol'
export const TIERS: readonly Tier[] = ['luna', 'terra', 'sol']

/** 'auto' = do not send the parameter (model default). */
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface TierConfig {
  /** Concrete OpenAI model id, or 'auto' = newest `gpt-<ver>-<tier>` model the key can access. */
  model: string
  reasoningEffort: ReasoningEffort
}

/** responses = OpenAI Responses API (recommended); chat = Chat Completions (OpenAI-compatible proxies). */
export type ApiMode = 'responses' | 'chat'
/** openai = OpenAI TTS; elevenlabs = ElevenLabs voice from the user's account; system = OS voices. */
export type TtsProvider = 'openai' | 'elevenlabs' | 'system'
/** local = Silero VAD + bundled Whisper (offline); cloud = VAD + OpenAI transcription; off = hotkey/button only. */
export type WakeEngine = 'local' | 'cloud' | 'off'
export type WakeSensitivity = 'low' | 'medium' | 'high'
/** When replies are spoken aloud: voice = only replies to voice requests. */
export type SpeakMode = 'voice' | 'always' | 'never'
export type ImageDetail = 'auto' | 'low' | 'high' | 'original'
export type OverlayPosition = 'top-right' | 'top-center' | 'bottom-center' | 'bottom-right'
export type Platform = 'darwin' | 'win32' | 'linux'

export interface Settings {
  version: number

  // --- AI ---
  /** OpenAI API base URL, no trailing slash. */
  baseUrl: string
  apiMode: ApiMode
  tiers: Record<Tier, TierConfig>
  /** Tier for new text chats. */
  defaultTier: Tier
  /** Tier used for voice requests. */
  voiceTier: Tier
  /**
   * Tier that reads screenshots: after take_screenshot in a turn, the remaining steps of that turn use this
   * tier ('same' = keep the turn's tier). Screen tests need the strongest model.
   */
  visionTier: Tier | 'same'
  /** Built-in OpenAI web_search tool (Responses API only). */
  webSearch: boolean
  imageDetail: ImageDetail
  /** Free text appended to the Jarvis persona prompt. */
  customInstructions: string
  /** How Jarvis addresses the user, e.g. "сэр". */
  userTitle: string
  userName: string

  // --- Speech to text ---
  sttModel: string
  /** ISO-639-1 code or '' for auto-detect. */
  sttLanguage: string

  // --- Text to speech ---
  ttsProvider: TtsProvider
  ttsModel: string
  ttsVoice: string
  /** Style instructions for gpt-4o-mini-tts style models. */
  ttsInstructions: string
  /** 0.5 .. 2.0 */
  ttsSpeed: number
  /** ElevenLabs voice id (from the user's ElevenLabs account / voice library). */
  elevenVoiceId: string
  /** ElevenLabs model id, e.g. eleven_multilingual_v2. */
  elevenModel: string
  /** ElevenLabs voice_settings.stability 0..1 */
  elevenStability: number
  /** ElevenLabs voice_settings.similarity_boost 0..1 */
  elevenSimilarity: number
  /** System (OS) voice name for ttsProvider='system' or as fallback; '' = best match for language. */
  systemVoiceName: string
  speakMode: SpeakMode
  /** Spoken replies are cut after roughly this many characters ("подробности в чате"). */
  maxSpokenChars: number

  // --- Wake word / voice session ---
  wakeEngine: WakeEngine
  /** Phrases that wake Jarvis, lower-case. */
  wakePhrases: string[]
  wakeSensitivity: WakeSensitivity
  /** MediaDeviceInfo.deviceId, '' = system default. */
  micDeviceId: string
  /** After Jarvis finishes speaking, keep listening this long for a follow-up without the wake word. 0 = off. */
  followUpSeconds: number
  /** After a bare wake word, wait this long for the command. */
  commandTimeoutSeconds: number
  /** Reaction to a bare wake word. */
  acknowledge: 'chime' | 'voice' | 'both'

  // --- Hotkeys (Electron accelerators, '' = disabled) ---
  hotkeyVoice: string
  hotkeyWindow: string

  // --- Computer control ---
  computerControl: boolean
  /** Ask before dangerous actions (power off, closing apps by force, overwriting files, shell commands). */
  confirmDangerous: boolean
  /** Enables the run_command tool. Always asks for confirmation unless confirmDangerous=false. */
  allowShellCommands: boolean

  // --- General ---
  launchAtLogin: boolean
  /** Start in the tray/menu bar without showing the main window. */
  startHidden: boolean
  showOverlay: boolean
  overlayPosition: OverlayPosition
  /** macOS: keep the Dock icon while the main window is hidden. */
  showInDock: boolean
}

/** Settings as seen by renderers: no secrets, plus derived read-only info. */
export interface PublicSettings extends Settings {
  hasApiKey: boolean
  /** Masked key, e.g. "sk-…a1B2", '' when no key. */
  apiKeyHint: string
  hasElevenLabsKey: boolean
  elevenLabsKeyHint: string
  platform: Platform
  appVersion: string
  /** What each tier currently resolves to (after 'auto' resolution). */
  resolvedModels: Record<Tier, string>
  /** macOS 13+: state of the login item (requires-approval = user must allow it in System Settings). */
  loginItemStatus?: LoginItemStatus
  /** Russian reason per hotkey setting that could not be registered (e.g. taken by another app). */
  hotkeyErrors?: Partial<Record<'hotkeyVoice' | 'hotkeyWindow', string>>
}

export type LoginItemStatus = 'enabled' | 'requires-approval' | 'not-registered' | 'not-found' | 'unknown'

export type SettingsPatch = Partial<Omit<Settings, 'version' | 'tiers'>> & {
  tiers?: Partial<Record<Tier, Partial<TierConfig>>>
}

// --- Chats ---

export type MessageSource = 'text' | 'voice'

export interface ImageRef {
  /** MediaStore id (file name without extension). */
  id: string
  /** URL renderers can display (jarvis-media://image/<id>). */
  url: string
  kind: 'screenshot' | 'upload'
  width?: number
  height?: number
}

/** interrupted = the turn was cancelled while the tool ran; its outcome is unknown (it may have taken effect). */
export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'interrupted'

export interface ToolCallRecord {
  /** Model's call id. */
  id: string
  name: string
  /** Human readable Russian description, e.g. "Открываю «Telegram»". */
  title: string
  args: Record<string, unknown>
  status: ToolStatus
  /** Short Russian result summary for the UI. */
  summary?: string
  startedAt: number
  endedAt?: number
}

export type MessageStatus = 'streaming' | 'done' | 'error' | 'cancelled'

/** Machine-readable kind of a failed turn; the UI picks the action button from it. */
export type AssistantErrorCode =
  | 'no-key' // no OpenAI key -> open Settings → ИИ
  | 'auth' // 401 invalid / revoked key
  | 'forbidden' // 403 region / project permissions
  | 'quota' // insufficient_quota / billing
  | 'rate-limit' // transient 429 -> retry
  | 'too-large' // request exceeds TPM / context limits -> new chat or smaller input
  | 'model' // model not available to the key
  | 'base-url' // wrong API address / endpoint not found
  | 'stream-verification' // organization must be verified to stream this model
  | 'network' // offline / DNS / connection refused -> retry
  | 'timeout' // server did not answer in time -> retry
  | 'server' // 5xx -> retry
  | 'unknown'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  images?: ImageRef[]
  toolCalls?: ToolCallRecord[]
  tier?: Tier
  model?: string
  source?: MessageSource
  createdAt: number
  status?: MessageStatus
  error?: string
  errorCode?: AssistantErrorCode
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  tier: Tier
  source: MessageSource
  messageCount: number
  /** First ~120 chars of the last message. */
  preview: string
  pinned?: boolean
}

export interface Chat extends ChatSummary {
  messages: ChatMessage[]
}

/** Streaming events for chat windows. */
export type ChatEvent =
  | { type: 'turn-start'; chatId: string; turnId: string; userMessage: ChatMessage; assistantMessage: ChatMessage }
  | { type: 'delta'; chatId: string; turnId: string; messageId: string; text: string }
  | { type: 'tool-start'; chatId: string; turnId: string; messageId: string; call: ToolCallRecord }
  | { type: 'tool-end'; chatId: string; turnId: string; messageId: string; call: ToolCallRecord }
  | { type: 'image'; chatId: string; turnId: string; messageId: string; image: ImageRef }
  | { type: 'turn-end'; chatId: string; turnId: string; message: ChatMessage }
  | { type: 'turn-error'; chatId: string; turnId: string; messageId: string; error: string; errorCode?: AssistantErrorCode }
  | { type: 'chat-updated'; chat: ChatSummary }
  | { type: 'chats-changed' }

// --- Assistant / voice state ---

export type AssistantPhase =
  | 'idle' // waiting for the wake word (or disabled)
  | 'wake' // wake word heard, acknowledging
  | 'listening' // recording a command / follow-up
  | 'transcribing' // speech -> text
  | 'thinking' // waiting for the model
  | 'acting' // running a tool
  | 'speaking' // playing TTS
  | 'error'

export interface AssistantState {
  phase: AssistantPhase
  /** Wake word engine is running and listening. */
  wakeActive: boolean
  /** Voice engine could not start (mic denied, model failed to load, ...). */
  engineError?: string
  /** Last user utterance. */
  transcript?: string
  /** Streaming text of the current reply. */
  response?: string
  /** Current tool action, e.g. "Делаю снимок экрана". */
  toolTitle?: string
  error?: string
  chatId?: string
  turnId?: string
  /** Source of the current turn (the HUD stays hidden for text turns while the main window is focused). */
  source?: MessageSource
  updatedAt: number
}

/** Text chunk for the voice window to speak. Chunks of one turn arrive in seq order. */
export interface SpeakChunk {
  turnId: string
  seq: number
  /** Plain speakable text (markdown already stripped). May be '' when final=true. */
  text: string
  /** Last chunk of this turn. */
  final: boolean
  /**
   * Stand-alone phrase (confirmation prompt, reminder, acknowledgement) spoken between the chunks of the
   * active turn: it must neither interrupt nor finish that turn. Always a single chunk with final=true.
   */
  interject?: boolean
}

/** Voice window -> main phase report. */
export interface VoicePhaseReport {
  phase: AssistantPhase
  transcript?: string
  error?: string
  wakeActive?: boolean
  engineError?: string | null
}

export interface ElevenLabsVoice {
  id: string
  name: string
  /** e.g. "male, british, calm" from the voice labels. */
  description?: string
  previewUrl?: string
}

// --- Permissions (macOS mostly; Windows reports 'granted') ---

export type PermissionKind = 'microphone' | 'screen' | 'accessibility'
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
export type PermissionsStatus = Record<PermissionKind, PermissionState>

export type MainView = 'chat' | 'settings'

/** Tabs of the settings view (ИИ, Голос, Активация, Управление ПК, Общие, О программе). */
export type SettingsTabId = 'ai' | 'voice' | 'activation' | 'computer' | 'general' | 'about'
export const SETTINGS_TAB_IDS: readonly SettingsTabId[] = ['ai', 'voice', 'activation', 'computer', 'general', 'about']

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return typeof value === 'string' && (SETTINGS_TAB_IDS as readonly string[]).includes(value)
}

export interface NavigateRequest {
  view?: MainView
  chatId?: string
  /** Settings tab id to open (one of SETTINGS_TAB_IDS). */
  settingsTab?: string
}
