// speech:speak (replay a message): markdown → speakable sentences → SpeakChunks of a synthetic turn.
import type { SpeakChunk } from '@shared/types'
import { splitSentences, toSpeakableText } from '@shared/speech-text'

/** The first chunk is short so playback starts quickly; later chunks are bigger (fewer TTS requests). */
const FIRST_CHUNK_CHARS = 160
const CHUNK_CHARS = 360

/** Splits text without sentence punctuation at word boundaries. */
function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence]
  const parts: string[] = []
  let current = ''
  for (const word of sentence.split(/\s+/)) {
    if (current && current.length + 1 + word.length > max) {
      parts.push(current)
      current = ''
    }
    current = current ? `${current} ${word}` : word.slice(0, max * 2)
  }
  if (current) parts.push(current)
  return parts
}

export function buildReplayChunks(markdown: string, turnId: string): SpeakChunk[] {
  const sentences = splitSentences(toSpeakableText(markdown))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((s) => splitLong(s, CHUNK_CHARS))
  const texts: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const limit = texts.length === 0 ? FIRST_CHUNK_CHARS : CHUNK_CHARS
    if (current && current.length + 1 + sentence.length > limit) {
      texts.push(current)
      current = sentence
    } else {
      current = current ? `${current} ${sentence}` : sentence
    }
  }
  if (current) texts.push(current)
  return texts.map((text, seq) => ({ turnId, seq, text, final: seq === texts.length - 1 }))
}
