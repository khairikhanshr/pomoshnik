export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export type LogSink = (level: LogLevel, message: string) => void

const REPEAT_WINDOW_MS = 10_000

/** Logs to the console and the given sink; identical messages within 10 s are sent once. */
export function createLogger(sink: LogSink | null, now: () => number = Date.now): Logger {
  const lastSent = new Map<string, number>()
  const write = (level: LogLevel, message: string): void => {
    const line = `[voice] ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
    const key = `${level}:${message}`
    const t = now()
    const prev = lastSent.get(key)
    if (prev !== undefined && t - prev < REPEAT_WINDOW_MS) return
    lastSent.set(key, t)
    if (lastSent.size > 200) lastSent.clear()
    try {
      sink?.(level, message)
    } catch {
      // Logging must never throw into the engine.
    }
  }
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m)
  }
}

/** Human-readable error text; strips Electron's "Error invoking remote method '…': Error:" prefix. */
export function errorText(err: unknown): string {
  const clean = (s: string): string => s.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '')
  if (err instanceof Error) return clean(err.message || err.name)
  if (typeof err === 'string') return clean(err)
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
