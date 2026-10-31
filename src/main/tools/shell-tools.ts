import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { clip, optString, reqString } from './args'
import { denied, type ToolDef, type ToolEnv } from './define'
import { ToolError } from './errors'
import { run } from './exec'
import { hostPathContext } from './host-paths'
import { displayPath, resolveUserPath } from './paths'
import { runPowerShell } from './win/ps'
import { PS_RUN_COMMAND } from './win/scripts'

export const COMMAND_TIMEOUT_MS = 60_000
const MAX_OUTPUT_CHARS = 7000

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '')
}

/** Keeps the beginning and the end (errors are usually at the end). */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.4)
  const tail = max - head
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`
}

/** The user's login shell when it is a known POSIX shell, else zsh. */
export function userShell(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  const shell = env.SHELL
  if (shell && /^\/[\w/.-]+\/(zsh|bash|sh|fish|ksh|dash)$/.test(shell) && exists(shell)) return shell
  return '/bin/zsh'
}

export function shellTools(env: ToolEnv): ToolDef[] {
  const runCommand: ToolDef = {
    spec: {
      name: 'run_command',
      description:
        "Run a command in the user's shell (zsh on macOS, PowerShell on Windows) and return its output; 60 s timeout. " +
        'The user sees the exact command and must approve it. Prefer the dedicated tools; use this only for tasks that need the command line.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact command line.' },
          cwd: { type: 'string', description: 'Working folder (default: home).' }
        },
        required: ['command'],
        additionalProperties: false
      }
    },
    platforms: ['darwin', 'win32', 'linux'],
    enabled: (settings) => settings.allowShellCommands,
    title: (args) => `Выполняю команду: ${clip(String(args.command ?? ''), 40)}`,
    run: async (args, ctx) => {
      const command = reqString(args, 'command', { max: 8000 })
      const pc = hostPathContext(env.platform)
      const cwdArg = optString(args, 'cwd', { max: 4096 })
      const cwd = cwdArg ? resolveUserPath(cwdArg, pc) : pc.home
      const info = await stat(cwd).catch(() => null)
      if (!info?.isDirectory()) throw new ToolError(`Working folder not found: ${displayPath(cwd, pc)}`)

      const detail = cwd === pc.home ? command : `${command}\n\nПапка: ${cwd}`
      const allowed = await env.confirm(ctx, { message: 'Выполнить команду?', detail })
      if (!allowed) return denied(`run the command: ${command}`)

      let output: string
      let code: number | null
      let timedOut = false
      if (env.platform === 'win32') {
        const result = await runPowerShell<{ output: string; code: number }>(PS_RUN_COMMAND, 'The command', {
          args: { command, cwd },
          timeoutMs: COMMAND_TIMEOUT_MS,
          signal: ctx.signal,
          killTree: true
        })
        output = result?.output ?? ''
        code = result?.code ?? 0
      } else {
        const result = await run(userShell(), ['-l', '-c', command], {
          cwd,
          timeoutMs: COMMAND_TIMEOUT_MS,
          signal: ctx.signal,
          killTree: true,
          maxBuffer: 1024 * 1024
        })
        output = result.stdout + (result.stderr.trim() ? `\n[stderr]\n${result.stderr}` : '')
        code = result.code
        timedOut = result.timedOut
      }
      const text = truncateMiddle(stripAnsi(output).trim(), MAX_OUTPUT_CHARS)
      const header = timedOut ? `Timed out after ${COMMAND_TIMEOUT_MS / 1000} s and was stopped.` : `Exit code ${code ?? 'unknown'}.`
      return {
        ok: !timedOut && code === 0,
        output: `${header}\n${text ? `--- output ---\n${text}` : '(no output)'}`,
        summary: timedOut ? 'Превышено время ожидания' : `Код выхода: ${code ?? '?'}`
      }
    }
  }
  return [runCommand]
}
