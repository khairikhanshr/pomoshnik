// Pure audio helpers (no DOM APIs, unit-tested in Node).

export const SPEECH_SAMPLE_RATE = 16_000

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * Sample-rate conversion by linear interpolation. When downsampling, each output sample is the mean of the
 * input samples it covers, which acts as a cheap anti-aliasing low-pass filter.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('Sample rates must be positive')
  if (fromRate === toRate || input.length === 0) return input.slice()
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  if (ratio > 1) {
    for (let i = 0; i < outLength; i++) {
      const start = i * ratio
      const end = Math.min(input.length, start + ratio)
      let sum = 0
      let weight = 0
      for (let p = Math.floor(start); p < end; p++) {
        const w = Math.min(p + 1, end) - Math.max(p, start)
        if (w <= 0) continue
        sum += input[p] * w
        weight += w
      }
      out[i] = weight > 0 ? sum / weight : 0
    }
  } else {
    const last = input.length - 1
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio
      const p = Math.floor(pos)
      const frac = pos - p
      const a = input[Math.min(p, last)]
      const b = input[Math.min(p + 1, last)]
      out[i] = a + (b - a) * frac
    }
  }
  return out
}

/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0))
    view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return buffer
}

/** 16 kHz mono PCM16 WAV, the format sent to speech-to-text. */
export function encodeSpeechWav(samples: Float32Array, sampleRate = SPEECH_SAMPLE_RATE): ArrayBuffer {
  return encodeWav(resample(samples, sampleRate, SPEECH_SAMPLE_RATE), SPEECH_SAMPLE_RATE)
}

export interface DecodedWav {
  samples: Float32Array
  sampleRate: number
}

/** Decodes PCM 8/16/24/32-bit or float32 WAV data into mono float samples (channels are averaged). */
export function decodeWav(data: ArrayBuffer | Uint8Array): DecodedWav {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.length < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file')

  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = ascii(pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true) // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      if (!channels || !sampleRate) throw new Error('WAV data chunk before fmt chunk')
      const bytesPerSample = bits / 8
      const end = Math.min(bytes.length, body + size)
      const frames = Math.floor((end - body) / (bytesPerSample * channels))
      const samples = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        let sum = 0
        for (let c = 0; c < channels; c++) {
          const at = body + (f * channels + c) * bytesPerSample
          sum += readSample(view, at, format, bits)
        }
        samples[f] = sum / channels
      }
      return { samples, sampleRate }
    }
    pos = body + size + (size % 2)
  }
  throw new Error('WAV file has no data chunk')
}

function readSample(view: DataView, at: number, format: number, bits: number): number {
  if (format === 3 && bits === 32) return view.getFloat32(at, true)
  if (format !== 1) throw new Error(`Unsupported WAV format ${format}/${bits}`)
  switch (bits) {
    case 8:
      return (view.getUint8(at) - 128) / 128
    case 16:
      return view.getInt16(at, true) / 0x8000
    case 24: {
      const v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)
      return v / 0x800000
    }
    case 32:
      return view.getInt32(at, true) / 0x80000000
    default:
      throw new Error(`Unsupported WAV bit depth ${bits}`)
  }
}

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  const end = Math.min(to, samples.length)
  if (end <= from) return 0
  let sum = 0
  for (let i = from; i < end; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / (end - from))
}

/** Maps an RMS amplitude to a perceptual 0..1 level (-60 dBFS → 0, -10 dBFS → 1). */
export function levelFromRms(value: number): number {
  if (!(value > 0)) return 0
  const db = 20 * Math.log10(value)
  return Math.max(0, Math.min(1, (db + 60) / 50))
}

export function durationSeconds(samples: Float32Array, sampleRate = SPEECH_SAMPLE_RATE): number {
  return samples.length / sampleRate
}
