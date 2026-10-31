import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanOsaError, osascriptArgv } from '../../src/main/tools/mac/osa'
import { MAC_SCRIPTS } from '../../src/main/tools/mac/scripts'

const hostile = ['"; do shell script "touch /tmp/pwned"; "', '-e', 'display dialog "x"', '$(rm -rf ~)', 'привет «мир»']

describe('osascript argv', () => {
  it('passes user data only after "--", never inside the script source', () => {
    for (const [name, script] of Object.entries(MAC_SCRIPTS)) {
      const argv = osascriptArgv(script, hostile)
      const sep = argv.indexOf('--')
      expect(argv.slice(0, 4), name).toEqual(['-l', script.language, '-e', script.source])
      expect(sep, name).toBe(4)
      expect(argv.slice(sep + 1), name).toEqual(hostile)
      for (const bad of hostile) expect(script.source.includes(bad), `${name} contains user text`).toBe(false)
    }
  })

  it('reads user data from argv in every script that takes input', () => {
    const takesArgs = ['quitApp', 'volume', 'power', 'activate', 'mouse', 'keys', 'mediaKey']
    for (const name of takesArgs) {
      const { language, source } = MAC_SCRIPTS[name]
      if (language === 'AppleScript') expect(source, name).toMatch(/^on run argv/)
      else expect(source, name).toMatch(/function run\(argv\)/)
    }
  })

  it('cleans osascript error output', () => {
    expect(cleanOsaError('34:40: execution error: Не удаётся получить item 2. (-1728)\n')).toBe('Не удаётся получить item 2. (-1728)')
  })
})

describe.runIf(process.platform === 'darwin')('AppleScript / JXA sources compile (osacompile, nothing is executed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-osa-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  for (const [name, script] of Object.entries(MAC_SCRIPTS)) {
    it(name, () => {
      const ext = script.language === 'JavaScript' ? 'js' : 'applescript'
      const src = join(dir, `${name}.${ext}`)
      writeFileSync(src, script.source, 'utf8')
      expect(() =>
        execFileSync('/usr/bin/osacompile', ['-l', script.language, '-o', join(dir, `${name}.scpt`), src], { stdio: 'pipe' })
      ).not.toThrow()
    })
  }
})
