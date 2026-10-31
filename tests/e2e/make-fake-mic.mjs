// Builds a WAV for Chromium's fake microphone (--use-file-for-fake-audio-capture):
// leading silence + a phrase spoken by a macOS voice + trailing silence, 48 kHz mono PCM16.
// Usage: node tests/e2e/make-fake-mic.mjs <out.wav> ["Джарвис, сколько сейчас времени?"] [voice=Milena]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RATE = 48000

function pcmFromWav(buf) {
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}

function wav(pcm) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

export function makeFakeMicWav(outFile, text = 'Джарвис, сколько сейчас времени?', voice = 'Milena', leadSec = 2, tailSec = 5) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-mic-'))
  try {
    const aiff = join(dir, 'speech.aiff')
    const raw = join(dir, 'speech.wav')
    execFileSync('say', ['-v', voice, '-o', aiff, text])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, raw])
    const speech = pcmFromWav(readFileSync(raw))
    const silence = (sec) => Buffer.alloc(Math.floor(sec * RATE) * 2)
    writeFileSync(outFile, wav(Buffer.concat([silence(leadSec), speech, silence(tailSec)])))
    return outFile
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: node tests/e2e/make-fake-mic.mjs <out.wav> [text] [voice]')
    process.exit(1)
  }
  console.log(makeFakeMicWav(out, process.argv[3], process.argv[4]))
}
