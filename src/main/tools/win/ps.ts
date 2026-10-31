// Windows PowerShell runner. Scripts are constants; user data reaches them only through the
// JARVIS_ARGS environment variable (JSON), parsed inside the script with ConvertFrom-Json.
// Output is a marker followed by ASCII-only JSON, so console code pages cannot garble it.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors'
import { launchDetached, run } from '../exec'

export const PS_RESULT_MARKER = '@@JARVIS_RESULT@@'
export const PS_ERROR_MARKER = '@@JARVIS_ERROR@@'
/** Windows command lines are limited to 32767 characters. */
export const MAX_ENCODED_COMMAND = 30_000

const PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
function ConvertTo-JarvisAscii([string]$Text) {
  [regex]::Replace($Text, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}
function Send-Result($Value) {
  $json = ConvertTo-Json -InputObject $Value -Depth 6 -Compress
  [Console]::Out.Write('@@JARVIS_RESULT@@' + (ConvertTo-JarvisAscii $json))
}
$A = $null
if ($env:JARVIS_ARGS) { $A = ConvertFrom-Json -InputObject $env:JARVIS_ARGS }
`

const EPILOGUE = String.raw`
} catch {
  $msg = [string]$_.Exception.Message
  [Console]::Out.Write('@@JARVIS_ERROR@@' + (ConvertTo-JarvisAscii (ConvertTo-Json -InputObject $msg -Compress)))
  exit 1
}
`

/** Full script: prelude (UTF-8, $A = parsed JARVIS_ARGS, Send-Result) + body wrapped in try/catch. */
export function buildPsScript(body: string): string {
  return `${PRELUDE}try {\n${body.trim()}\n${EPILOGUE}`
}

/** Loads a C# snippet (Add-Type). The source is a constant, so a literal here-string is safe. */
export function psAddType(csharp: string): string {
  if (/^'@/m.test(csharp)) throw new Error('C# source must not contain a here-string terminator')
  return `Add-Type -TypeDefinition @'\n${csharp.trim()}\n'@\n`
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function powershellArgv(encoded: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
}

/** Absolute path avoids PATH hijacking; falls back to PATH lookup. */
export function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

export function encodeArgs(args: unknown): string {
  return JSON.stringify(args ?? {})
}

type PsOutput = { kind: 'result'; value: unknown } | { kind: 'error'; message: string } | { kind: 'none' }

export function parsePsOutput(stdout: string): PsOutput {
  const err = stdout.lastIndexOf(PS_ERROR_MARKER)
  if (err >= 0) {
    const raw = stdout.slice(err + PS_ERROR_MARKER.length).trim()
    try {
      return { kind: 'error', message: String(JSON.parse(raw)) }
    } catch {
      return { kind: 'error', message: raw || 'unknown PowerShell error' }
    }
  }
  const res = stdout.lastIndexOf(PS_RESULT_MARKER)
  if (res >= 0) {
    const raw = stdout.slice(res + PS_RESULT_MARKER.length).trim()
    if (!raw) return { kind: 'result', value: null }
    try {
      return { kind: 'result', value: JSON.parse(raw) as unknown }
    } catch {
      return { kind: 'error', message: `unreadable PowerShell output: ${raw.slice(0, 200)}` }
    }
  }
  return { kind: 'none' }
}

function decodeXml(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** PowerShell may serialize the error stream as CLIXML when its streams are redirected. */
export function cleanPsStderr(stderr: string): string {
  const text = stderr.trim()
  if (!text.startsWith('#< CLIXML')) return text
  const parts: string[] = []
  for (const m of text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)) parts.push(decodeXml(m[1]))
  return parts.join('').trim()
}

export interface PsRunOptions {
  args?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  /** Kill child processes too on timeout / abort (user commands). */
  killTree?: boolean
}

/** Runs a script body and returns the value passed to Send-Result. Throws ToolError on failure. */
export async function runPowerShell<T>(body: string, what: string, opts: PsRunOptions = {}): Promise<T> {
  const encoded = encodePowerShell(buildPsScript(body))
  if (encoded.length > MAX_ENCODED_COMMAND) throw new ToolError(`${what}: internal script is too long`)
  const result = await run(powershellPath(), powershellArgv(encoded), {
    env: { JARVIS_ARGS: encodeArgs(opts.args) },
    timeoutMs: opts.timeoutMs ?? 25_000,
    signal: opts.signal,
    killTree: opts.killTree,
    maxBuffer: 2 * 1024 * 1024
  })
  if (result.timedOut) throw new ToolError(`${what} timed out`)
  const parsed = parsePsOutput(result.stdout)
  if (parsed.kind === 'error') throw new ToolError(`${what} failed: ${parsed.message}`)
  if (parsed.kind === 'result' && result.code === 0) return parsed.value as T
  const reason = cleanPsStderr(result.stderr).split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ')
  throw new ToolError(`${what} failed: ${reason || `exit code ${result.code ?? result.signal}`}`)
}

/** Fire-and-forget script (e.g. sleep: SetSuspendState only returns after wake-up). */
export async function launchPowerShell(body: string, args?: unknown): Promise<void> {
  const encoded = encodePowerShell(buildPsScript(body))
  await launchDetached(powershellPath(), powershellArgv(encoded), { env: { JARVIS_ARGS: encodeArgs(args) }, hidden: true })
}
