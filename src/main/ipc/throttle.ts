// Leading + trailing throttle: at most one call per interval, and the latest value is never lost.

export interface Throttled<T> {
  push(value: T): void
  cancel(): void
}

export function createThrottle<T>(intervalMs: number, fn: (value: T) => void): Throttled<T> {
  let last = Number.NEGATIVE_INFINITY
  let timer: NodeJS.Timeout | null = null
  let pending: { value: T } | null = null

  function fire(value: T): void {
    last = Date.now()
    fn(value)
  }

  return {
    push(value) {
      const wait = intervalMs - (Date.now() - last)
      if (wait <= 0 && !timer) {
        fire(value)
        return
      }
      pending = { value }
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        const next = pending
        pending = null
        if (next) fire(next.value)
      }, Math.max(0, wait))
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    }
  }
}
