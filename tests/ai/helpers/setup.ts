// Builds the real AI services against the mock server with in-memory stores and a real AppBus.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantState, ChatEvent, SettingsPatch, SpeakChunk } from '@shared/types'
import { AppBus } from '../../../src/main/bus'
import { createAiServices, type AiServices, type AiTuning } from '../../../src/main/ai'
import { FakeSecrets, FakeSettings, FakeTools, MemoryChats, MemoryMedia, type FakeTool } from './fakes'
import type { MockServer } from './mock-server'

export const FAST_TUNING: Partial<AiTuning> = {
  retryBaseDelayMs: 5,
  maxRetryDelayMs: 2000,
  requestTimeoutMs: 3000,
  streamIdleTimeoutMs: 3000,
  stateThrottleMs: 15,
  errorResetMs: 60,
  speakingWatchdogMs: 150,
  speakingMsPerChar: 1,
  autoRefreshModels: false,
  platform: 'darwin'
}

export interface TestAi {
  ai: AiServices
  bus: AppBus
  settings: FakeSettings
  secrets: FakeSecrets
  chats: MemoryChats
  media: MemoryMedia
  tools: FakeTools
  userDataDir: string
  chatEvents: ChatEvent[]
  speak: SpeakChunk[]
  states: AssistantState[]
  /** Ordered log of bus traffic: "chat:turn-start", "speak", "state:thinking", "stop-speaking", … */
  timeline: string[]
  cleanup(): void
}

export function createTestAi(
  server: MockServer,
  opts: { settings?: SettingsPatch; tools?: FakeTool[]; tuning?: Partial<AiTuning>; apiKey?: string | null } = {}
): TestAi {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jarvis-ai-test-'))
  const settings = new FakeSettings({ baseUrl: `${server.url}/v1`, ...opts.settings })
  const secrets = new FakeSecrets(opts.apiKey === undefined ? 'sk-test-0123456789abcdef' : opts.apiKey)
  const chats = new MemoryChats()
  const media = new MemoryMedia()
  const tools = new FakeTools(opts.tools ?? [])
  const bus = new AppBus()
  const chatEvents: ChatEvent[] = []
  const speak: SpeakChunk[] = []
  const states: AssistantState[] = []
  const timeline: string[] = []
  bus.on('chat', (ev) => {
    chatEvents.push(structuredClone(ev))
    timeline.push(`chat:${ev.type}`)
  })
  bus.on('speak', (chunk) => {
    speak.push({ ...chunk })
    timeline.push('speak')
  })
  bus.on('assistant-state', (s) => {
    states.push({ ...s })
    timeline.push(`state:${s.phase}`)
  })
  bus.on('stop-speaking', () => timeline.push('stop-speaking'))
  const ai = createAiServices({
    settings,
    secrets,
    chats,
    media,
    tools,
    bus,
    userDataDir,
    tuning: { ...FAST_TUNING, ...opts.tuning }
  })
  return {
    ai,
    bus,
    settings,
    secrets,
    chats,
    media,
    tools,
    userDataDir,
    chatEvents,
    speak,
    states,
    timeline,
    cleanup: () => rmSync(userDataDir, { recursive: true, force: true })
  }
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, label = 'condition'): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Resolves when the turn ended (turn-end or turn-error). */
export function waitTurnEnd(t: TestAi, turnId: string, timeoutMs = 5000): Promise<ChatEvent> {
  return waitFor(
    () =>
      t.chatEvents.find(
        (e) => (e.type === 'turn-end' || e.type === 'turn-error') && 'turnId' in e && e.turnId === turnId
      ),
    timeoutMs,
    `end of turn ${turnId}`
  )
}
