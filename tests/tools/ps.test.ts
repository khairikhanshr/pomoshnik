import { beforeEach, describe, expect, it, vi } from 'vitest'

const runMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/tools/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/tools/exec')>()
  return { ...actual, run: runMock }
})

import {
  buildPsScript,
  cleanPsStderr,
  encodeArgs,
  encodePowerShell,
  MAX_ENCODED_COMMAND,
  parsePsOutput,
  powershellArgv,
  PS_RESULT_MARKER,
  runPowerShell
} from '../../src/main/tools/win/ps'
import { WINDOWS_SCRIPTS } from '../../src/main/tools/win/scripts'

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf16le')

/** Removes Add-Type here-strings (C# source), leaving only PowerShell code. */
function withoutHereStrings(script: string): string {
  return script.replace(/@'\n[\s\S]*?\n'@/g, "@''@")
}

describe('PowerShell encoding', () => {
  it('encodes the script as base64 UTF-16LE', () => {
    const script = 'Write-Output "привет, мир"'
    const encoded = encodePowerShell(script)
    expect(decode(encoded)).toBe(script)
    expect(Buffer.from(encoded, 'base64').length).toBe(script.length * 2)
  })

  it('uses the documented argument vector', () => {
    expect(powershellArgv('QQBCAA==')).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', 'QQBCAA=='])
  })

  it('wraps bodies in the UTF-8 / JARVIS_ARGS prelude with error handling', () => {
    const script = buildPsScript('Send-Result 1')
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8')
    expect(script).toContain('ConvertFrom-Json -InputObject $env:JARVIS_ARGS')
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toMatch(/try \{\nSend-Result 1\n\s*\} catch \{/)
  })

  it('serializes arguments as JSON for the environment variable', () => {
    const args = { text: 'привет "мир"; $(Remove-Item C:\\ -Recurse) `whoami`', n: 3 }
    expect(JSON.parse(encodeArgs(args))).toEqual(args)
    expect(encodeArgs(undefined)).toBe('{}')
  })
})

describe('runPowerShell passes user data only through JARVIS_ARGS', () => {
  beforeEach(() => runMock.mockReset())

  it('never puts user text into the script', async () => {
    runMock.mockResolvedValue({ code: 0, signal: null, stdout: `noise${PS_RESULT_MARKER}{"id":42}`, stderr: '', timedOut: false, truncated: false })
    const hostile = 'notepad"; Remove-Item -Recurse C:\\ ; "привет'
    const value = await runPowerShell<{ id: number }>(WINDOWS_SCRIPTS.startProcess, 'Start', { args: { target: hostile } })
    expect(value).toEqual({ id: 42 })
    const [command, argv, opts] = runMock.mock.calls[0] as [string, string[], { env: Record<string, string> }]
    expect(command).toMatch(/powershell\.exe$/i)
    expect(argv.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    const script = decode(argv[5])
    expect(script).not.toContain(hostile)
    expect(script).not.toContain('Remove-Item')
    expect(script).toContain('$A.target')
    expect(JSON.parse(opts.env.JARVIS_ARGS)).toEqual({ target: hostile })
  })

  it('turns error markers and failures into ToolErrors', async () => {
    runMock.mockResolvedValue({ code: 1, signal: null, stdout: '@@JARVIS_ERROR@@"Access is denied"', stderr: '', timedOut: false, truncated: false })
    await expect(runPowerShell('Send-Result 1', 'Closing')).rejects.toThrow('Closing failed: Access is denied')
    runMock.mockResolvedValue({ code: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false, truncated: false })
    await expect(runPowerShell('Send-Result 1', 'Closing')).rejects.toThrow('Closing failed: boom')
    runMock.mockResolvedValue({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true, truncated: false })
    await expect(runPowerShell('Send-Result 1', 'Closing')).rejects.toThrow('Closing timed out')
  })
})

describe('output parsing', () => {
  it('reads the last result marker', () => {
    expect(parsePsOutput(`WARNING: x\n${PS_RESULT_MARKER}{"a":"\\u043f"}`)).toEqual({ kind: 'result', value: { a: 'п' } })
    expect(parsePsOutput(`${PS_RESULT_MARKER}[]`)).toEqual({ kind: 'result', value: [] })
    expect(parsePsOutput('just text')).toEqual({ kind: 'none' })
    expect(parsePsOutput('@@JARVIS_ERROR@@"bad"')).toEqual({ kind: 'error', message: 'bad' })
  })

  it('cleans CLIXML error streams', () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Cannot find path &apos;C:\\x&apos;_x000D__x000A_</S><S S="Error">second</S></Objs>'
    expect(cleanPsStderr(clixml)).toBe("Cannot find path 'C:\\x'\r\nsecond")
    expect(cleanPsStderr('plain error')).toBe('plain error')
  })
})

describe('Windows script sources', () => {
  for (const [name, body] of Object.entries(WINDOWS_SCRIPTS)) {
    it(`${name}: fits the command line and uses Windows PowerShell 5.1 syntax only`, () => {
      const script = buildPsScript(body)
      expect(encodePowerShell(script).length).toBeLessThan(MAX_ENCODED_COMMAND)
      expect(script).not.toContain('`')
      const ps = withoutHereStrings(script)
      for (const token of ['&&', '||', '??', '?.', '-Parallel', '::new(']) expect(ps, `${name} uses ${token}`).not.toContain(token)
      expect(ps, `${name} uses a ternary`).not.toMatch(/\)\s*\?\s*\S+\s*:\s/)
    })
  }

  it('reads inputs from $A (JARVIS_ARGS) in every script that takes input', () => {
    const takesInput = ['startProcess', 'close', 'focus', 'mouse', 'keys', 'volume', 'mediaKey', 'runCommand']
    for (const name of takesInput) expect(WINDOWS_SCRIPTS[name], name).toMatch(/\$A\.\w+/)
  })
})
