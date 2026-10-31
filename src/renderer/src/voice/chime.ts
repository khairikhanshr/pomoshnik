// Short synthesized earcons (no audio files): a rising two-tone "listening" chime and a falling "cancel" one.
import type { ChimeKind } from './engine-types'

const TONES: Record<ChimeKind, Array<[frequency: number, startS: number]>> = {
  listen: [
    [784, 0], // G5
    [1175, 0.11] // D6
  ],
  cancel: [
    [988, 0], // B5
    [659, 0.11] // E5
  ]
}

const TONE_S = 0.16
const PEAK_GAIN = 0.18

/** Plays the chime and resolves when it has finished. */
export function playChime(ctx: AudioContext, kind: ChimeKind = 'listen'): Promise<void> {
  const t0 = ctx.currentTime + 0.01
  const master = ctx.createGain()
  master.gain.value = PEAK_GAIN
  master.connect(ctx.destination)
  let end = t0
  for (const [freq, start] of TONES[kind]) {
    const at = t0 + start
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, at)
    // Soft attack and exponential decay avoid clicks.
    env.gain.setValueAtTime(0.0001, at)
    env.gain.exponentialRampToValueAtTime(1, at + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, at + TONE_S)
    osc.connect(env).connect(master)
    osc.start(at)
    osc.stop(at + TONE_S + 0.02)
    end = Math.max(end, at + TONE_S + 0.02)
  }
  const ms = Math.max(0, (end - ctx.currentTime) * 1000)
  return new Promise((resolve) => {
    setTimeout(() => {
      master.disconnect()
      resolve()
    }, ms + 20)
  })
}
