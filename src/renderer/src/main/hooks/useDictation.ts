import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../common/api'
import { S } from '../../common/strings'
import { toast } from '../state/ui'

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'

const MAX_MS = 120_000
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

interface Recording {
  stream: MediaStream
  recorder: MediaRecorder
  chunks: Blob[]
  ctx: AudioContext
  cancelled: boolean
}

async function openMic(deviceId: string): Promise<MediaStream> {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
    } catch (err) {
      // The saved device may be unplugged: fall back to the system default.
      if (!(err instanceof DOMException) || (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError')) throw err
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base })
}

/**
 * Push-to-dictate: records the mic with MediaRecorder and inserts the speech.transcribe result.
 * `levelRef` receives the live input level as the --lv CSS variable.
 */
export function useDictation(deviceId: string, onText: (text: string) => void, levelRef: React.RefObject<HTMLElement | null>) {
  const [state, setState] = useState<DictationState>('idle')
  const [startedAt, setStartedAt] = useState(0)
  const rec = useRef<Recording | null>(null)
  const frame = useRef(0)
  const limitTimer = useRef(0)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const release = useCallback(() => {
    cancelAnimationFrame(frame.current)
    window.clearTimeout(limitTimer.current)
    const r = rec.current
    if (!r) return
    r.stream.getTracks().forEach((t) => t.stop())
    void r.ctx.close().catch(() => undefined)
    levelRef.current?.style.setProperty('--lv', '0')
  }, [levelRef])

  const finish = useCallback(async () => {
    const r = rec.current
    rec.current = null
    if (!r) return
    release()
    if (r.cancelled || !r.chunks.length) {
      setState('idle')
      return
    }
    setState('transcribing')
    try {
      const mime = (r.recorder.mimeType || 'audio/webm').split(';')[0]
      const blob = new Blob(r.chunks, { type: mime })
      const text = (await api.speech.transcribe(await blob.arrayBuffer(), mime)).trim()
      if (text) onTextRef.current(text)
      else toast(S.composer.nothingRecognized, 'info')
    } catch (err) {
      toast(errorMessage(err) || S.composer.dictationFailed, 'error')
    } finally {
      setState('idle')
    }
  }, [release])

  const stop = useCallback(() => {
    const r = rec.current
    if (r && r.recorder.state !== 'inactive') r.recorder.stop()
  }, [])

  const cancel = useCallback(() => {
    const r = rec.current
    if (!r) return
    r.cancelled = true
    if (r.recorder.state !== 'inactive') r.recorder.stop()
    else void finish()
  }, [finish])

  const start = useCallback(async () => {
    if (rec.current || state !== 'idle') return
    setState('starting')
    let stream: MediaStream
    try {
      stream = await openMic(deviceId)
    } catch (err) {
      setState('idle')
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      toast(denied ? S.composer.micDenied : errorMessage(err) || S.composer.micDenied, 'error')
      return
    }
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    const r: Recording = { stream, recorder, chunks: [], ctx, cancelled: false }
    rec.current = r

    recorder.ondataavailable = (e) => {
      if (e.data.size) r.chunks.push(e.data)
    }
    recorder.onstop = () => void finish()
    recorder.start(250)

    const buf = new Float32Array(analyser.fftSize)
    const tick = (): void => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      const rms = Math.sqrt(sum / buf.length)
      levelRef.current?.style.setProperty('--lv', Math.min(1, rms * 5).toFixed(3))
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    limitTimer.current = window.setTimeout(stop, MAX_MS)
    setStartedAt(Date.now())
    setState('recording')
  }, [deviceId, finish, levelRef, state, stop])

  useEffect(
    () => () => {
      const r = rec.current
      if (r) {
        r.cancelled = true
        if (r.recorder.state !== 'inactive') r.recorder.stop()
      }
      release()
    },
    [release]
  )

  return { state, startedAt, start, stop, cancel }
}
