// Throttles level updates to ~15/s (peak of each interval) and skips repeated silence.

export class LevelReporter {
  private peak = 0
  private dirty = false
  private lastSent = -1
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly send: (level: number) => void,
    private readonly intervalMs = 66
  ) {}

  push(level: number): void {
    const v = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0))
    if (v > this.peak || !this.dirty) this.peak = v
    this.dirty = true
    if (!this.timer) this.timer = setInterval(() => this.flush(), this.intervalMs)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private flush(): void {
    if (!this.dirty) {
      // Nothing new for a whole interval: settle at zero once, then go quiet.
      if (this.lastSent !== 0) this.emit(0)
      this.dispose()
      return
    }
    const v = Math.round(this.peak * 100) / 100
    this.dirty = false
    this.peak = 0
    if (v === this.lastSent && v < 0.02) return
    this.emit(v)
  }

  private emit(v: number): void {
    this.lastSent = v
    try {
      this.send(v)
    } catch {
      // The bridge may be gone while the window closes.
    }
  }
}
