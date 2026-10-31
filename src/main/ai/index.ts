// ENTRY POINT CONTRACT (owned by the AI module): keep these exported signatures.
import type { AppBus } from '../bus'
import { createLogger } from '../log'
import type {
  AssistantService,
  ChatStore,
  MediaStore,
  ModelCatalog,
  SecretStore,
  SettingsStore,
  SpeechService
} from '../services'
import type { ToolRegistry } from '../tools/types'
import { AssistantServiceImpl, DEFAULT_ASSISTANT_TUNING, type AssistantTuning } from './assistant'
import { ChatCompletionsProvider } from './chat-completions'
import { DEFAULT_HTTP_TUNING, OpenAiClient, type HttpTuning } from './http'
import { ModelCatalogService } from './models'
import { ResponsesProvider } from './responses'
import { SpeechServiceImpl } from './speech'

export interface AiTuning extends HttpTuning, AssistantTuning {
  modelsCacheTtlMs: number
  /** ModelCatalog.resolve() refreshes a stale model list in the background. */
  autoRefreshModels: boolean
}

export interface AiDeps {
  settings: SettingsStore
  secrets: SecretStore
  chats: ChatStore
  media: MediaStore
  tools: ToolRegistry
  bus: AppBus
  /** app.getPath('userData'); used for the model-list cache. */
  userDataDir: string
  /** Optional overrides of timings / platform (tests); production uses the defaults. */
  tuning?: Partial<AiTuning>
}

export interface AiServices {
  models: ModelCatalog
  speech: SpeechService
  assistant: AssistantService
}

export function createAiServices(deps: AiDeps): AiServices {
  const tuning: AiTuning = {
    ...DEFAULT_HTTP_TUNING,
    ...DEFAULT_ASSISTANT_TUNING,
    modelsCacheTtlMs: 60 * 60 * 1000,
    autoRefreshModels: true,
    ...deps.tuning
  }
  const log = createLogger('ai')
  const http = new OpenAiClient({ settings: deps.settings, secrets: deps.secrets, tuning, log })
  const models = new ModelCatalogService({
    http,
    settings: deps.settings,
    secrets: deps.secrets,
    userDataDir: deps.userDataDir,
    log,
    ttlMs: tuning.modelsCacheTtlMs,
    autoRefresh: tuning.autoRefreshModels
  })
  const speech = new SpeechServiceImpl({
    http,
    settings: deps.settings,
    secrets: deps.secrets,
    tuning,
    log: createLogger('speech')
  })
  const assistant = new AssistantServiceImpl({
    settings: deps.settings,
    chats: deps.chats,
    media: deps.media,
    tools: deps.tools,
    bus: deps.bus,
    models,
    http,
    providers: { responses: new ResponsesProvider(http, log), chat: new ChatCompletionsProvider(http, log) },
    log: createLogger('assistant'),
    tuning
  })
  return { models, speech, assistant }
}
