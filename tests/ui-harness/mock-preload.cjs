// Mock preload for the visual harness: exposes a fake window.jarvis with canned data.
// Scenario and platform come from the page query (?scenario=…&platform=…). Self-contained (sandboxed preload).
const { contextBridge } = require('electron')

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') || 'conversation'
const platform = params.get('platform') || 'darwin'
const now = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const JARVIS_VOICE_INSTRUCTIONS = [
  'Voice: a calm, velvety, confident male baritone of a refined British AI butler.',
  'Tone: impeccably polite, composed and reassuring, with a subtle dry wit.',
  'Pacing: measured and unhurried, crisp articulation, short natural pauses between sentences.',
  'Emotion: quiet confidence and warm attentiveness; never exaggerated.',
  'Language: speak in exactly the language of the text (Russian text in natural Russian, English text with a British accent).'
].join('\n')

const settings = {
  version: 1,
  baseUrl: 'https://api.openai.com/v1',
  apiMode: 'responses',
  tiers: {
    luna: { model: 'auto', reasoningEffort: 'low' },
    terra: { model: 'auto', reasoningEffort: 'low' },
    sol: { model: 'gpt-6-sol', reasoningEffort: 'high' }
  },
  defaultTier: 'terra',
  voiceTier: 'terra',
  webSearch: true,
  imageDetail: 'high',
  customInstructions: '',
  userTitle: 'сэр',
  userName: 'Бекзат',
  sttModel: 'gpt-4o-mini-transcribe',
  sttLanguage: '',
  ttsProvider: scenario === 'settings-voice-eleven' ? 'elevenlabs' : 'openai',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'onyx',
  ttsInstructions: JARVIS_VOICE_INSTRUCTIONS,
  ttsSpeed: 1,
  elevenVoiceId: 'pNInz6obpgDQGcFmaJgB',
  elevenModel: 'eleven_multilingual_v2',
  elevenStability: 0.5,
  elevenSimilarity: 0.75,
  systemVoiceName: '',
  speakMode: 'voice',
  maxSpokenChars: 700,
  wakeEngine: 'local',
  wakePhrases: ['джарвис', 'jarvis'],
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
  showInDock: true,
  hasApiKey: scenario !== 'onboarding',
  apiKeyHint: scenario !== 'onboarding' ? 'sk-…a1B2' : '',
  hasElevenLabsKey: scenario === 'settings-voice-eleven',
  elevenLabsKeyHint: scenario === 'settings-voice-eleven' ? 'sk_…9f3c' : '',
  platform,
  appVersion: '1.0.0',
  resolvedModels: { luna: 'gpt-5.6-luna', terra: 'gpt-6-terra', sol: 'gpt-6-sol' }
}

// A fake "online test" screenshot (SVG) for thumbnails and the lightbox.
const SCREEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
<rect width="1280" height="800" fill="#f3f5f8"/><rect width="1280" height="56" fill="#2f6fde"/>
<text x="32" y="36" font-family="Arial" font-size="22" fill="#fff">Онлайн-тест: Физика, 9 класс</text>
<g font-family="Arial" fill="#1d2633">
<rect x="32" y="88" width="1216" height="200" rx="10" fill="#fff" stroke="#d5dbe5"/>
<text x="56" y="126" font-size="20" font-weight="bold">Вопрос 1. Единица измерения силы в СИ:</text>
<text x="76" y="166" font-size="18">A) Джоуль</text><text x="76" y="198" font-size="18">B) Ньютон</text>
<text x="76" y="230" font-size="18">C) Ватт</text><text x="76" y="262" font-size="18">D) Паскаль</text>
<rect x="32" y="308" width="1216" height="200" rx="10" fill="#fff" stroke="#d5dbe5"/>
<text x="56" y="346" font-size="20" font-weight="bold">Вопрос 2. Скорость света в вакууме примерно равна:</text>
<text x="76" y="386" font-size="18">A) 300 000 км/с</text><text x="76" y="418" font-size="18">B) 150 000 км/с</text>
<text x="76" y="450" font-size="18">C) 3 000 км/с</text><text x="76" y="482" font-size="18">D) 30 000 км/с</text>
<rect x="32" y="528" width="1216" height="200" rx="10" fill="#fff" stroke="#d5dbe5"/>
<text x="56" y="566" font-size="20" font-weight="bold">Вопрос 3. Закон Ома для участка цепи:</text>
<text x="76" y="606" font-size="18">A) I = U / R</text><text x="76" y="638" font-size="18">B) P = U · I</text>
<text x="76" y="670" font-size="18">C) F = m · a</text><text x="76" y="702" font-size="18">D) E = mc²</text></g></svg>`
const SCREEN_URL = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(SCREEN_SVG)))}`
const screenshot = { id: 'shot1', url: SCREEN_URL, kind: 'screenshot', width: 1280, height: 800 }

const summaries = [
  { id: 'c1', title: 'Разбор теста по физике', createdAt: now - 40 * MIN, updatedAt: now - 2 * MIN, tier: 'sol', source: 'voice', messageCount: 8, preview: '' },
  { id: 'c2', title: 'Факториал на TypeScript', createdAt: now - 3 * HOUR, updatedAt: now - 3 * HOUR, tier: 'terra', source: 'text', messageCount: 4, preview: '' },
  { id: 'c3', title: 'Погода в Алматы на выходные', createdAt: now - 5 * HOUR, updatedAt: now - 5 * HOUR, tier: 'luna', source: 'voice', messageCount: 2, preview: '' },
  { id: 'c4', title: 'План презентации для инвесторов', createdAt: now - DAY - HOUR, updatedAt: now - DAY - HOUR, tier: 'sol', source: 'text', messageCount: 12, preview: '' },
  { id: 'c5', title: 'Открыть Telegram', createdAt: now - DAY - 3 * HOUR, updatedAt: now - DAY - 3 * HOUR, tier: 'luna', source: 'voice', messageCount: 2, preview: '' },
  { id: 'c6', title: 'Рецепт плова на 6 человек', createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY, tier: 'terra', source: 'text', messageCount: 6, preview: '' },
  { id: 'c7', title: 'Напоминание о встрече в 15:00', createdAt: now - 4 * DAY, updatedAt: now - 4 * DAY, tier: 'luna', source: 'voice', messageCount: 2, preview: '' },
  { id: 'c8', title: 'Перевод письма на английский язык для партнёров из Лондона', createdAt: now - 5 * DAY, updatedAt: now - 5 * DAY, tier: 'terra', source: 'text', messageCount: 4, preview: '' },
  { id: 'c9', title: 'Сравнение ноутбуков', createdAt: now - 12 * DAY, updatedAt: now - 12 * DAY, tier: 'sol', source: 'text', messageCount: 10, preview: '' },
  { id: 'c10', title: 'Идеи для дня рождения', createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY, tier: 'terra', source: 'text', messageCount: 8, preview: '' },
  { id: 'c11', title: 'Громкость на 30%', createdAt: now - 60 * DAY, updatedAt: now - 60 * DAY, tier: 'luna', source: 'voice', messageCount: 2, preview: '' }
]

const ANSWER_TEST = `Готово, сэр. Я сделал снимок экрана — на нём **3 вопроса**:

1. **Вопрос 1 — B: Ньютон.** Сила в СИ измеряется в ньютонах (кг·м/с²).
2. **Вопрос 2 — A: 300 000 км/с.** Точнее — 299 792 км/с.
3. **Вопрос 3 — A: I = U / R.** Это закон Ома для участка цепи.

| Вопрос | Ответ | Уверенность |
|---|---|---|
| 1 | B | высокая |
| 2 | A | высокая |
| 3 | A | высокая |

> Всё читается чётко, неразборчивых вопросов нет.`

const ANSWER_CODE = `Конечно. Вот функция с проверкой входных данных — она использует \`bigint\`, чтобы не терять точность на больших числах:

\`\`\`ts
export function factorial(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('n должно быть целым неотрицательным числом')
  }
  let result = 1n
  for (let i = 2n; i <= BigInt(n); i++) result *= i
  return result
}

console.log(factorial(20)) // 2432902008176640000n
\`\`\`

Подробнее о \`BigInt\` — в [документации MDN](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Global_Objects/BigInt).`

const messages = [
  { id: 'm1', role: 'user', text: 'Джарвис, сделай скриншот и ответь на вопросы теста', createdAt: now - 40 * MIN, source: 'voice' },
  {
    id: 'm2',
    role: 'assistant',
    text: ANSWER_TEST,
    tier: 'sol',
    model: 'gpt-6-sol',
    createdAt: now - 39 * MIN,
    status: 'done',
    images: [screenshot],
    toolCalls: [
      { id: 't1', name: 'take_screenshot', title: 'Делаю снимок экрана', args: { display: 'cursor' }, status: 'ok', summary: 'Снимок 1280×800', startedAt: now - 39 * MIN, endedAt: now - 39 * MIN + 1400 }
    ]
  },
  { id: 'm3', role: 'user', text: 'Напиши функцию на TypeScript, которая считает факториал', createdAt: now - 30 * MIN, source: 'text' },
  { id: 'm4', role: 'assistant', text: ANSWER_CODE, tier: 'sol', model: 'gpt-6-sol', createdAt: now - 30 * MIN + 4000, status: 'done' },
  { id: 'm5', role: 'user', text: 'Открой Telegram и выключи компьютер', createdAt: now - 10 * MIN, source: 'voice' },
  {
    id: 'm6',
    role: 'assistant',
    text: '',
    tier: 'sol',
    createdAt: now - 10 * MIN + 2000,
    status: 'error',
    error: 'Превышен лимит запросов OpenAI (429). Подождите немного и повторите.',
    toolCalls: [
      { id: 't2', name: 'open_application', title: 'Открываю «Telegram»', args: { name: 'Telegram' }, status: 'ok', summary: 'Открыто приложение Telegram', startedAt: now - 10 * MIN, endedAt: now - 10 * MIN + 800 },
      { id: 't3', name: 'system_power', title: 'Выключаю компьютер', args: { action: 'shutdown' }, status: 'denied', summary: 'Вы отменили действие', startedAt: now - 10 * MIN + 900, endedAt: now - 10 * MIN + 5000 }
    ]
  }
]

const chats = {
  c1: { ...summaries[0], messages: scenario === 'conversation' ? messages : [] }
}

const listeners = { chat: new Set(), settings: new Set(), state: new Set(), level: new Set(), nav: new Set() }
const sub = (set) => (cb) => {
  set.add(cb)
  return () => set.delete(cb)
}
const emit = (set, payload) => set.forEach((cb) => cb(payload))

const overlayPhase = { 'overlay-listening': 'listening', 'overlay-thinking': 'thinking', 'overlay-speaking': 'speaking', 'overlay-acting': 'acting', 'overlay-error': 'error' }[scenario]
const assistantState = {
  phase: overlayPhase ?? 'idle',
  wakeActive: true,
  updatedAt: now,
  chatId: 'c1',
  transcript: overlayPhase && overlayPhase !== 'listening' ? 'Джарвис, сделай скриншот и ответь на вопросы теста' : undefined,
  response:
    overlayPhase === 'speaking'
      ? 'Готово, сэр. На экране три вопроса. Вопрос 1 — B: Ньютон, сила в СИ измеряется в ньютонах. Вопрос 2 — A: 300 000 км/с, точнее 299 792 км/с. Вопрос 3 — A: I = U / R, это закон Ома для участка цепи. Всё читается чётко.'
      : undefined,
  toolTitle: overlayPhase === 'acting' ? 'Делаю снимок экрана' : undefined,
  error: overlayPhase === 'error' ? 'Не задан API-ключ OpenAI. Откройте Настройки → ИИ.' : undefined
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const api = {
  platform,
  settings: {
    get: async () => settings,
    update: async (patch) => {
      Object.assign(settings, patch)
      return settings
    },
    setApiKey: async () => ({ ...settings, hasApiKey: true, apiKeyHint: 'sk-…zz99' }),
    clearApiKey: async () => ({ ...settings, hasApiKey: false, apiKeyHint: '' }),
    setElevenLabsKey: async () => ({ ...settings, hasElevenLabsKey: true, elevenLabsKeyHint: 'sk_…1234' }),
    clearElevenLabsKey: async () => ({ ...settings, hasElevenLabsKey: false, elevenLabsKeyHint: '' }),
    reset: async () => settings,
    onChanged: sub(listeners.settings)
  },
  models: {
    list: async () => ({ models: ['gpt-6-sol', 'gpt-6-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.1', 'gpt-4.1-mini', 'o4-mini', 'text-embedding-3-large', 'tts-1', 'whisper-1'] }),
    test: async () => ({ ok: true, message: 'Подключение работает. Доступно моделей: 11' })
  },
  chats: {
    list: async () => summaries,
    get: async (id) => chats[id] ?? null,
    create: async () => ({ ...summaries[0], id: 'new', messages: [] }),
    rename: async () => undefined,
    setTier: async () => undefined,
    remove: async () => undefined,
    clearAll: async () => undefined,
    search: async (q) => summaries.filter((s) => s.title.toLowerCase().includes(q.toLowerCase())),
    send: async () => ({ chatId: 'c1', turnId: 'turn-x' }),
    cancel: async () => undefined,
    onEvent: sub(listeners.chat)
  },
  media: {
    captureScreen: async () => screenshot,
    importImage: async () => screenshot,
    pickImage: async () => screenshot
  },
  speech: {
    transcribe: async () => 'Тестовая диктовка',
    synthesize: async () => ({ audio: new Uint8Array(), mime: 'audio/mpeg' }),
    listElevenLabsVoices: async () => ({
      voices: [
        { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'мужской, американский, глубокий' },
        { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'мужской, британский, авторитетный' },
        { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', description: 'женский, шведский, мягкий' }
      ]
    }),
    speak: async () => undefined,
    stop: async () => undefined
  },
  assistant: {
    getState: async () => assistantState,
    onState: sub(listeners.state),
    onLevel: sub(listeners.level),
    listen: async () => undefined,
    setWakeEnabled: async () => undefined
  },
  voice: {
    submit: async () => ({ chatId: 'c1', turnId: 't' }),
    reportPhase: () => undefined,
    reportLevel: () => undefined,
    reportSpeechDone: () => undefined,
    log: () => undefined,
    onSpeak: () => () => undefined,
    onStopSpeaking: () => () => undefined,
    onListen: () => () => undefined,
    onSetWake: () => () => undefined
  },
  app: {
    showMain: async () => undefined,
    hideOverlay: async () => undefined,
    getPermissions: async () => ({ microphone: 'granted', screen: 'denied', accessibility: 'not-determined' }),
    requestPermission: async () => ({ microphone: 'granted', screen: 'denied', accessibility: 'granted' }),
    openPermissionSettings: async () => undefined,
    openExternal: async () => undefined,
    quit: async () => undefined,
    onNavigate: sub(listeners.nav)
  }
}

contextBridge.exposeInMainWorld('jarvis', api)

// Scenario scripting after the renderer has subscribed.
async function script() {
  await delay(400)
  if (scenario === 'conversation') {
    emit(listeners.nav, { view: 'chat', chatId: 'c1' })
    await delay(300)
    const userMessage = { id: 'm7', role: 'user', text: 'А теперь сделай короткое резюме по всем трём вопросам', createdAt: Date.now(), source: 'text' }
    const assistantMessage = { id: 'm8', role: 'assistant', text: '', tier: 'sol', createdAt: Date.now(), status: 'streaming' }
    emit(listeners.chat, { type: 'turn-start', chatId: 'c1', turnId: 'turn1', userMessage, assistantMessage })
    emit(listeners.chat, {
      type: 'tool-start',
      chatId: 'c1',
      turnId: 'turn1',
      messageId: 'm8',
      call: { id: 't9', name: 'get_datetime', title: 'Проверяю дату и время', args: {}, status: 'running', startedAt: Date.now() }
    })
    const text = 'Коротко, сэр: все три ответа — **A или B**, и каждый подтверждён школьной физикой.\n\n- Сила — в ньютонах;\n- Свет — около 300 000 км/с;\n- Закон Ома — '
    for (const part of text.match(/.{1,12}/gs)) {
      emit(listeners.chat, { type: 'delta', chatId: 'c1', turnId: 'turn1', messageId: 'm8', text: part })
      await delay(15)
    }
  } else if (scenario.startsWith('settings-')) {
    const tab = scenario.replace('settings-', '').replace('-eleven', '')
    emit(listeners.nav, { view: 'settings', settingsTab: tab })
  } else if (scenario === 'empty' || scenario === 'onboarding') {
    emit(listeners.nav, { view: 'chat' })
  }
  if (overlayPhase === 'listening' || overlayPhase === 'speaking') {
    let t = 0
    setInterval(() => {
      t += 1
      emit(listeners.level, 0.45 + 0.35 * Math.abs(Math.sin(t / 3)))
    }, 66)
  }
}
void script()
