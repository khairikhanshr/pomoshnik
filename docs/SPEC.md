# Jarvis — engineering spec

Jarvis is a voice-first AI assistant desktop app for **macOS and Windows** (one Electron codebase, two builds).
UI language: **Russian**. The assistant answers in the user's language (Russian by default).

User-facing goals (from the owner, verbatim intent):
1. App named "Jarvis" like in Iron Man, with a Jarvis-like voice.
2. Runs in the background; when the user says its name ("Джарвис" / "Jarvis") it responds and answers questions.
3. Opening the app shows chats with history.
4. Settings: paste an OpenAI API key; three model tiers **Luna, Terra, Sol** (OpenAI GPT-5.6/GPT-6 tiers); choose a tier in settings **or directly in the chat**.
5. Voice control of the computer, e.g. "сделай скриншот экрана и скажи ответ по каждому из тестов" (screenshot → answer every test question on screen), "открой Telegram", and general computer control.
6. Builds for macOS and Windows.

Voice note: we must NOT clone or imitate a real actor's voice. We provide a *style* (calm, refined British AI butler) through
OpenAI TTS `instructions` (see `JARVIS_VOICE_INSTRUCTIONS` in `src/shared/defaults.ts`), with selectable voices and a system-voice fallback.

## Stack and hard constraints

- Electron 45, electron-vite 6 (Vite 8 / rolldown), React 19, TypeScript 5.9 (strict), Vitest 5, electron-builder 26.
- **No native Node modules** anywhere in the shipped app (we cross-build the Windows installer on a Mac). Use OS tools
  (`osascript`/JXA on macOS, `powershell.exe` on Windows), Electron APIs, and WASM in renderers.
- All npm packages are **devDependencies** (Vite bundles main, preload and renderers). `package.json` has no runtime `dependencies`.
  Do **not** run `npm install`/`npm uninstall` — dependencies are preinstalled. If you truly need a package, say so in your report.
- Main process output is CommonJS (no `"type": "module"`), preload is sandboxed CommonJS.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for all windows. The renderer only talks to main via `window.jarvis` (`src/shared/ipc.ts`).
- The API key never leaves the main process (renderers see `hasApiKey` / `apiKeyHint` only). Never log keys (use `redact` from `src/main/log.ts`).
- The environment variable `ELECTRON_RUN_AS_NODE=1` is set in this dev shell (VS Code). Any command that launches Electron must unset it:
  `env -u ELECTRON_RUN_AS_NODE npx electron-vite build|dev|preview`, `env -u ELECTRON_RUN_AS_NODE npx electron .`.

### Commands
- Typecheck: `npm run typecheck` (or `typecheck:node` / `typecheck:web`).
- Unit tests: `npx vitest run <path>` (config `vitest.config.ts`, tests in `tests/**`).
- Build: `env -u ELECTRON_RUN_AS_NODE npx electron-vite build` → `out/`.
- Package: `npm run dist:mac` / `npm run dist:win` → `release/`.

## Layout and ownership

| Path | Owner | Notes |
|---|---|---|
| `src/shared/types.ts`, `src/shared/ipc.ts`, `src/shared/defaults.ts` | contract | additive changes only (new optional fields/types); never rename/remove |
| `src/main/services.ts`, `src/main/tools/types.ts`, `src/main/bus.ts`, `src/main/log.ts`, `src/main/util/fs.ts` | contract | same rule |
| `src/main/index.ts`, `src/main/app/**`, `src/main/store/**`, `src/main/ipc/**`, `src/main/voice-bridge.ts`, `src/preload/**` | main-core | |
| `src/main/ai/**`, `src/shared/speech-text.ts` | ai | `src/main/ai/index.ts` exports `createAiServices` (signature fixed) |
| `src/main/tools/**` (except `types.ts`) | tools | `src/main/tools/index.ts` exports `createToolRegistry`, `captureScreen` (signatures fixed) |
| `src/renderer/voice.html`, `src/renderer/src/voice/**`, `src/shared/wake.ts`, `scripts/fetch-models.mjs`, `src/renderer/public/**` | voice | |
| `src/renderer/index.html`, `src/renderer/overlay.html`, `src/renderer/src/main/**`, `src/renderer/src/overlay/**`, `src/renderer/src/common/**` | ui | |
| `electron-builder.yml`, `build/**`, `resources/**`, `scripts/gen-icons.mjs`, `README.md`, `docs/USER_GUIDE.md` | packaging | |
| `tests/<area>/**` | the area's owner | |

## Runtime architecture

Windows (all `BrowserWindow`s load the renderer via the privileged `app://` protocol in production,
`process.env.ELECTRON_RENDERER_URL` in dev):
- **main** (`index.html`): chats + settings. Closing hides it (app keeps running in tray/menu bar).
- **overlay** (`overlay.html`): small frameless transparent always-on-top HUD (`focusable: false`, `skipTaskbar`,
  visible on all workspaces) with the animated "arc reactor" orb, status, transcript and streaming reply. Shown while the
  assistant is active, auto-hides ~5 s after returning to idle. Clicking it opens the main window on that chat.
- **voice** (`voice.html`): hidden, `backgroundThrottling: false`; the voice engine (mic, VAD, wake word, TTS playback).

Main process services (interfaces in `src/main/services.ts`, wired in `src/main/index.ts`):
SettingsStore, SecretStore, ChatStore, MediaStore, WindowService, ModelCatalog, SpeechService, AssistantService,
ToolRegistry, AppBus (`src/main/bus.ts`). Bus events are forwarded to windows by the IPC layer:
`chat` → `IPC_EVENT.chatEvent` (all windows), `assistant-state` → `IPC_EVENT.assistantState` (all), `level` → `IPC_EVENT.level`
(overlay + main), `speak` → `IPC_EVENT.voiceSpeak` (voice), `stop-speaking` → `IPC_EVENT.voiceStopSpeaking` (voice),
`listen` → `IPC_EVENT.voiceListen` (voice), settings changes → `IPC_EVENT.settingsChanged` (all, as PublicSettings).

### Protocols
- `app://jarvis/<path>` serves `out/renderer/<path>` (production). Responses carry
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Resource-Policy: same-origin` and correct MIME types (`.wasm` → `application/wasm`, `.mjs`/`.js` → `text/javascript`,
  `.onnx` → `application/octet-stream`, `.json`, `.html`, `.css`, fonts…). Path traversal must be impossible.
  Register with `protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard, secure, supportFetchAPI, corsEnabled, stream } }])` before `ready`.
- `jarvis-media://image/<id>` serves MediaStore images with `Cross-Origin-Resource-Policy: cross-origin` and
  `Access-Control-Allow-Origin: *` (works in dev from `http://localhost` and in prod). Ids are validated (`^[a-z0-9]+$`).

### Startup (main-core)
- Single instance lock (second launch → show main window).
- `app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')` (voice window plays audio without a gesture).
- Test/dev env overrides: `JARVIS_USER_DATA` (userData dir), `JARVIS_API_KEY` (key injected at startup, not persisted),
  `JARVIS_OPENAI_BASE_URL` (overrides settings.baseUrl), `JARVIS_ELEVENLABS_KEY`, `JARVIS_ELEVENLABS_BASE_URL`, `JARVIS_E2E=1` (no permission prompts, no login-item changes, no
  first-run notifications), `JARVIS_AUTO_CONFIRM=allow|deny` (tool confirmations auto-answered), `JARVIS_DEBUG=1` (debug logs),
  `JARVIS_SHOW_VOICE=1` (show the voice window for debugging).
- Logs: `initLogFile(<userData>/logs)`.
- Permissions: `session.defaultSession.setPermissionRequestHandler` / `setPermissionCheckHandler` allow `media` (audio)
  for our own origins (`app://jarvis`, dev server URL) and deny everything else. On macOS ask for the microphone with
  `systemPreferences.askForMediaAccess('microphone')` before the voice engine starts (skip when `JARVIS_E2E`).
- While the wake engine is on, keep `powerSaveBlocker.start('prevent-app-suspension')` (prevents App Nap from starving audio).
- Tray (menu bar on macOS — template image; colored icon on Windows): Открыть Джарвис · Слушать (hotkey) ·
  Голосовая активация ✓ · Модель по умолчанию ▸ Luna/Terra/Sol · Настройки… · Выход. Clicking the tray icon on Windows opens the main window.
- Global shortcuts from settings (`hotkeyVoice` → bus `listen` + show overlay; `hotkeyWindow` → toggle main window). Re-register on change; invalid accelerators are logged, not fatal.
- Launch at login: `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`; start hidden when
  `startHidden`, `--hidden` in argv, or `app.getLoginItemSettings().wasOpenedAtLogin`.
- macOS Dock: hide the Dock icon when the main window is hidden and `showInDock` is false.
- Main window: 1180×760 (min 860×560), dark background `#05080d`, macOS `titleBarStyle: 'hiddenInset'` +
  `trafficLightPosition { x: 18, y: 20 }`, Windows `titleBarStyle: 'hidden'` +
  `titleBarOverlay { color: '#05080d', symbolColor: '#9fe9ff', height: 52 }` (both aligned with the UI's 52 px header).
  First close → system notification "Джарвис продолжает работать в фоне" (once).
- Quit flushes the chat store.
- `speech:speak(text)` (replay a message) → `toSpeakableText` + `splitSentences` from `src/shared/speech-text.ts`, emitted as bus `speak`
  chunks with a synthetic turnId `replay-<id>` (last chunk `final: true`). `speech:stop` → bus `stop-speaking`.
- `createAiServices({ ..., userDataDir })` — pass `app.getPath('userData')`.

### Settings & secrets
- `userData/settings.json` (`Settings`, defaults in `DEFAULT_SETTINGS`), migrated by `version`. Validation: unknown keys dropped,
  wrong types replaced with defaults, numbers clamped (ttsSpeed 0.5–2, followUpSeconds 0–30, commandTimeoutSeconds 3–30,
  maxSpokenChars 100–5000), `baseUrl` trimmed without trailing slash, `wakePhrases` lower-cased, trimmed, non-empty, max 10.
- `userData/secrets.json` holds `{ openaiApiKey, elevenlabsKey }` (each base64 of `safeStorage.encryptString`). If
  `safeStorage.isEncryptionAvailable()` is false, store with a `plain:` prefix and log a warning. `JARVIS_API_KEY` / `JARVIS_ELEVENLABS_KEY` override.
- Extra validation: `elevenStability`/`elevenSimilarity` clamped 0–1, `elevenVoiceId` trimmed and limited to `[A-Za-z0-9]{0,64}`,
  `ttsProvider` one of openai/elevenlabs/system.
- PublicSettings = Settings + `hasApiKey`, `apiKeyHint`, `platform`, `appVersion`, `resolvedModels` (from ModelCatalog).
- On API key or baseUrl change → `models.refresh()`; broadcast new PublicSettings.

### Chats
- `userData/chats/index.json` (summaries) + `userData/chats/<id>.json` (full chat). Atomic writes (`writeJsonAtomic`), debounced ≤ 300 ms
  per chat, `flush()` on quit. Corrupt files are skipped (logged), never crash the app.
- New chat title "Новый чат" until the AI module sets a generated title (rename + `chat-updated` event).
- Voice requests go to the most recent voice chat if it was updated < 15 min ago, else a new chat with `source: 'voice'`.
- Deleting a chat also deletes its media files that no other chat references (best effort).

## AI module (`src/main/ai`)

`createAiServices(deps)` returns `{ models, speech, assistant }`.

### HTTP
- Raw `fetch` (no SDK). Base URL from settings (`JARVIS_OPENAI_BASE_URL` overrides), `Authorization: Bearer <key>`.
- Errors → Russian messages: no key ("Не задан API-ключ OpenAI. Откройте Настройки → ИИ."), 401, 403 (region/permissions),
  404/model_not_found ("Модель «…» недоступна для вашего ключа. Выберите другую модель или режим «Авто»."), 429 (rate limit vs
  insufficient_quota), 5xx, network/timeout. Retries: 429 (not quota) / 5xx / network — 2 retries with backoff (respect `retry-after`).
- SSE parser for streaming (handles `data:` lines split across chunks, `event:` lines, `[DONE]`).

### Tier → model (`ModelCatalog`)
- Explicit `settings.tiers[t].model` wins. `'auto'` → among cached `GET /models` ids matching `TIER_MODEL_PATTERN`
  (`gpt-<version>-<tier>`), the highest version (numeric compare: 6.1 > 6 > 5.6). Else `FALLBACK_TIER_MODELS`.
- Model list cached in memory + `userData/models-cache.json` (1 h TTL) so resolution works at startup offline.

### Responses API (default, `apiMode: 'responses'`)
`POST /responses`, `stream: true`, `store: false`, `include: ["reasoning.encrypted_content"]`, `instructions` = persona prompt,
`input` = conversation items, `tools` = function tools (`{ type: 'function', name, description, parameters, strict: false }`)
plus `{ type: 'web_search' }` when `settings.webSearch`, `reasoning: { effort }` unless effort is `'auto'`.
- History items: user → `{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: <data URL>, detail }] }`;
  assistant → `{ role: 'assistant', content: <text> }`. Only images of the last `LIMITS.historyImageMessages` messages that have
  images are sent; older images become the text "[изображение]". Prior tool calls are summarized into the assistant text
  (e.g. "[Действия: Открыл Telegram ✓]") — never replay old function_call items.
- Within one turn: append every output item of the previous response (reasoning items with encrypted content,
  function_call items) verbatim, then `{ type: 'function_call_output', call_id, output }` per call. Images produced by tools are sent as an
  extra user message right after the outputs: `[{ type: 'input_text', text: 'Снимок экрана (результат take_screenshot):' }, { type: 'input_image', … }]`.
- Stream events used: `response.output_text.delta`, `response.output_item.done`, `response.completed`, `response.incomplete`,
  `response.failed`, `error`. Text deltas → bus `chat` delta events + speech chunker.
- Adaptive fallbacks on HTTP 400 (retry the same step once, remember per model for the session): mentions reasoning/effort → drop
  `reasoning`; mentions web_search / tool type → drop web_search; mentions include/encrypted → drop include; image `detail`
  'original' rejected → use 'high'.

### Chat Completions (`apiMode: 'chat'`)
`POST /chat/completions`, `stream: true`, messages with `system` persona, image parts `{ type: 'image_url', image_url: { url, detail } }`,
`tools: [{ type: 'function', function: { name, description, parameters } }]`, `reasoning_effort` unless 'auto' (drop on 400).
Accumulate streamed `tool_calls` by index. Tool images → extra user message after the `tool` messages.

### Agent loop (`AssistantService`)
- One active turn; `send()` cancels a running turn first. Creates the chat if needed (tier = req.tier ?? (voice ? voiceTier : defaultTier)),
  appends user message (with images) and an assistant message (`status: 'streaming'`), emits `turn-start`, returns `{ chatId, turnId }`.
- Up to `LIMITS.maxToolSteps` model calls. For each function call: `tools.describe` → `tool-start` event + state `phase: 'acting', toolTitle`;
  `tools.execute`; `tool-end`; images → `image` event + attached to the assistant message. Unknown/invalid JSON args → error output to the model.
- Assistant state: `thinking` at start (`transcript` = user text, `response` = ''), `response` updated (throttled ~8/s) while streaming,
  `acting` during tools, at the end `idle` unless the reply is being spoken (then the voice window reports `speaking`). Errors → `turn-error`,
  message `status: 'error'`, state `phase: 'error', error`, and for spoken turns a spoken short error.
- Cancel → abort fetch + tools (AbortSignal), message `status: 'cancelled'`, stop speaking.
- Title: after the first exchange in a chat titled "Новый чат", ask the Luna tier (no tools, effort low/'auto') for a ≤ 5-word Russian
  title; fallback = first 48 chars of the user text.
- Speaking: `speak = req.speak ?? (speakMode === 'always' || (speakMode === 'voice' && source === 'voice'))`. A speech chunker turns the
  streaming markdown into plain speakable sentences (`src/shared/speech-text.ts`: strip markdown/code/URLs/emoji, code blocks → "Код —
  в чате.") and emits bus `speak` chunks (`{ turnId, seq, text, final }`) at sentence boundaries (first chunk as early as possible, ≥ ~40
  chars), stops after `maxSpokenChars` adding "Остальное — в чате, {userTitle}.", and always ends with a `final: true` chunk.
- Persona (`src/main/ai/persona.ts`): J.A.R.V.I.S. — polite, witty, concise British-butler style AI that lives on the user's computer,
  addresses the user as `settings.userTitle` (and `userName` if set), answers in the user's language. Includes current local date/time,
  OS, and the rules: voice replies 1–3 short sentences without markdown, lists or code; act with tools instead of describing steps; for
  screen questions/tests: take a screenshot, then answer **every** question in order ("Вопрос 1 — B: …, коротко почему"), say if something
  is unreadable and use the zoom region; for opening apps use `open_application` (translate localized names, e.g. "калькулятор" →
  Calculator/Калькулятор); confirm actions briefly ("Готово, сэр."); never invent tool results; dangerous actions only on explicit request.
  `settings.customInstructions` is appended.
- `testConnection`: GET /models (fallback: tiny Luna request) → "Подключение работает. Доступно моделей: N".

### Speech (`SpeechService`)
- `transcribe`: multipart `POST /audio/transcriptions` (`model` = sttModel, `file` with proper filename/extension for the mime,
  `language` when set, `prompt` biasing vocabulary: "Джарвис, Jarvis, …"). Fallback chain on model errors: sttModel → gpt-4o-transcribe → whisper-1.
- `synthesize` routes by `settings.ttsProvider`:
  - `openai`: `POST /audio/speech` `{ model: ttsModel, voice, input, instructions (only for gpt-4o-mini-tts-like models), speed, response_format: 'mp3' }`.
    Fallback on model errors: → tts-1 (no instructions). Input capped at 4000 chars.
  - `elevenlabs`: `POST {JARVIS_ELEVENLABS_BASE_URL || DEFAULT_ELEVENLABS_BASE_URL}/v1/text-to-speech/{elevenVoiceId}?output_format=mp3_44100_128`,
    headers `xi-api-key`, JSON `{ text, model_id: elevenModel, voice_settings: { stability, similarity_boost, use_speaker_boost: true,
    speed: ttsSpeed clamped to 0.7–1.2 } }`. Russian errors: no key ("Не задан ключ ElevenLabs…"), no voice id ("Не выбран голос ElevenLabs…"),
    401, 404 voice not found, 422 validation (message from the body), 429 / quota_exceeded ("Лимит ElevenLabs исчерпан"). Input capped at 4000 chars.
  - `system`: never called (the voice window speaks with `speechSynthesis`); throw a clear error if it is.
- `listElevenLabsVoices`: `GET {base}/v1/voices` with `xi-api-key` → `ElevenLabsVoice[]` (`voice_id`, `name`, description built from
  `labels` (gender, accent, age, description, use_case), `preview_url`), sorted by name.

The ElevenLabs option exists so the owner can use any voice from their own ElevenLabs account. The app never clones voices itself.

## Tools (`src/main/tools`)

`createToolRegistry(host)` → `ToolRegistry & { dispose }`. When `settings.computerControl` is false only harmless tools remain
(`get_system_info`, `get_datetime`, `set_reminder`, `list_reminders`, `cancel_reminder`). `run_command` only when `allowShellCommands`.
When the built-in `web_search` (Responses API) is on, the AI module exposes our browser-opening `web_search` function to the model as
`open_web_search` and maps calls back, so `describe()` / `execute()` always receive the registry name.
Each tool: English description + JSON schema, Russian `describe()` title, Russian `summary`.

Platform helpers (`exec.ts`): spawn with timeout + AbortSignal, never through a shell with interpolated user strings.
- macOS: `osascript` with arguments passed via `on run argv` (no string interpolation of user data into AppleScript), JXA (`-l JavaScript`)
  for CoreGraphics mouse/keyboard events and media keys.
- Windows: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <UTF-16LE base64>`; user data is passed
  through an environment variable (`JARVIS_ARGS` = JSON) and parsed inside the script (`ConvertFrom-Json`). Output UTF-8
  (`[Console]::OutputEncoding = [Text.Encoding]::UTF8`). Win32 calls via `Add-Type` C# snippets (SetCursorPos/mouse_event/keybd_event/
  SendInput, IAudioEndpointVolume). Make the script process DPI-aware before using coordinates.

Tool set (names are the API contract with the model):
- `take_screenshot { display?: 'cursor'|'primary'|'all', region?: { x, y, width, height } }` — Electron `desktopCapturer` at native resolution,
  Jarvis windows hidden while capturing (`windows.withUiHidden`), downscaled to `LIMITS.screenshotMaxSide`, saved to MediaStore, returned as
  image + text describing image size and the coordinate system (for `mouse`). `region` crops (zoom) in the coordinates of the previous
  screenshot. macOS: if screen permission is not granted, return an explanatory error (and open the Privacy pane).
- `open_application { name }` — macOS: scan /Applications, /System/Applications(/Utilities), ~/Applications, /Applications/Utilities for
  `.app` (cache 5 min), fuzzy match (case/diacritics-insensitive, includes localized display names via `kMDItemDisplayName`/bundle names when cheap),
  `open -a <path>`. Windows: `Get-StartApps` (Name, AppID) cached, fuzzy match, launch `explorer.exe shell:AppsFolder\<AppID>`;
  fallback `Start-Process <name>`. Return the matched app or the top 5 suggestions when ambiguous / not found.
- `list_applications { query? }` — installed apps (names), filtered.
- `close_application { name, force? }` — macOS `quit app` via osascript argv (force → `kill`); Windows `CloseMainWindow()` then (force)
  `Stop-Process`. Force asks for confirmation.
- `list_running_applications {}`, `focus_application { name }`.
- `open_url { url }` (http/https/mailto only, `shell.openExternal`), `web_search { query, engine?: 'google'|'yandex'|'bing'|'duckduckgo' }` (opens the browser).
- `open_path { path }` — files/folders (`~`, Desktop/Downloads/Documents aliases in Russian and English), `shell.openPath`.
- `list_directory { path }`, `read_text_file { path, maxChars? }` (≤ 1 MB, text only), `write_text_file { path, content, overwrite? }` (confirm when overwriting).
- `type_text { text }` — clipboard paste (save → set → Cmd/Ctrl+V → restore after ~400 ms), works for Cyrillic.
- `press_keys { keys }` — e.g. "cmd+shift+4", "ctrl+c", "enter", "alt+tab", "win+d"; cross-platform key names ("mod" = Cmd on mac / Ctrl on Windows).
- `mouse { action: 'move'|'click'|'double_click'|'right_click'|'scroll', x?, y?, scroll_dy? }` — coordinates in the pixel space of the latest
  screenshot (mapped back to screen coordinates incl. display offset and scale factor). macOS requires Accessibility permission
  (`systemPreferences.isTrustedAccessibilityClient(true)` prompts); return a helpful error when missing.
- `set_volume { level?: 0-100, change?: number, mute?: boolean }`, `media_control { action: 'play_pause'|'next'|'previous' }`.
- `system_power { action: 'lock'|'sleep'|'display_off'|'restart'|'shutdown'|'logout' }` — restart/shutdown/logout require confirmation.
- `clipboard { action: 'read'|'write', text? }`.
- `get_system_info {}` (OS, versions, CPU, memory, disk free, battery, uptime), `get_datetime {}`.
- `set_reminder { in_seconds? , at?: ISO, text }`, `list_reminders {}`, `cancel_reminder { id }` — persisted in `userData/reminders.json`,
  survive restarts; on fire: Electron `Notification` + bus `speak` (synthetic turnId `reminder-<id>`) + overlay.
- `run_command { command, cwd? }` — runs in the user's shell (zsh on mac, PowerShell on Windows), 60 s timeout, output truncated;
  ALWAYS confirmation (unless confirmDangerous is off), the dialog shows the exact command.
Confirmations (`confirm.ts`): native `dialog.showMessageBox` (Russian buttons "Разрешить" / "Отмена", default Cancel), resolves false on abort.
`JARVIS_AUTO_CONFIRM` overrides for tests. Before showing a dialog for a voice turn, emit a short spoken prompt
("Требуется ваше подтверждение, сэр.") via bus `speak`.

`captureScreen(host)` (composer button) = `take_screenshot` for the cursor display, returns the ImageRef.

## Voice engine (`src/renderer/src/voice`, hidden window)

- Mic: `getUserMedia({ audio: { deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`, restarted when
  `micDeviceId` changes or the device disappears (retry with backoff; report `engineError`).
- VAD: `@ricky0123/vad-web` (Silero) with assets served from `public/vad/` (worklet, onnx) and onnxruntime-web WASM from `public/ort/`.
- Wake detection on each VAD speech segment (≤ `LIMITS.maxWakeSegmentSeconds`):
  - `local`: Whisper (transformers.js, model files bundled in `public/models/…`, loaded with remote models disabled) in a **Web Worker**,
    on the first ~3 s of the segment; one inference at a time (drop stale segments).
  - `cloud`: `window.jarvis.speech.transcribe(wav)` for the segment.
  - Match with `src/shared/wake.ts` (`matchWake(transcript, phrases, sensitivity)` → `{ matched, remainder }`): normalize (lower-case, ё→е,
    strip punctuation), fuzzy match words against phrases + known misrecognitions (джарвиз, джервис, жарвис, jarvis, jervis, …) with
    Levenshtein tolerance by sensitivity; the wake word must be among the first 3 words.
- After a wake word: if the remainder has content → the segment is the command: transcribe the **whole segment** with the cloud STT (more
  accurate; fall back to the local transcript), strip the wake word, `voice.submit(text)`. Bare wake word → acknowledge (`acknowledge`
  setting: synthesized two-tone chime via WebAudio and/or a short spoken "Да, {userTitle}?"), phase `listening`, the next segment within
  `commandTimeoutSeconds` is the command.
- Push-to-talk (`onListen`): stop speaking, chime, `listening` → next segment is the command (no wake word needed).
- Follow-up: after speech of a turn finished, stay `listening` for `followUpSeconds`; speech in that window is a command.
- While speaking: only a wake word (barge-in) is acted upon → stop playback, then handle as above. Ignore segments whose transcript
  matches what is being spoken (echo guard).
- TTS playback queue for `SpeakChunk`s: `openai` / `elevenlabs` → prefetch `speech.synthesize(text)` (main routes to the provider) for up to 2 chunks ahead, play in seq order via WebAudio;
  `system` (or OpenAI failure) → `speechSynthesis` with the best voice for the text language (ru-RU: Milena/Yuri/Pavel/Irina…; en-GB: Daniel…) or
  `systemVoiceName`. Report `speaking`, output level, and `reportSpeechDone({ turnId, interrupted })` when the final chunk finished.
- Report phases with `voice.reportPhase` and mic/output level (~15/s) with `voice.reportLevel`. Never crash: every failure → `engineError`
  + `voice.log`.
- WAV encoder: 16 kHz mono PCM16 (`audio/wav`).

## UI (`src/renderer/src/main`, `src/renderer/src/overlay`)

Visual style: "Iron Man HUD" — deep navy/black (`#05080d`, panels `#0a121b`), cyan accent `#3ad8ff` with soft glow, thin 1px
borders `rgba(58,216,255,.18)`, subtle grid/scanline background, arc-reactor orb as logo/avatar. Fonts: `@fontsource/exo-2`
(Cyrillic) for UI, `@fontsource/jetbrains-mono` for code. All strings in Russian (keep them in `src/renderer/src/common/strings.ts`).
Must work in light of both platforms (mac traffic lights inset, Windows titleBarOverlay area on the right, 40 px drag region:
`-webkit-app-region: drag`, interactive elements `no-drag`).

Main window:
- Sidebar: logo "J.A.R.V.I.S.", "Новый чат" button, search, chat list grouped (Сегодня / Вчера / Последние 7 дней / Ранее) with
  voice-chat icon, rename/delete via context menu or hover actions; footer: wake status pill (Слушаю «Джарвис» / Выключено, click toggles),
  settings button.
- Chat header: editable title, **tier switch Luna / Terra / Sol** (segmented control with icons; tooltip with resolved model id), speak toggle.
- Messages: user right, Jarvis left with orb avatar; markdown (react-markdown + remark-gfm, no raw HTML), code blocks with copy button,
  tool-call chips (running spinner / ✓ / ✕ / denied) with title + summary, screenshot thumbnails (click → lightbox), streaming caret,
  error card with "Повторить", per-message actions (copy, speak).
- Composer: auto-growing textarea (Enter send, Shift+Enter newline), attach image (picker / paste / drag-drop), "Скриншот" button
  (attach current screen), mic dictation (MediaRecorder → `speech.transcribe` → inserted into the textarea), send / stop button.
- Empty state: big orb + greeting + example prompts ("Сделай скриншот и ответь на вопросы теста", "Открой Telegram", "Какая погода
  сейчас в Алматы?", "Поставь напоминание через 10 минут").
- Settings (full view with tabs): **ИИ** (API key field with show/hide + save + "Проверить подключение", base URL, API mode, per-tier model
  select ("Авто (новейшая)" + ids from `models.list`, plus free text) and reasoning effort, default tier, voice tier, web search, image detail,
  custom instructions, how to address the user), **Голос** (provider OpenAI / ElevenLabs / Системный; OpenAI: voice, TTS model, speed,
  style instructions with "Стиль Джарвиса" reset button; ElevenLabs: API key field (save/clear, masked hint), voice dropdown from
  `speech.listElevenLabsVoices()` with description + manual Voice ID field, model select (`ELEVENLABS_MODELS`), stability and similarity
  sliders, a hint "используйте голоса, на которые у вас есть права"; System: OS voice select from `speechSynthesis.getVoices()`;
  "Прослушать" for every provider, speakMode, maxSpokenChars, STT model + language), **Активация** (wake engine
  local/cloud/off with explanations, wake phrases chips, sensitivity, follow-up, command timeout, acknowledge, mic device select + live level
  meter, hotkeys), **Управление ПК** (computer control, confirmations, shell commands, macOS permission rows with status + "Разрешить"/"Открыть
  настройки"), **Общие** (launch at login, start hidden, overlay on/off + position, show in Dock (mac only), clear history, reset settings),
  **О программе** (version, short guide).
- First run (no API key): onboarding card leading to Settings → ИИ.
- React to `app.onNavigate`, `chats.onEvent`, `settings.onChanged`, `assistant.onState`.

Overlay: 380×(120..320) px panel, orb animated by `assistant.onLevel` and phase (idle dim pulse, listening bright pulse, thinking
rotating rings, speaking level-reactive), status label (Слушаю… / Распознаю… / Думаю… / toolTitle / Говорю…), transcript (1 line),
streaming reply (max ~6 lines, fades), close ✕ (hideOverlay), click → `app.showMain({ chatId })`. Transparent background.

## Packaging

- macOS: dmg + zip for arm64 and x64, ad-hoc signed (no Developer ID), Info.plist usage strings (mic, Apple Events, screen, accessibility).
- Windows: NSIS x64 installer (per-user, choose dir, desktop + start menu shortcuts, Russian + English installer languages).
- Icons: arc-reactor style generated by `scripts/gen-icons.mjs` (`build/icon.png|icns|ico`, tray icons in `resources/tray`:
  `trayTemplate.png` + `@2x` (macOS template, black on transparent), `tray.png`/`tray.ico` (Windows, colored)).
- In the packaged app, tray icons are at `process.resourcesPath/tray`, in dev at `resources/tray`.
