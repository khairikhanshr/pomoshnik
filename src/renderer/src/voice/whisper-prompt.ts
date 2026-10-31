// Decoder prompt for Whisper in transformers.js: it has no language detection (it would assume English), so the
// language token is chosen by the model among the allowed languages, then <|transcribe|> <|notimestamps|> follow.
// Shared by the Whisper worker and the keyword-spotting test.
import { LogitsProcessor, LogitsProcessorList, type Tensor } from '@huggingface/transformers'

export interface WhisperGenerationConfig {
  decoder_start_token_id: number
  no_timestamps_token_id: number
  lang_to_id: Record<string, number>
  task_to_id: Record<string, number>
}

export class PromptGate extends LogitsProcessor {
  detected: number | null = null

  constructor(
    private readonly languageIds: number[],
    private readonly taskId: number,
    private readonly noTimestampsId: number
  ) {
    super()
  }

  _call(inputIds: bigint[][], logits: Tensor): Tensor {
    for (let i = 0; i < inputIds.length; i++) {
      const step = inputIds[i].length
      if (step > 3) continue
      const data = (logits as unknown as Tensor[])[i].data as Float32Array
      let forced = step === 2 ? this.taskId : this.noTimestampsId
      if (step === 1) {
        forced = this.languageIds[0]
        for (const id of this.languageIds) if (data[id] > data[forced]) forced = id
        this.detected = forced
      }
      data.fill(Number.NEGATIVE_INFINITY)
      data[forced] = 0
    }
    return logits
  }
}

export function isWhisperGenerationConfig(gc: unknown): gc is WhisperGenerationConfig {
  const c = gc as Partial<WhisperGenerationConfig> | null
  return !!c?.lang_to_id && !!c.task_to_id?.transcribe && typeof c.no_timestamps_token_id === 'number'
}

/** Pipeline call options for one transcription plus the gate that records the chosen language. */
export function promptOptions(gc: WhisperGenerationConfig, languages: string[], maxNewTokens: number) {
  const ids = languages
    .map((l) => gc.lang_to_id[`<|${l.toLowerCase()}|>`])
    .filter((id): id is number => typeof id === 'number')
  if (!ids.length) ids.push(gc.lang_to_id['<|en|>'])
  const gate = new PromptGate([...new Set(ids)], gc.task_to_id.transcribe, gc.no_timestamps_token_id)
  // A fresh list per call: Whisper's generate() appends its own processors to the list it is given.
  const processors = new LogitsProcessorList()
  processors.push(gate)
  const options = {
    decoder_input_ids: [gc.decoder_start_token_id],
    logits_processor: processors,
    max_new_tokens: maxNewTokens + 3,
    return_timestamps: false
  }
  const language = (): string | null => {
    const token = Object.entries(gc.lang_to_id).find(([, id]) => id === gate.detected)?.[0]
    return token ? token.slice(2, -2) : null
  }
  return { options, language }
}
