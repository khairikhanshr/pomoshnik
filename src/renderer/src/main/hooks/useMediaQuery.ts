import { useEffect, useState } from 'react'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const update = (): void => setMatches(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [query])
  return matches
}

/** Windows close to the minimum height (560 px) get compact hero layouts. */
export const SHORT_WINDOW = '(max-height: 700px)'
