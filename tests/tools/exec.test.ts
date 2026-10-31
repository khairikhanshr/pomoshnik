import { afterEach, describe, expect, it } from 'vitest'
import { childEnv, ensureSuccess, run, runChecked } from '../../src/main/tools/exec'

const NODE = process.execPath

afterEach(() => {
  delete process.env.JARVIS_API_KEY
})

describe('run()', () => {
  it('passes arguments verbatim, without a shell', async () => {
    const args = ['$(touch /tmp/jarvis-pwned)', '"; rm -rf ~; "', '`id`', 'привет мир', '-e']
    const result = await run(NODE, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(args)
  })

  it('decodes UTF-8 output split across chunks', async () => {
    const result = await run(NODE, ['-e', "process.stdout.write(Buffer.from('ж'.repeat(5000)))"])
    expect(result.stdout).toBe('ж'.repeat(5000))
  })

  it('stops processes that exceed the timeout', async () => {
    const started = Date.now()
    const result = await run(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(() => ensureSuccess(result, 'Sleeping')).toThrow('Sleeping timed out')
  })

  it('rejects with an AbortError when cancelled', async () => {
    const controller = new AbortController()
    const pending = run(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const already = new AbortController()
    already.abort()
    await expect(run(NODE, ['-v'], { signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports missing programs', async () => {
    await expect(run('/nonexistent/jarvis-tool', [])).rejects.toThrow(/program not found/)
  })

  it('bounds collected output', async () => {
    const result = await run(NODE, ['-e', "process.stdout.write('x'.repeat(100000))"], { maxBuffer: 1000 })
    expect(result.stdout).toHaveLength(1000)
    expect(result.truncated).toBe(true)
  })

  it('feeds stdin and closes it', async () => {
    const result = await run(NODE, ['-e', "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))"], { input: 'abc' })
    expect(result.stdout).toBe('ABC')
  })

  it('throws readable errors for non-zero exits', async () => {
    await expect(runChecked(NODE, ['-e', "console.error('bad thing'); process.exit(3)"], 'The check')).rejects.toThrow('The check failed: bad thing')
  })
})

describe('child environment', () => {
  it('never leaks secrets or the dev-shell switch, but passes explicit extras', async () => {
    process.env.JARVIS_API_KEY = 'sk-test-secret-value'
    const env = childEnv({ JARVIS_ARGS: '{"a":1}' })
    expect(env.JARVIS_API_KEY).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.JARVIS_ARGS).toBe('{"a":1}')
    const result = await run(NODE, ['-e', 'process.stdout.write(JSON.stringify([process.env.JARVIS_API_KEY ?? null, process.env.JARVIS_ARGS]))'], {
      env: { JARVIS_ARGS: 'x' }
    })
    expect(JSON.parse(result.stdout)).toEqual([null, 'x'])
  })
})
