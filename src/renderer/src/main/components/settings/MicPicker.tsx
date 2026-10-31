import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { S } from '../../../common/strings'
import { Select, type Option } from './controls'

const T = S.settings.activation
const SEGMENTS = 24

/** Input device select + live level meter for the selected device (own stream while the tab is open). */
export function MicPicker({ deviceId, onChange }: { deviceId: string; onChange(id: string): void }): React.JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState('')
  const [needsAccess, setNeedsAccess] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const meterRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const enumerate = useCallback(async () => {
    try {
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
      setDevices(list)
      setNeedsAccess(list.length > 0 && list.every((d) => !d.label))
    } catch {
      setDevices([])
    }
  }, [])

  useEffect(() => {
    void enumerate()
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate)
  }, [enumerate])

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let frame = 0

    const open = async (): Promise<void> => {
      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio })
      } catch (err) {
        if (deviceId && err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
          stream = await navigator.mediaDevices.getUserMedia({ audio })
        } else throw err
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      setError('')
      void enumerate()
      ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      let shown = 0
      const tick = (): void => {
        analyser.getFloatTimeDomainData(buf)
        let peak = 0
        for (const v of buf) peak = Math.max(peak, Math.abs(v))
        const target = Math.min(1, Math.sqrt(peak) * 1.15)
        shown = target > shown ? target : shown * 0.9 + target * 0.1
        meterRef.current?.style.setProperty('--lv', shown.toFixed(3))
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }

    open().catch((err: unknown) => {
      if (cancelled) return
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      setError(denied ? T.micNeedAccess : T.micError)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close().catch(() => undefined)
      meterRef.current?.style.setProperty('--lv', '0')
    }
  }, [deviceId, enumerate, attempt])

  const options: Option<string>[] = [
    { value: '', label: T.micDefault },
    ...devices
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ value: d.deviceId, label: d.label || T.micUnnamed(i + 1) }))
  ]
  if (deviceId && !options.some((o) => o.value === deviceId)) options.push({ value: deviceId, label: T.micUnnamed(options.length) })

  return (
    <div className="mic-picker">
      <label className="mini-label" htmlFor={id}>
        {T.mic}
      </label>
      <Select id={id} value={deviceId} options={options} onChange={onChange} />
      <div className="mic-meter-row">
        <Mic size={15} className="mic-meter-icon" aria-hidden="true" />
        <div ref={meterRef} className={`mic-meter${error ? ' is-off' : ''}`} role="meter" aria-label={T.micLevel} aria-valuemin={0} aria-valuemax={1}>
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <i key={i} style={{ '--t': (i + 0.5) / SEGMENTS } as React.CSSProperties} />
          ))}
        </div>
      </div>
      {(error || needsAccess) && (
        <div className="mic-access">
          <span>{error || T.micNeedAccess}</span>
          <button type="button" className="btn btn--sm" onClick={() => setAttempt((a) => a + 1)}>
            {T.micAllow}
          </button>
        </div>
      )}
    </div>
  )
}
