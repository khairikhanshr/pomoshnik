// Default settings and constants. CONTRACT FILE: additive changes only.
import type { Platform, ReasoningEffort, Settings, Tier } from './types'

export const SETTINGS_VERSION = 1

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Used when 'auto' cannot be resolved from GET /models (no key yet, offline, proxy without /models). */
export const FALLBACK_TIER_MODELS: Record<Tier, string> = {
  luna: 'gpt-5.6-luna',
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol'
}

/** Model ids matching this are candidates for 'auto' tier resolution: gpt-<version>-<tier>. */
export const TIER_MODEL_PATTERN = /^gpt-(\d+(?:\.\d+)?)-(luna|terra|sol)$/

export const TIER_INFO: Record<Tier, { label: string; subtitle: string; description: string; icon: string }> = {
  luna: {
    label: 'Luna',
    subtitle: 'Быстрая',
    description: 'Самая быстрая и экономичная. Короткие вопросы, команды компьютеру, черновики.',
    icon: '☾'
  },
  terra: {
    label: 'Terra',
    subtitle: 'Сбалансированная',
    description: 'Баланс скорости и качества. Подходит для большинства задач и голосовых команд.',
    icon: '◉'
  },
  sol: {
    label: 'Sol',
    subtitle: 'Максимальная',
    description: 'Флагман: сложные рассуждения, код, анализ, разбор тестов и документов со скриншота.',
    icon: '☀'
  }
}

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  auto: 'По умолчанию модели',
  none: 'Без рассуждений',
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
  xhigh: 'Очень высокий',
  max: 'Максимальный'
}

export const OPENAI_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'] as const
export const OPENAI_TTS_VOICES = [
  'onyx',
  'ash',
  'echo',
  'fable',
  'cedar',
  'marin',
  'alloy',
  'ballad',
  'coral',
  'nova',
  'sage',
  'shimmer',
  'verse'
] as const
export const OPENAI_STT_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'] as const

export const DEFAULT_ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io'
/** Multilingual ElevenLabs models (all speak Russian). */
export const ELEVENLABS_MODELS = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — лучшее качество' },
  { id: 'eleven_v3', label: 'v3 — самая выразительная' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — минимальная задержка' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 — быстро и качественно' }
] as const

/**
 * Voice style in the spirit of a film-style AI butler. This describes a style only;
 * it does not imitate any real person's voice.
 */
export const JARVIS_VOICE_INSTRUCTIONS = [
  'Voice: a calm, velvety, confident male baritone of a refined British AI butler.',
  'Tone: impeccably polite, composed and reassuring, with a subtle dry wit.',
  'Pacing: measured and unhurried, crisp articulation, short natural pauses between sentences.',
  'Emotion: quiet confidence and warm attentiveness; never exaggerated.',
  'Language: speak in exactly the language of the text (Russian text in natural Russian, English text with a British accent).'
].join('\n')

export const DEFAULT_WAKE_PHRASES = ['джарвис', 'jarvis']

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,

  baseUrl: DEFAULT_BASE_URL,
  apiMode: 'responses',
  tiers: {
    luna: { model: 'auto', reasoningEffort: 'low' },
    terra: { model: 'auto', reasoningEffort: 'low' },
    sol: { model: 'auto', reasoningEffort: 'medium' }
  },
  defaultTier: 'terra',
  voiceTier: 'terra',
  visionTier: 'sol',
  webSearch: true,
  // 'original' keeps screenshots at full resolution so the model's pixel coordinates match ours;
  // models that reject it fall back to 'high' (and the setting is switched to 'high').
  imageDetail: 'original',
  customInstructions: '',
  userTitle: 'сэр',
  userName: '',

  sttModel: 'gpt-4o-mini-transcribe',
  sttLanguage: '',

  ttsProvider: 'openai',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'onyx',
  ttsInstructions: JARVIS_VOICE_INSTRUCTIONS,
  ttsSpeed: 1.0,
  elevenVoiceId: '',
  elevenModel: 'eleven_multilingual_v2',
  elevenStability: 0.5,
  elevenSimilarity: 0.75,
  systemVoiceName: '',
  speakMode: 'voice',
  maxSpokenChars: 700,

  wakeEngine: 'local',
  wakePhrases: [...DEFAULT_WAKE_PHRASES],
  wakeSensitivity: 'medium',
  micDeviceId: '',
  followUpSeconds: 6,
  commandTimeoutSeconds: 8,
  acknowledge: 'chime',

  hotkeyVoice: 'CommandOrControl+Shift+Space',
  hotkeyWindow: 'CommandOrControl+Shift+J',

  computerControl: true,
  confirmDangerous: true,
  allowShellCommands: true,

  launchAtLogin: true,
  startHidden: false,
  showOverlay: true,
  overlayPosition: 'top-right',
  showInDock: true
}

/**
 * Per-platform overrides of DEFAULT_SETTINGS for NEW installs (existing settings files keep their values).
 * Windows: Ctrl+Shift+Space is Word's non-breaking space and Ctrl+Shift+J opens browser dev consoles.
 */
export const PLATFORM_DEFAULTS: Partial<Record<Platform, Partial<Settings>>> = {
  win32: { hotkeyVoice: 'Control+Alt+Space', hotkeyWindow: 'Control+Alt+J' },
  // macOS notification banners live in the top-right corner.
  darwin: { overlayPosition: 'top-center' }
}

export function defaultSettingsFor(platform: Platform): Settings {
  return { ...DEFAULT_SETTINGS, ...PLATFORM_DEFAULTS[platform] }
}

/** Limits shared by main and renderers. */
export const LIMITS = {
  /** Max agent loop iterations (model calls) per turn. */
  maxToolSteps: 12,
  /** Tool output text sent back to the model is truncated to this many chars. */
  maxToolOutputChars: 8000,
  /** Screenshots are downscaled so the longest side is at most this many pixels. */
  screenshotMaxSide: 2560,
  /** Only the images of the most recent N messages are re-sent to the model. */
  historyImageMessages: 2,
  /** Voice segments longer than this are not sent for wake-word checks. */
  maxWakeSegmentSeconds: 15,
  /** Max user command recording length. */
  maxCommandSeconds: 30
} as const
