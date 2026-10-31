// Test / dev overrides from the environment (pure).

export interface JarvisEnv {
  /** JARVIS_USER_DATA: userData directory. */
  userDataDir?: string
  /** JARVIS_API_KEY: OpenAI key injected at startup, not persisted. */
  apiKey?: string
  /** JARVIS_ELEVENLABS_KEY */
  elevenLabsKey?: string
  /** JARVIS_OPENAI_BASE_URL: overrides settings.baseUrl. */
  openaiBaseUrl?: string
  /** JARVIS_E2E=1: no permission prompts, no login-item changes, no first-run notifications, no Keychain. */
  e2e: boolean
  /** JARVIS_DEBUG=1: debug logs. */
  debug: boolean
  /** JARVIS_SHOW_VOICE=1: show the voice-engine window. */
  showVoice: boolean
  /** Vite dev server (electron-vite dev); ignored in packaged builds. */
  rendererUrl?: string
  /** Launched with --hidden (login item on Windows). */
  hiddenArg: boolean
}

export function isTruthy(value: string | undefined): boolean {
  return !!value && /^(1|true|yes|on)$/i.test(value.trim())
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

export function readEnv(env: NodeJS.ProcessEnv, argv: readonly string[], isPackaged: boolean): JarvisEnv {
  return {
    userDataDir: nonEmpty(env.JARVIS_USER_DATA),
    apiKey: nonEmpty(env.JARVIS_API_KEY),
    elevenLabsKey: nonEmpty(env.JARVIS_ELEVENLABS_KEY),
    openaiBaseUrl: nonEmpty(env.JARVIS_OPENAI_BASE_URL),
    e2e: isTruthy(env.JARVIS_E2E),
    debug: isTruthy(env.JARVIS_DEBUG),
    showVoice: isTruthy(env.JARVIS_SHOW_VOICE),
    rendererUrl: isPackaged ? undefined : nonEmpty(env.ELECTRON_RENDERER_URL)?.replace(/\/+$/, ''),
    hiddenArg: argv.includes('--hidden')
  }
}
