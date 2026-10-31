// Opt-in live checks on a real Mac (JARVIS_LIVE_TOOLS=1). Only privacy-prompt-free operations:
// app scan, launching Calculator (quit with pkill, never via Apple Events), running-app list via
// NSWorkspace, system info, date, and file tools inside a temporary folder.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/defaults'
import { AppBus } from '../../src/main/bus'
import type { MediaStore, SettingsStore, WindowService } from '../../src/main/services'
import type { ToolContext, ToolHost } from '../../src/main/tools/types'

vi.mock('electron', async () => (await import('./electron-mock')).electronMock())

import { createToolRegistry } from '../../src/main/tools'

const LIVE = process.env.JARVIS_LIVE_TOOLS === '1' && process.platform === 'darwin'

function isRunning(name: string): boolean {
  try {
    execFileSync('/usr/bin/pgrep', ['-x', name], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return check()
}

describe.runIf(LIVE)('live macOS tools', () => {
  const work = mkdtempSync(join(process.env.JARVIS_LIVE_DIR || tmpdir(), 'jarvis-live-'))
  const host: ToolHost = {
    settings: { get: () => DEFAULT_SETTINGS } as unknown as SettingsStore,
    media: {} as MediaStore,
    windows: { getMainWindow: () => null } as unknown as WindowService,
    bus: new AppBus(),
    userDataDir: work,
    platform: 'darwin'
  }
  const registry = createToolRegistry(host)
  const ctx: ToolContext = { chatId: 'live', turnId: 'live-1', source: 'text', settings: DEFAULT_SETTINGS, signal: new AbortController().signal }

  afterAll(() => {
    registry.dispose()
    rmSync(work, { recursive: true, force: true })
  })

  it('lists installed apps with localized names', async () => {
    const all = await registry.execute('list_applications', {}, ctx)
    expect(all.ok).toBe(true)
    expect(all.output).toMatch(/installed apps: .*(Calculator|Калькулятор)/)
    const found = await registry.execute('list_applications', { query: 'калькулятор' }, ctx)
    expect(found.output).toMatch(/Calculator|Калькулятор/)
    console.log(`[live] ${all.output.slice(0, 160)}…`)
  }, 60_000)

  it('opens Calculator (then quits it with pkill)', async () => {
    if (isRunning('Calculator')) {
      console.log('[live] Calculator was already running: skipped so the user\'s window is not killed')
      return
    }
    const result = await registry.execute('open_application', { name: 'Calculator' }, ctx)
    console.log(`[live] ${result.output} / ${result.summary}`)
    expect(result.ok).toBe(true)
    expect(await waitFor(() => isRunning('Calculator'), 10_000)).toBe(true)
    const running = await registry.execute('list_running_applications', {}, ctx)
    console.log(`[live] ${running.output.slice(0, 200)}`)
    expect(running.output).toMatch(/Calculator|Калькулятор/)
    execFileSync('/usr/bin/pkill', ['-x', 'Calculator'])
    expect(await waitFor(() => !isRunning('Calculator'), 5000)).toBe(true)
  }, 60_000)

  it('reports system info and the date', async () => {
    const info = await registry.execute('get_system_info', {}, ctx)
    console.log(`[live]\n${info.output}\n${info.summary}`)
    expect(info.ok).toBe(true)
    expect(info.output).toMatch(/^OS: macOS \d+/)
    expect(info.output).toMatch(/Memory: .* total/)
    const date = await registry.execute('get_datetime', {}, ctx)
    console.log(`[live] ${date.output} / ${date.summary}`)
    expect(date.ok).toBe(true)
  }, 60_000)

  it('writes, reads and lists files', async () => {
    const file = join(work, 'проверка.txt')
    expect((await registry.execute('write_text_file', { path: file, content: 'Привет, Джарвис!\nСтрока 2' }, ctx)).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('Привет, Джарвис!\nСтрока 2')
    const read = await registry.execute('read_text_file', { path: file }, ctx)
    expect(read.output).toContain('2 lines')
    expect(read.output).toContain('Привет, Джарвис!')
    const list = await registry.execute('list_directory', { path: work }, ctx)
    console.log(`[live] ${list.output}`)
    expect(list.output).toMatch(/проверка\.txt — \d+ B/)
  }, 60_000)
})
