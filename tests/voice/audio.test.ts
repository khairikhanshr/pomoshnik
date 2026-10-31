import { describe, expect, it } from 'vitest'
import { importRenderer, type AudioModule } from './support/renderer'

const { concatFloat32, decodeWav, encodeSpeechWav, encodeWav, levelFromRms, resample, rms } =
  await importRenderer<AudioModule>('voice/audio')

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}

/** Dominant frequency estimate from zero crossings. */
function zeroCrossingFreq(samples: Float32Array, rate: number): number {
  let crossings = 0
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 !== samples[i] < 0) crossings++
  return (crossings / 2) * (rate / samples.length)
}

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono PCM16 header', () => {
    const wav = encodeWav(new Float32Array(160), 16000)
    const v = new DataView(wav)
    const str = (o: number) => String.fromCharCode(...new Uint8Array(wav, o, 4))
    expect(wav.byteLength).toBe(44 + 320)
    expect(str(0)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 320)
    expect(str(8)).toBe('WAVE')
    expect(str(12)).toBe('fmt ')
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000)
    expect(v.getUint16(32, true)).toBe(2)
    expect(v.getUint16(34, true)).toBe(16)
    expect(str(36)).toBe('data')
    expect(v.getUint32(40, true)).toBe(320)
  })

  it('clamps and scales samples to int16', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5, Number.NaN]), 16000)
    const v = new DataView(wav)
    const at = (i: number) => v.getInt16(44 + i * 2, true)
    expect([at(0), at(1), at(2), at(3), at(4), at(5), at(6)]).toEqual([0, 32767, -32768, 32767, -32768, 16384, 0])
  })

  it('round-trips through decodeWav', () => {
    const src = sine(440, 16000, 0.25)
    const { samples, sampleRate } = decodeWav(encodeWav(src, 16000))
    expect(sampleRate).toBe(16000)
    expect(samples.length).toBe(src.length)
    let maxErr = 0
    for (let i = 0; i < src.length; i++) maxErr = Math.max(maxErr, Math.abs(src[i] - samples[i]))
    expect(maxErr).toBeLessThan(1 / 16000)
  })

  it('encodeSpeechWav converts to 16 kHz', () => {
    const wav = encodeSpeechWav(sine(300, 48000, 1), 48000)
    const { samples, sampleRate } = decodeWav(wav)
    expect(sampleRate).toBe(16000)
    expect(samples.length).toBe(16000)
    expect(zeroCrossingFreq(samples, 16000)).toBeGreaterThan(290)
    expect(zeroCrossingFreq(samples, 16000)).toBeLessThan(310)
  })
})

describe('decodeWav', () => {
  it('skips unknown chunks and downmixes stereo', () => {
    // RIFF header + LIST chunk + fmt (stereo 16-bit) + data with two frames.
    const parts: number[] = []
    const u32 = (n: number) => parts.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255)
    const u16 = (n: number) => parts.push(n & 255, (n >> 8) & 255)
    const ascii = (s: string) => parts.push(...[...s].map((c) => c.charCodeAt(0)))
    ascii('RIFF')
    u32(0)
    ascii('WAVE')
    ascii('LIST')
    u32(3)
    parts.push(1, 2, 3, 0) // odd size + pad byte
    ascii('fmt ')
    u32(16)
    u16(1)
    u16(2)
    u32(8000)
    u32(32000)
    u16(4)
    u16(16)
    ascii('data')
    u32(8)
    u16(0x4000) // L = 0.5
    u16(0x0000) // R = 0
    u16(0xc000) // L = -0.5
    u16(0xc000) // R = -0.5
    const { samples, sampleRate } = decodeWav(Uint8Array.from(parts))
    expect(sampleRate).toBe(8000)
    expect(Array.from(samples)).toEqual([0.25, -0.5])
  })

  it('rejects non-WAV input', () => {
    expect(() => decodeWav(new Uint8Array(20))).toThrow(/RIFF/)
  })
})

describe('resample', () => {
  it('keeps the frequency when downsampling 48 kHz to 16 kHz', () => {
    const out = resample(sine(1000, 48000, 0.5), 48000, 16000)
    expect(out.length).toBe(8000)
    expect(zeroCrossingFreq(out, 16000)).toBeCloseTo(1000, -1)
    expect(rms(out)).toBeCloseTo(0.5 / Math.SQRT2, 1)
  })

  it('handles non-integer ratios (44.1 kHz)', () => {
    const out = resample(sine(500, 44100, 1), 44100, 16000)
    expect(out.length).toBe(16000)
    expect(zeroCrossingFreq(out, 16000)).toBeCloseTo(500, -1)
  })

  it('attenuates content above the new Nyquist frequency', () => {
    const out = resample(sine(11000, 48000, 0.5), 48000, 16000)
    expect(rms(out)).toBeLessThan(0.5 * 0.5)
  })

  it('upsamples by interpolation', () => {
    const out = resample(Float32Array.from([0, 1]), 8000, 16000)
    expect(Array.from(out)).toEqual([0, 0.5, 1, 1])
  })

  it('returns a copy for equal rates and validates rates', () => {
    const src = Float32Array.from([1, 2, 3])
    const out = resample(src, 16000, 16000)
    expect(out).not.toBe(src)
    expect(Array.from(out)).toEqual([1, 2, 3])
    expect(() => resample(src, 0, 16000)).toThrow(RangeError)
  })
})

describe('levels and helpers', () => {
  it('computes rms and a perceptual level', () => {
    expect(rms(new Float32Array(0))).toBe(0)
    expect(rms(Float32Array.from([1, -1, 1, -1]))).toBe(1)
    expect(levelFromRms(0)).toBe(0)
    expect(levelFromRms(0.001)).toBeCloseTo(0, 5)
    expect(levelFromRms(1)).toBe(1)
    expect(levelFromRms(0.01)).toBeCloseTo(0.4, 5)
  })

  it('concatenates chunks', () => {
    const out = concatFloat32([Float32Array.from([1, 2]), new Float32Array(0), Float32Array.from([3])])
    expect(Array.from(out)).toEqual([1, 2, 3])
  })
})
