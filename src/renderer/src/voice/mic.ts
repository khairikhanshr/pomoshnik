// Microphone stream management: preferred device with fallback to the system default, restart when the device
// disappears or the preference changes, exponential backoff while no microphone is usable.
import { errorText, type Logger } from './log'

export interface MicEvents {
  /** A new stream is live (first start or after a restart). */
  onStream(stream: MediaStream): void
  /** The stream ended unexpectedly; a restart is scheduled. */
  onLost(): void
  /** Persistent problem (null when resolved). */
  onError(message: string | null): void
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000]

export class MicError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean
  ) {
    super(message)
  }
}

export function describeMicError(err: unknown): MicError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicError('Нет доступа к микрофону. Разрешите доступ для Jarvis в системных настройках.', true)
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new MicError('Микрофон не найден. Подключите микрофон или выберите другой в настройках.', false)
    case 'NotReadableError':
    case 'AbortError':
      return new MicError('Микрофон недоступен: возможно, он занят другим приложением.', false)
    default:
      return new MicError(`Не удалось включить микрофон: ${errorText(err)}`, false)
  }
}

export class Microphone {
  private stream: MediaStream | null = null
  private preferred = ''
  private wanted = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private starting: Promise<void> | null = null
  private usingFallback = false
  private readonly onDeviceChange = (): void => void this.checkDevices()

  constructor(
    private readonly log: Logger,
    private readonly events: MicEvents
  ) {}

  get current(): MediaStream | null {
    return this.stream
  }

  get active(): boolean {
    return this.wanted
  }

  /** Starts (or keeps) capturing from the preferred device; failures are retried in the background. */
  start(deviceId: string): Promise<void> {
    const changed = deviceId !== this.preferred
    this.preferred = deviceId
    if (!this.wanted) {
      this.wanted = true
      navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
    } else if (!changed && (this.stream || this.starting)) {
      return this.starting ?? Promise.resolve()
    }
    return this.open()
  }

  stop(): void {
    this.wanted = false
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange)
    this.clearRetry()
    this.release()
  }

  private open(): Promise<void> {
    if (this.starting) {
      // A start is in flight; re-open once it settles so the latest preference wins.
      return this.starting.then(() => (this.wanted ? this.open() : undefined))
    }
    this.clearRetry()
    this.starting = this.acquire().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async acquire(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await this.getStream(this.preferred)
      this.usingFallback = false
    } catch (err) {
      if (!this.preferred) return this.failed(err)
      this.log.warn(`Selected microphone unavailable (${errorText(err)}), using the system default`)
      try {
        stream = await this.getStream('')
        this.usingFallback = true
      } catch (err2) {
        return this.failed(err2)
      }
    }
    if (!this.wanted) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.release()
    this.stream = stream
    this.attempt = 0
    const track = stream.getAudioTracks()[0]
    track.addEventListener('ended', () => {
      if (this.stream !== stream || !this.wanted) return
      this.log.warn(`Microphone "${track.label}" disconnected`)
      this.release()
      this.events.onLost()
      this.scheduleRetry()
    })
    this.log.info(`Microphone: ${track.label || 'default'}${this.usingFallback ? ' (fallback)' : ''}`)
    this.events.onError(null)
    this.events.onStream(stream)
  }

  private getStream(deviceId: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })
  }

  private failed(err: unknown): void {
    const e = describeMicError(err)
    this.log.error(`${e.message} (${errorText(err)})`)
    this.events.onError(e.message)
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retryTimer) return
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
    this.attempt++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.wanted && !this.stream) void this.open()
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
  }

  private async checkDevices(): Promise<void> {
    if (!this.wanted || this.starting) return
    let devices: MediaDeviceInfo[]
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    } catch (err) {
      this.log.warn(`enumerateDevices failed: ${errorText(err)}`)
      return
    }
    if (!this.stream) {
      // Something was plugged in while we had no microphone: try right away.
      this.attempt = 0
      void this.open()
      return
    }
    const settings = this.stream.getAudioTracks()[0]?.getSettings() ?? {}
    const currentGone = !!settings.deviceId && !devices.some((d) => d.deviceId === settings.deviceId)
    const preferredBack = this.usingFallback && devices.some((d) => d.deviceId === this.preferred)
    // Following the OS default input: its group changes when the user switches devices.
    const systemDefault = devices.find((d) => d.deviceId === 'default')
    const defaultMoved =
      !this.preferred && !!systemDefault?.groupId && !!settings.groupId && systemDefault.groupId !== settings.groupId
    if (currentGone || preferredBack || defaultMoved) {
      this.log.info('Audio devices changed, reopening the microphone')
      void this.open()
    }
  }
}
