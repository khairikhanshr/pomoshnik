// Runs one inference at a time. Waiting jobs beyond `maxWaiting`, or older than `staleMs` when their turn comes,
// are dropped (resolved with null) so the recogniser never falls behind live speech.

interface Waiting {
  job: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  queuedAt: number
}

export class InferenceGate {
  private busy = false
  private waiting: Waiting[] = []

  constructor(
    private readonly maxWaiting = 2,
    private readonly staleMs = 8000,
    private readonly now: () => number = Date.now
  ) {}

  get pending(): number {
    return this.waiting.length + (this.busy ? 1 : 0)
  }

  run<T>(job: () => Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      this.waiting.push({
        job,
        resolve: resolve as (value: unknown) => void,
        reject,
        queuedAt: this.now()
      })
      while (this.waiting.length > this.maxWaiting) this.waiting.shift()?.resolve(null)
      this.next()
    })
  }

  /** Drops every waiting job (the running one completes normally). */
  clear(): void {
    for (const w of this.waiting.splice(0)) w.resolve(null)
  }

  private next(): void {
    if (this.busy) return
    let item: Waiting | undefined
    while ((item = this.waiting.shift())) {
      if (this.now() - item.queuedAt <= this.staleMs) break
      item.resolve(null)
    }
    if (!item) return
    const current = item
    this.busy = true
    current
      .job()
      .then(current.resolve, current.reject)
      .finally(() => {
        this.busy = false
        this.next()
      })
  }
}
