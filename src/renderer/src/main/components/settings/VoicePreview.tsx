import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Play, Square } from 'lucide-react'
import type { PublicSettings } from '@shared/types'
import { api, errorMessage } from '../../../common/api'
import { S } from '../../../common/strings'
import { toast } from '../../state/ui'

type PreviewState = 'idle' | 'loading' | 'playing'

/** Picks the system voice the voice engine would use: the configured name, else the best ru-RU voice. */
export function pickSystemVoice(voices: SpeechSynthesisVoice[], name: string): SpeechSynthesisVoice | undefined {
  if (name) {
    const exact = voices.find((v) => v.name === name)
    if (exact) return exact
  }
  const ru = voices.filter((v) => v.lang.toLowerCase().startsWith('ru'))
  const preferred = ['Milena', 'Yuri', 'Pavel', 'Irina', 'Katya']
  return preferred.map((p) => ru.find((v) => v.name.includes(p))).find(Boolean) ?? ru.find((v) => v.localService) ?? ru[0]
}

/** "Прослушать": cloud providers via speech.synthesize, the system provider via speechSynthesis. */
export function VoicePreview({ settings }: { settings: PublicSettings }): React.JSX.Element {
  const [state, setState] = useState<PreviewState>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const seq = useRef(0)

  const cleanup = (): void => {
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
    if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel()
  }

  useEffect(() => () => cleanup(), [])

  const stop = (): void => {
    seq.current++
    cleanup()
    setState('idle')
  }

  const play = async (): Promise<void> => {
    stop()
    const my = ++seq.current
    const text = S.settings.voice.previewText(settings.userTitle)

    if (settings.ttsProvider === 'system') {
      const synth = window.speechSynthesis
      const utter = new SpeechSynthesisUtterance(text)
      const voice = pickSystemVoice(synth.getVoices(), settings.systemVoiceName)
      if (voice) utter.voice = voice
      utter.lang = voice?.lang ?? 'ru-RU'
      utter.rate = settings.ttsSpeed
      utter.onend = () => my === seq.current && setState('idle')
      utter.onerror = () => my === seq.current && setState('idle')
      setState('playing')
      synth.speak(utter)
      return
    }

    setState('loading')
    try {
      const { audio, mime } = await api.speech.synthesize(text)
      if (my !== seq.current) return
      const url = URL.createObjectURL(new Blob([audio as Uint8Array<ArrayBuffer>], { type: mime || 'audio/mpeg' }))
      urlRef.current = url
      const el = new Audio(url)
      audioRef.current = el
      el.onended = () => my === seq.current && stop()
      el.onerror = () => my === seq.current && stop()
      await el.play()
      if (my === seq.current) setState('playing')
    } catch (err) {
      if (my !== seq.current) return
      cleanup()
      setState('idle')
      toast(errorMessage(err) || S.settings.voice.previewFailed, 'error')
    }
  }

  return state === 'idle' ? (
    <button type="button" className="btn btn--primary" onClick={() => void play()}>
      <Play size={14} fill="currentColor" aria-hidden="true" />
      {S.settings.voice.preview}
    </button>
  ) : (
    <button type="button" className="btn" onClick={stop}>
      {state === 'loading' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Square size={12} fill="currentColor" aria-hidden="true" />}
      {state === 'loading' ? S.settings.voice.previewing : S.settings.voice.previewStop}
    </button>
  )
}
