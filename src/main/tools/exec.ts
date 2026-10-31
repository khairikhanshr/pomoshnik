// Child processes for tools: argv only (never a shell with interpolated user text),
// timeout + AbortSignal, bounded output, sanitized environment.
import { spawn, type ChildProcess } from 'node:child_process'
import { ToolAbortError, ToolError } from './errors'

export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Extra variables merged into the sanitized environment. */
  env?: Record<string, string>
  cwd?: string
  input?: string
  /** Bytes kept per stream; the rest is dropped and `truncated` is set. */
  maxBuffer?: number
  /** Kill the whole process tree on timeout / abort (user shell commands). */
  killTree?: boolean
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024
const KILL_GRACE_MS = 1500

/** Variables that must never reach child processes (secrets, dev-shell switches). */
const STRIPPED_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'JARVIS_API_KEY', 'JARVIS_ELEVENLABS_KEY', 'JARVIS_ARGS'])

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || STRIPPED_ENV.has(key.toUpperCase())) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

const active = new Set<ChildProcess>()

/** Kills processes still running (app shutdown). */
export function killAllChildren(): void {
  for (const child of active) killProcess(child, true)
  active.clear()
}

function killProcess(child: ChildProcess, tree: boolean): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (tree && process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
      return
    }
    if (tree && process.platform !== 'win32') process.kill(-pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    // already gone
  }
  const hard = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      if (tree && process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS)
  hard.unref()
}

function collector(limit: number): { push(chunk: Buffer): void; text(): string; truncated(): boolean } {
  const chunks: Buffer[] = []
  let size = 0
  let cut = false
  return {
    push(chunk) {
      if (size >= limit) {
        cut = true
        return
      }
      const room = limit - size
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (part.length < chunk.length) cut = true
      chunks.push(part)
      size += part.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => cut
  }
}

/** Runs a program with an argument vector. Resolves with the exit status; rejects on spawn failure or abort. */
export function run(command: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ToolAbortError())
      return
    }
    const tree = opts.killTree === true
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: childEnv(opts.env),
        shell: false,
        windowsHide: true,
        detached: tree && process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(new ToolError(`Cannot start ${command}: ${(err as Error).message}`))
      return
    }
    active.add(child)
    const limit = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
    const out = collector(limit)
    const errOut = collector(limit)
    let settled = false
    let timedOut = false
    let aborted = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      active.delete(child)
      fn()
    }
    const onAbort = (): void => {
      aborted = true
      killProcess(child, tree)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killProcess(child, tree)
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => errOut.push(chunk))
    child.stdin?.on('error', () => {})
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        const reason = err.code === 'ENOENT' ? 'program not found' : err.message
        reject(new ToolError(`Cannot start ${command}: ${reason}`))
      })
    })
    child.on('close', (code, signal) => {
      finish(() => {
        if (aborted) {
          reject(new ToolAbortError())
          return
        }
        resolve({
          code,
          signal,
          stdout: out.text(),
          stderr: errOut.text(),
          timedOut,
          truncated: out.truncated() || errOut.truncated()
        })
      })
    })
    if (opts.input !== undefined) child.stdin?.end(opts.input, 'utf8')
    else child.stdin?.end()
  })
}

/**
 * Starts a program that must outlive the call (an app the user asked to open). Not hidden:
 * windowsHide would start GUI apps with SW_HIDE.
 */
export function launchDetached(
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string>; hidden?: boolean } = {}
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: childEnv(opts.env),
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: opts.hidden === true
      })
    } catch (err) {
      reject(new ToolError(`Cannot start ${command}: ${(err as Error).message}`))
      return
    }
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(new ToolError(`Cannot start ${command}: ${err.code === 'ENOENT' ? 'program not found' : err.message}`))
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function firstLines(text: string, max = 300): string {
  const clean = text.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** Throws a ToolError unless the process exited with code 0. */
export function ensureSuccess(result: RunResult, what: string): RunResult {
  if (result.timedOut) throw new ToolError(`${what} timed out`)
  if (result.code !== 0) {
    const reason = firstLines(result.stderr) || firstLines(result.stdout) || `exit code ${result.code ?? result.signal}`
    throw new ToolError(`${what} failed: ${reason}`)
  }
  return result
}

export async function runChecked(command: string, args: readonly string[], what: string, opts: RunOptions = {}): Promise<string> {
  const result = await run(command, args, opts)
  return ensureSuccess(result, what).stdout
}
