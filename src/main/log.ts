// Minimal logger: console + userData/logs/main.log (rotated at ~2 MB).
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

let logFile: string | null = null
const MAX_BYTES = 2 * 1024 * 1024

/** Called once from main/index.ts after app paths are known. */
export function initLogFile(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'main.log')
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) renameSync(logFile, join(dir, 'main.old.log'))
  } catch {
    logFile = null
  }
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Redacts things that look like API keys before they reach the log. */
export function redact(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 5)}…${m.slice(-4)}`)
}

function write(level: Level, scope: string, args: unknown[]): void {
  const line = redact(`${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${args.map(format).join(' ')}`)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n')
    } catch {
      // ignore disk errors
    }
  }
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => {
      if (process.env.JARVIS_DEBUG) write('debug', scope, a)
    },
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a)
  }
}
