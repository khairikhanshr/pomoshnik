import { ToolError } from '../errors'
import { run } from '../exec'
import type { OsaScript } from './scripts'

/**
 * osascript argument vector. `--` ends option parsing: without it an argument such as "-e …"
 * would be read as another script statement.
 */
export function osascriptArgv(script: OsaScript, args: readonly string[] = []): string[] {
  return ['-l', script.language, '-e', script.source, '--', ...args]
}

/** "execution error: Message (-1728)" -> "Message (-1728)". */
export function cleanOsaError(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  return line.replace(/^.*?(execution error|error):\s*/i, '').trim()
}

export interface OsaOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export async function runOsa(script: OsaScript, args: readonly string[], what: string, opts: OsaOptions = {}): Promise<string> {
  const result = await run('/usr/bin/osascript', osascriptArgv(script, args), {
    timeoutMs: opts.timeoutMs ?? 15_000,
    signal: opts.signal
  })
  if (result.timedOut) throw new ToolError(`${what} timed out`)
  if (result.code !== 0) throw new ToolError(`${what} failed: ${cleanOsaError(result.stderr) || `exit code ${result.code}`}`)
  return result.stdout.trim()
}
