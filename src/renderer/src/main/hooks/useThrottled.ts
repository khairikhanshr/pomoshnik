import { useEffect, useRef, useState } from 'react'

/** Returns `value` at most once per `ms` while `enabled`; passes it through immediately otherwise. */
export function useThrottled<T>(value: T, ms: number, enabled: boolean): T {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  const timer = useRef(0)

  useEffect(() => {
    if (!enabled) {
      window.clearTimeout(timer.current)
      setShown(value)
      return
    }
    const wait = last.current + ms - performance.now()
    if (wait <= 0) {
      last.current = performance.now()
      setShown(value)
      return
    }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      last.current = performance.now()
      setShown(value)
    }, wait)
  }, [value, ms, enabled])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return enabled ? shown : value
}
