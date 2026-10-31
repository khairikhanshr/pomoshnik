import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/defaults'
import type { Settings, SpeakChunk } from '../../src/shared/types'
import { AppBus } from '../../src/main/bus'
import type { MediaStore, SettingsStore, WindowService } from '../../src/main/services'
import type { ToolContext, ToolHost } from '../../src/main/tools/types'
import { mockState } from './electron-mock'

vi.mock('electron', async () => (await import('./electron-mock')).electronMock())

// No real processes in these tests: every OS call is recorded instead of executed.
const execMock = vi.hoisted(() => ({
  run: vi.fn(),
  runChecked: vi.fn(),
  launchDetached: vi.fn()
}))
vi.mock('../../src/main/tools/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/tools/exec')>()
  return { ...actual, run: execMock.run, runChecked: execMock.runChecked, launchDetached: execMock.launchDetached, killAllChildren: vi.fn() }
})

import { createToolRegistry } from '../../src/main/tools'
import { dialog, shell, systemPreferences } from 'electron'

const ALL_TOOLS = [
  'take_screenshot',
  'open_application',
  'list_applications',
  'close_application',
  'list_running_applications',
  'focus_application',
  'open_url',
  'web_search',
  'open_path',
  'list_directory',
  'read_text_file',
  'write_text_file',
  'type_text',
  'press_keys',
  'mouse',
  'set_volume',
  'media_control',
  'system_power',
  'clipboard',
  'get_system_info',
  'get_datetime',
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
  'run_command'
]

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-registry-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function makeHost(platform: NodeJS.Platform): ToolHost {
  const settings: Settings = structuredClone(DEFAULT_SETTINGS)
  const store = { get: () => settings, update: () => settings, reset: () => settings, onChange: () => () => {} } as unknown as SettingsStore
  const media = {
    save: vi.fn((_data: Buffer, opts: { kind: 'screenshot' | 'upload'; width?: number; height?: number }) => ({
      id: 'img1',
      url: 'jarvis-media://image/img1',
      kind: opts.kind,
      width: opts.width,
      height: opts.height
    })),
    ref: () => null,
    path: () => null,
    dataUrl: async () => null,
    remove: () => {}
  } as unknown as MediaStore
  const windows = {
    showMain: vi.fn(),
    hideMain: vi.fn(),
    toggleMain: vi.fn(),
    isMainVisible: () => false,
    getMainWindow: () => null,
    showOverlay: vi.fn(),
    hideOverlay: vi.fn(),
    withUiHidden: async <T>(fn: () => Promise<T>) => fn(),
    sendToVoice: vi.fn(),
    broadcast: vi.fn()
  } as unknown as WindowService
  return { settings: store, media, windows, bus: new AppBus(), userDataDir: tempDir(), platform }
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { chatId: 'chat1', turnId: 'turn1', source: 'text', settings: structuredClone(DEFAULT_SETTINGS), signal: new AbortController().signal, ...overrides }
}

const okRun = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false }

beforeEach(() => {
  execMock.run.mockReset().mockResolvedValue(okRun)
  execMock.runChecked.mockReset().mockResolvedValue('')
  execMock.launchDetached.mockReset().mockResolvedValue(undefined)
  vi.mocked(shell.openExternal).mockClear()
  vi.mocked(dialog.showMessageBox).mockClear()
  vi.mocked(systemPreferences.isTrustedAccessibilityClient).mockClear()
  mockState.trusted = false
  mockState.screenAccess = 'denied'
  mockState.dialogResponse = 1
  delete process.env.JARVIS_AUTO_CONFIRM
  delete process.env.JARVIS_E2E
})
afterEach(() => {
  delete process.env.JARVIS_AUTO_CONFIRM
})

describe('specs()', () => {
  it('offers every tool on macOS and Windows with default settings', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const registry = createToolRegistry(makeHost(platform))
      expect(registry.specs(DEFAULT_SETTINGS).map((s) => s.name)).toEqual(ALL_TOOLS)
      registry.dispose()
    }
  })

  it('keeps only harmless tools when computer control is off', () => {
    const registry = createToolRegistry(makeHost('darwin'))
    expect(registry.specs({ ...DEFAULT_SETTINGS, computerControl: false }).map((s) => s.name)).toEqual([
      'get_system_info',
      'get_datetime',
      'set_reminder',
      'list_reminders',
      'cancel_reminder'
    ])
    registry.dispose()
  })

  it('manages reminders with computer control off', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const off = { ...DEFAULT_SETTINGS, computerControl: false }
    const set = await registry.execute('set_reminder', { in_seconds: 600, text: 'выпить воды' }, ctx({ settings: off }))
    expect(set.ok).toBe(true)
    const listed = await registry.execute('list_reminders', {}, ctx({ settings: off }))
    expect(listed).toMatchObject({ ok: true, summary: 'Напоминаний: 1' })
    const id = /^(\S+) — /m.exec(listed.output.split('\n')[1] ?? '')?.[1] ?? ''
    expect((await registry.execute('cancel_reminder', { id }, ctx({ settings: off }))).ok).toBe(true)
    expect((await registry.execute('list_reminders', {}, ctx({ settings: off }))).output).toBe('No pending reminders.')
    registry.dispose()
  })

  it('drops run_command unless shell commands are allowed', () => {
    const registry = createToolRegistry(makeHost('win32'))
    const names = registry.specs({ ...DEFAULT_SETTINGS, allowShellCommands: false }).map((s) => s.name)
    expect(names).not.toContain('run_command')
    expect(names).toHaveLength(ALL_TOOLS.length - 1)
    registry.dispose()
  })

  it('filters by platform', () => {
    const registry = createToolRegistry(makeHost('linux'))
    const names = registry.specs(DEFAULT_SETTINGS).map((s) => s.name)
    expect(names).toContain('get_datetime')
    expect(names).toContain('take_screenshot')
    expect(names).not.toContain('open_application')
    expect(names).not.toContain('mouse')
    registry.dispose()
  })

  it('declares valid JSON schemas with English descriptions', () => {
    const registry = createToolRegistry(makeHost('darwin'))
    for (const spec of registry.specs(DEFAULT_SETTINGS)) {
      expect(spec.name).toMatch(/^[a-z_]+$/)
      expect(spec.description.length).toBeGreaterThan(20)
      expect(spec.description).toMatch(/^[A-Z(]/)
      expect(spec.parameters.type).toBe('object')
      for (const key of spec.parameters.required ?? []) expect(Object.keys(spec.parameters.properties)).toContain(key)
    }
    registry.dispose()
  })
})

describe('describe()', () => {
  const registry = createToolRegistry(makeHost('darwin'))
  afterAll(() => registry.dispose())

  it('gives Russian titles', () => {
    expect(registry.describe('open_application', { name: 'Telegram' })).toBe('Открываю «Telegram»')
    expect(registry.describe('take_screenshot', {})).toBe('Делаю снимок экрана')
    expect(registry.describe('take_screenshot', { region: { x: 1, y: 1, width: 10, height: 10 } })).toBe('Увеличиваю фрагмент экрана')
    expect(registry.describe('close_application', { name: 'Safari', force: true })).toBe('Принудительно закрываю «Safari»')
    expect(registry.describe('open_url', { url: 'https://www.youtube.com/watch?v=1' })).toBe('Открываю youtube.com')
    expect(registry.describe('set_volume', { level: 30 })).toBe('Ставлю громкость 30%')
    expect(registry.describe('system_power', { action: 'shutdown' })).toBe('Выключаю компьютер')
    expect(registry.describe('mouse', { action: 'double_click' })).toBe('Делаю двойной клик')
    expect(registry.describe('unknown_tool', {})).toBe('Инструмент unknown_tool')
  })

  it('has a Cyrillic title for every tool, even with missing args', () => {
    for (const name of ALL_TOOLS) expect(registry.describe(name, {}), name).toMatch(/[а-яё]/i)
  })
})

describe('execute()', () => {
  it('never throws: unknown tools, disabled tools, bad arguments, cancellation', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    expect(await registry.execute('nope', {}, ctx())).toMatchObject({ ok: false, output: 'Error: unknown tool "nope"' })
    const off = { ...DEFAULT_SETTINGS, computerControl: false }
    expect((await registry.execute('open_url', { url: 'https://a.b' }, ctx({ settings: off }))).output).toMatch(/computer control is turned off/)
    expect((await registry.execute('open_url', {}, ctx())).output).toBe('Error: Missing required argument "url"')
    expect((await registry.execute('mouse', { action: 'fly' }, ctx())).output).toMatch(/expected one of/)
    expect((await registry.execute('read_text_file', null as unknown as Record<string, unknown>, ctx())).ok).toBe(false)
    const aborted = new AbortController()
    aborted.abort()
    expect(await registry.execute('get_datetime', {}, ctx({ signal: aborted.signal }))).toMatchObject({ ok: false, summary: 'Отменено' })
    registry.dispose()
  })

  it('reports the date and time', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const result = await registry.execute('get_datetime', {}, ctx())
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/^Local time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
    registry.dispose()
  })

  it('opens only http(s) / mailto links', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    expect((await registry.execute('open_url', { url: 'youtube.com' }, ctx())).ok).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledWith('https://youtube.com/')
    expect((await registry.execute('open_url', { url: 'javascript:alert(1)' }, ctx())).ok).toBe(false)
    expect((await registry.execute('open_url', { url: 'file:///etc/passwd' }, ctx())).ok).toBe(false)
    expect((await registry.execute('open_url', { url: 'mailto:a@b.c' }, ctx())).ok).toBe(true)
    await registry.execute('web_search', { query: 'погода в Алматы', engine: 'yandex' }, ctx())
    expect(shell.openExternal).toHaveBeenLastCalledWith('https://yandex.ru/search/?text=%D0%BF%D0%BE%D0%B3%D0%BE%D0%B4%D0%B0%20%D0%B2%20%D0%90%D0%BB%D0%BC%D0%B0%D1%82%D1%8B')
    registry.dispose()
  })
})

describe('files', () => {
  it('creates, refuses to silently overwrite, and confirms overwrites', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const dir = tempDir()
    const file = join(dir, 'заметка.txt')
    expect((await registry.execute('write_text_file', { path: file, content: 'один' }, ctx())).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('один')

    const again = await registry.execute('write_text_file', { path: file, content: 'два' }, ctx())
    expect(again).toMatchObject({ ok: false, summary: 'Файл уже существует' })

    process.env.JARVIS_AUTO_CONFIRM = 'deny'
    const denied = await registry.execute('write_text_file', { path: file, content: 'два', overwrite: true }, ctx())
    expect(denied.output).toMatch(/^User denied/)
    expect(readFileSync(file, 'utf8')).toBe('один')

    process.env.JARVIS_AUTO_CONFIRM = 'allow'
    expect((await registry.execute('write_text_file', { path: file, content: 'два', overwrite: true }, ctx())).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('два')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()

    const read = await registry.execute('read_text_file', { path: file }, ctx())
    expect(read.output).toContain('---\nдва')
    const list = await registry.execute('list_directory', { path: dir }, ctx())
    expect(list.output).toMatch(/0 folders, 1 files\nзаметка\.txt — 6 B/)
    registry.dispose()
  })

  it('suggests close names when a file is missing and refuses binary files', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const dir = tempDir()
    writeFileSync(join(dir, 'Отчёт.txt'), 'x')
    writeFileSync(join(dir, 'data.bin'), Buffer.from([1, 0, 2, 0]))
    const missing = await registry.execute('read_text_file', { path: join(dir, 'отчет.txt') }, ctx())
    expect(missing.output).toMatch(/Not found: .*Did you mean: .*Отчёт\.txt/)
    expect((await registry.execute('read_text_file', { path: join(dir, 'data.bin') }, ctx())).output).toMatch(/not a text file/)
    registry.dispose()
  })
})

describe('confirmations', () => {
  it('shows a Russian dialog (Cancel by default) and speaks a prompt on voice turns', async () => {
    const host = makeHost('darwin')
    const spoken: SpeakChunk[] = []
    host.bus.on('speak', (c) => spoken.push(c))
    const registry = createToolRegistry(host)
    const file = join(tempDir(), 'a.txt')
    writeFileSync(file, 'old')
    mockState.dialogResponse = 0
    const result = await registry.execute('write_text_file', { path: file, content: 'new', overwrite: true }, ctx({ source: 'voice' }))
    expect(result.ok).toBe(true)
    expect(spoken).toEqual([{ turnId: 'confirm-turn1-1', seq: 0, text: 'Требуется ваше подтверждение, сэр.', final: true }])
    const options = vi.mocked(dialog.showMessageBox).mock.calls[0][0] as unknown as Electron.MessageBoxOptions
    expect(options.buttons).toEqual(['Разрешить', 'Отмена'])
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
    expect(options.message).toBe('Перезаписать файл «a.txt»?')
    expect(options.detail).toBe(file)

    mockState.dialogResponse = 1
    const refused = await registry.execute('write_text_file', { path: file, content: 'newer', overwrite: true }, ctx())
    expect(refused).toMatchObject({ ok: false, summary: 'Отменено пользователем' })
    expect(readFileSync(file, 'utf8')).toBe('new')
    registry.dispose()
  })

  it('skips the dialog when confirmations are turned off', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const file = join(tempDir(), 'b.txt')
    writeFileSync(file, 'old')
    const settings = { ...DEFAULT_SETTINGS, confirmDangerous: false }
    expect((await registry.execute('write_text_file', { path: file, content: 'new', overwrite: true }, ctx({ settings }))).ok).toBe(true)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('asks before power actions and runs the platform command only when allowed', async () => {
    const registry = createToolRegistry(makeHost('win32'))
    process.env.JARVIS_AUTO_CONFIRM = 'deny'
    expect((await registry.execute('system_power', { action: 'restart' }, ctx())).output).toBe('User denied the action: restart')
    expect(execMock.runChecked).not.toHaveBeenCalled()
    process.env.JARVIS_AUTO_CONFIRM = 'allow'
    expect((await registry.execute('system_power', { action: 'shutdown' }, ctx())).ok).toBe(true)
    expect(execMock.runChecked).toHaveBeenCalledWith('shutdown.exe', ['/s', '/t', '0'], expect.any(String), expect.any(Object))
    expect((await registry.execute('system_power', { action: 'lock' }, ctx())).ok).toBe(true)
    expect(execMock.launchDetached).toHaveBeenCalledWith('rundll32.exe', ['user32.dll,LockWorkStation'], { hidden: true })
    registry.dispose()
  })

  it('always confirms shell commands and shows the exact command', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    mockState.dialogResponse = 1
    const result = await registry.execute('run_command', { command: 'rm -rf ~/x' }, ctx())
    expect(result.output).toBe('User denied the action: run the command: rm -rf ~/x')
    expect((vi.mocked(dialog.showMessageBox).mock.calls[0][0] as unknown as Electron.MessageBoxOptions).detail).toBe('rm -rf ~/x')
    expect(execMock.run).not.toHaveBeenCalled()
    registry.dispose()
  })
})

describe('macOS permissions', () => {
  it('explains the missing Accessibility permission and prompts for it', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const result = await registry.execute('mouse', { action: 'click', x: 10, y: 10 }, ctx())
    expect(result).toMatchObject({ ok: false, summary: 'Нужно разрешение «Универсальный доступ»' })
    expect(result.output).toMatch(/Accessibility/)
    expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true)
    expect(execMock.run).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('explains the missing Screen Recording permission and opens the Privacy pane', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const result = await registry.execute('take_screenshot', {}, ctx())
    expect(result).toMatchObject({ ok: false, summary: 'Нужно разрешение «Запись экрана»' })
    expect(shell.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    registry.dispose()
  })
})

describe('apps (OS calls recorded, not executed)', () => {
  it('opens a macOS app by its Russian name with open -a', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const result = await registry.execute('open_application', { name: 'калькулятор' }, ctx())
    expect(result).toMatchObject({ ok: true, summary: 'Открыто: Calculator' })
    expect(execMock.runChecked).toHaveBeenCalledWith('/usr/bin/open', ['-a', '/System/Applications/Calculator.app'], 'open', expect.any(Object))
    registry.dispose()
  })

  it('opens websites for web-only aliases', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    expect((await registry.execute('open_application', { name: 'ютуб' }, ctx())).ok).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledWith('https://www.youtube.com')
    registry.dispose()
  })

  it('launches a localized Windows Start menu app through shell:AppsFolder', async () => {
    execMock.run.mockImplementation(async (_cmd: string, argv: string[]) => {
      const script = Buffer.from(argv[argv.length - 1], 'base64').toString('utf16le')
      if (script.includes('Get-StartApps')) {
        return { ...okRun, stdout: '@@JARVIS_RESULT@@[{"name":"\\u041a\\u0430\\u043b\\u044c\\u043a\\u0443\\u043b\\u044f\\u0442\\u043e\\u0440","id":"Microsoft.WindowsCalculator_8wekyb3d8bbwe!App","kind":"appx"}]' }
      }
      return okRun
    })
    const registry = createToolRegistry(makeHost('win32'))
    const result = await registry.execute('open_application', { name: 'calculator' }, ctx())
    expect(result).toMatchObject({ ok: true, summary: 'Открыто: Калькулятор' })
    expect(execMock.launchDetached).toHaveBeenCalledWith('explorer.exe', ['shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'])
    registry.dispose()
  })
})

describe('app fallbacks', () => {
  it('still starts a Windows built-in when the Start menu scan fails', async () => {
    const targets: string[] = []
    execMock.run.mockImplementation(async (_cmd: string, argv: string[], opts: { env?: Record<string, string> }) => {
      const script = Buffer.from(argv[argv.length - 1], 'base64').toString('utf16le')
      if (script.includes('Get-StartApps')) return { ...okRun, code: 1, stdout: '@@JARVIS_ERROR@@"boom"' }
      if (script.includes('Start-Process')) {
        targets.push((JSON.parse(opts.env?.JARVIS_ARGS ?? '{}') as { target: string }).target)
        return { ...okRun, stdout: '@@JARVIS_RESULT@@{"id":123}' }
      }
      return okRun
    })
    const registry = createToolRegistry(makeHost('win32'))
    const result = await registry.execute('open_application', { name: 'калькулятор' }, ctx())
    expect(result).toMatchObject({ ok: true, output: 'Opened калькулятор (calc.exe).' })
    expect(targets).toEqual(['calc.exe'])
    registry.dispose()
  })
})

describe('reminders through the registry', () => {
  it('sets, lists and cancels (also by text)', async () => {
    const registry = createToolRegistry(makeHost('darwin'))
    const set = await registry.execute('set_reminder', { in_seconds: 600, text: 'позвонить маме' }, ctx())
    expect(set.ok).toBe(true)
    expect(set.summary).toMatch(/^Напомню (в|завтра в) \d{2}:\d{2}: позвонить маме$/)
    const listed = await registry.execute('list_reminders', {}, ctx())
    expect(listed.output).toMatch(/Pending reminders \(1\):\n[a-z0-9]+ — .* — позвонить маме/)
    const cancelled = await registry.execute('cancel_reminder', { id: 'позвонить маме' }, ctx())
    expect(cancelled).toMatchObject({ ok: true, summary: 'Отменено: позвонить маме' })
    expect((await registry.execute('list_reminders', {}, ctx())).output).toBe('No pending reminders.')
    registry.dispose()
  })
})
