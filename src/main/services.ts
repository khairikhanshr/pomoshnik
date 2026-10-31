// Interfaces of the main-process services. Implementations live in separate modules and
// are wired together in src/main/index.ts. CONTRACT FILE: additive changes only.
import type { BrowserWindow } from 'electron'
import type {
  Chat,
  ChatMessage,
  ChatSummary,
  ElevenLabsVoice,
  ImageRef,
  MessageSource,
  NavigateRequest,
  Settings,
  SettingsPatch,
  Tier
} from '@shared/types'

export type Disposer = () => void

/** src/main/store/settings.ts — JSON file in userData, validated & migrated on load. */
export interface SettingsStore {
  get(): Settings
  /** Validates (clamps numbers, ignores unknown keys / wrong types), persists, notifies listeners. */
  update(patch: SettingsPatch): Settings
  reset(): Settings
  onChange(cb: (next: Settings, prev: Settings) => void): Disposer
}

/** src/main/store/secrets.ts — API key encrypted with Electron safeStorage (Keychain / DPAPI). */
export interface SecretStore {
  getApiKey(): string | null
  /** null or '' removes the key. */
  setApiKey(key: string | null): void
  /** Masked form for UI, e.g. "sk-…a1B2"; '' when absent. */
  apiKeyHint(): string
  getElevenLabsKey(): string | null
  /** null or '' removes the key. */
  setElevenLabsKey(key: string | null): void
  elevenLabsKeyHint(): string
  /** Fires after any secret changed. */
  onChange(cb: () => void): Disposer
}

/** src/main/store/chats.ts — one JSON file per chat + index, atomic writes. */
export interface ChatStore {
  list(): ChatSummary[]
  get(id: string): Chat | null
  summary(id: string): ChatSummary | null
  create(init?: { tier?: Tier; source?: MessageSource; title?: string }): Chat
  appendMessage(chatId: string, message: ChatMessage): void
  updateMessage(chatId: string, messageId: string, patch: Partial<ChatMessage>): void
  /** Removes one message (used by "retry" to drop a failed reply and its question before re-sending). */
  removeMessage(chatId: string, messageId: string): void
  rename(chatId: string, title: string): void
  setTier(chatId: string, tier: Tier): void
  remove(chatId: string): void
  clearAll(): void
  /** Case-insensitive search over titles and message text. */
  search(query: string): ChatSummary[]
  /** Most recently updated chat with source='voice' if it was updated within maxAgeMs. */
  findRecentVoiceChat(maxAgeMs: number): Chat | null
  /** Persist pending debounced writes (called on quit). */
  flush(): void
}

/** src/main/store/media.ts — images (screenshots, uploads) under userData/media. */
export interface MediaStore {
  save(
    data: Buffer,
    opts: { kind: ImageRef['kind']; mime: 'image/png' | 'image/jpeg'; width?: number; height?: number }
  ): ImageRef
  ref(id: string): ImageRef | null
  /** Absolute path of the stored file, or null when unknown. */
  path(id: string): string | null
  /** data: URL for the model API; downscaled so the longest side <= maxSide when given. */
  dataUrl(id: string, opts?: { maxSide?: number }): Promise<string | null>
  remove(id: string): void
}

/** src/main/app/windows.ts */
export interface WindowService {
  showMain(nav?: NavigateRequest): void
  hideMain(): void
  toggleMain(): void
  isMainVisible(): boolean
  getMainWindow(): BrowserWindow | null
  showOverlay(): void
  hideOverlay(): void
  /** Hides Jarvis' own visible windows while fn runs (for screenshots) and restores them afterwards. */
  withUiHidden<T>(fn: () => Promise<T>): Promise<T>
  /** Send an event to the hidden voice-engine window. */
  sendToVoice(channel: string, payload?: unknown): void
  /** Send an event to every Jarvis window. */
  broadcast(channel: string, payload?: unknown): void
}

/** src/main/ai/models.ts */
export interface ModelCatalog {
  /** Model ids from GET {baseUrl}/models (cached ~1h). Throws on HTTP/network errors. */
  list(force?: boolean): Promise<string[]>
  /** Concrete model id for a tier (explicit setting, else newest cached match, else fallback). Never throws. */
  resolve(tier: Tier): string
  resolvedAll(): Record<Tier, string>
  /** Re-fetch the model list in the background (after key / base URL change). Never throws. */
  refresh(): Promise<void>
}

/** src/main/ai/speech.ts — OpenAI audio endpoints + ElevenLabs TTS. */
export interface SpeechService {
  /** POST /audio/transcriptions. Returns trimmed text ('' for silence). */
  transcribe(
    audio: Buffer,
    mime: string,
    opts?: { language?: string; prompt?: string; purpose?: 'wake' | 'command' | 'dictation' }
  ): Promise<string>
  /** Cloud TTS per settings.ttsProvider ('openai' -> POST /audio/speech, 'elevenlabs' -> ElevenLabs), mp3. */
  synthesize(text: string): Promise<{ data: Buffer; mime: string }>
  /** GET {elevenlabs}/v1/voices for the stored ElevenLabs key. Throws a Russian message on errors. */
  listElevenLabsVoices(): Promise<ElevenLabsVoice[]>
}

export interface AssistantSendRequest {
  /** Omit: voice -> recent voice chat (15 min) or a new one; text -> new chat. */
  chatId?: string
  text: string
  /** MediaStore ids attached by the user. */
  images?: string[]
  tier?: Tier
  source: MessageSource
  /** Override settings.speakMode for this turn. */
  speak?: boolean
}

/** src/main/ai/assistant.ts — the agent loop. One active turn at a time; a new send cancels the running one. */
export interface AssistantService {
  /** Stores the user message, starts the turn and resolves immediately. Progress goes through the bus. */
  send(req: AssistantSendRequest): Promise<{ chatId: string; turnId: string }>
  cancel(turnId?: string): void
  currentTurn(): { chatId: string; turnId: string } | null
  /** Cheap request to validate key + base URL; Russian message for the UI. */
  testConnection(): Promise<{ ok: boolean; message: string }>
}
