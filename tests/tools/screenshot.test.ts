import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/defaults'
import type { Settings } from '../../src/shared/types'
import { AppBus } from '../../src/main/bus'
import type { MediaStore, SettingsStore, WindowService } from '../../src/main/services'
import type { ToolContext, ToolHost } from '../../src/main/tools/types'
import { mockState } from './electron-mock'

vi.mock('electron', async () => (await import('./electron-mock')).electronMock())

const execMock = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../src/main/tools/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/tools/exec')>()
  return { ...actual, run: execMock.run }
})

import { desktopCapturer, nativeImage } from 'electron'
import { createToolRegistry } from '../../src/main/tools'
import { ScreenshotService } from '../../src/main/tools/screenshot'

/** Just enough of NativeImage for the capture pipeline. */
class FakeImage {
  readonly crops: Array<{ x: number; y: number; width: number; height: number }> = []
  constructor(
    readonly width: number,
    readonly height: number
  ) {}
  isEmpty(): boolean {
    return false
  }
  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }
  crop(rect: { x: number; y: number; width: number; height: number }): FakeImage {
    this.crops.push(rect)
    return new FakeImage(rect.width, rect.height)
  }
  resize(opts: { width: number; height: number }): FakeImage {
    return new FakeImage(opts.width, opts.height)
  }
  toBitmap(): Buffer {
    return Buffer.alloc(this.width * this.height * 4, 0x7f)
  }
  toPNG(): Buffer {
    return Buffer.from('png')
  }
  toJPEG(): Buffer {
    return Buffer.from('jpg')
  }
}

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function makeHost(platform: NodeJS.Platform) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-shot-'))
  dirs.push(dir)
  const settings: Settings = structuredClone(DEFAULT_SETTINGS)
  const saved: Array<{ width?: number; height?: number }> = []
  const withUiHidden = vi.fn(async <T>(fn: () => Promise<T>) => fn())
  const host: ToolHost = {
    settings: { get: () => settings } as unknown as SettingsStore,
    media: {
      save: (_data: Buffer, opts: { kind: 'screenshot' | 'upload'; width?: number; height?: number }) => {
        saved.push(opts)
        return { id: `img${saved.length}`, url: `jarvis-media://image/img${saved.length}`, kind: opts.kind, width: opts.width, height: opts.height }
      }
    } as unknown as MediaStore,
    windows: { withUiHidden, getMainWindow: () => null, hideMain: vi.fn(), hideOverlay: vi.fn() } as unknown as WindowService,
    bus: new AppBus(),
    userDataDir: dir,
    platform
  }
  return { host, saved, withUiHidden }
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const retina = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, label: 'Built-in' }
const external = { id: 2, bounds: { x: 1512, y: -200, width: 1920, height: 1080 }, scaleFactor: 1, label: 'External' }

function sources(images: Record<number, FakeImage>) {
  vi.mocked(desktopCapturer.getSources).mockResolvedValue(
    Object.entries(images).map(([id, thumbnail]) => ({ id: `screen:${id}:0`, display_id: id, name: 'Screen', thumbnail })) as never
  )
}

beforeEach(() => {
  mockState.displays = [retina]
  mockState.cursor = { x: 10, y: 10 }
  mockState.screenAccess = 'granted'
  mockState.trusted = true
  execMock.run.mockReset().mockResolvedValue({ code: 0, signal: null, stdout: '{"x":0,"y":0}', stderr: '', timedOut: false, truncated: false })
  vi.mocked(desktopCapturer.getSources).mockReset()
  vi.mocked(nativeImage.createFromBitmap).mockReset()
})

describe('ScreenshotService', () => {
  it('captures at native resolution with the UI hidden, downscales and remembers the geometry per chat', async () => {
    const { host, saved, withUiHidden } = makeHost('darwin')
    const service = new ScreenshotService(host, log)
    sources({ 1: new FakeImage(3024, 1964) })
    const shot = await service.capture({ display: 'cursor', chatId: 'c1' })
    expect(withUiHidden).toHaveBeenCalledTimes(1)
    expect(desktopCapturer.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 3024, height: 1964 }, fetchWindowIcons: false })
    expect(saved[0]).toMatchObject({ kind: 'screenshot', mime: 'image/png', width: 2560, height: 1663 })
    expect(shot.geometry.rect).toEqual(retina.bounds)
    expect(shot.description).toMatch(/image 2560×1663 px/)
    expect(shot.description).toMatch(/x 0-2559, y 0-1662/)
    expect(service.geometryFor('c1')).toEqual(shot.geometry)
    expect(service.geometryFor('c2')).toBeNull()
  })

  it('zooms into a region of the previous screenshot at native resolution', async () => {
    const { host } = makeHost('darwin')
    const service = new ScreenshotService(host, log)
    const full = new FakeImage(3024, 1964)
    sources({ 1: full })
    await service.capture({ display: 'cursor', chatId: 'c1' })
    sources({ 1: full })
    const zoom = await service.capture({ display: 'cursor', chatId: 'c1', region: { x: 1280, y: 0, width: 640, height: 400 } })
    expect(full.crops.at(-1)).toEqual({ x: 1512, y: 0, width: 756, height: 473 })
    expect(zoom.geometry.imageWidth).toBe(756)
    expect(zoom.geometry.rect.x).toBeCloseTo(756, 5)
    expect(zoom.geometry.rect.width).toBeCloseTo(378, 5)
    expect(zoom.description).toMatch(/^Zoomed region/)
    expect(service.geometryFor('c1')).toEqual(zoom.geometry)
  })

  it('composes all displays into one image', async () => {
    mockState.displays = [retina, external]
    const { host, saved } = makeHost('darwin')
    const service = new ScreenshotService(host, log)
    sources({ 1: new FakeImage(3024, 1964), 2: new FakeImage(1920, 1080) })
    vi.mocked(nativeImage.createFromBitmap).mockImplementation(((_buf: Buffer, size: { width: number; height: number }) =>
      new FakeImage(size.width, size.height)) as never)
    const shot = await service.capture({ display: 'all', chatId: 'c1' })
    expect(nativeImage.createFromBitmap).toHaveBeenCalledWith(expect.any(Buffer), { width: 2560, height: 882 })
    expect(saved[0]).toMatchObject({ width: 2560, height: 882 })
    expect(shot.geometry.rect).toEqual({ x: 0, y: -200, width: 3432, height: 1182 })
    expect(shot.description).toMatch(/all 2 displays/)
  })

  it('uses the newer composer screenshot for a chat without its own', async () => {
    const { host } = makeHost('darwin')
    const service = new ScreenshotService(host, log)
    sources({ 1: new FakeImage(3024, 1964) })
    const composer = await service.capture({ display: 'cursor' })
    expect(service.geometryFor('any-chat')).toEqual(composer.geometry)
  })
})

describe('screenshot -> mouse mapping', () => {
  const ctx = (): ToolContext => ({ chatId: 'chat1', turnId: 't1', source: 'text', settings: DEFAULT_SETTINGS, signal: new AbortController().signal })

  it('macOS: clicks at the DIP point of the screenshot pixel (JXA payload, not executed)', async () => {
    const { host } = makeHost('darwin')
    const registry = createToolRegistry(host)
    sources({ 1: new FakeImage(3024, 1964) })
    expect((await registry.execute('take_screenshot', {}, ctx())).ok).toBe(true)
    const result = await registry.execute('mouse', { action: 'click', x: 1280, y: 831.5 }, ctx())
    expect(result.ok).toBe(true)
    const [command, argv] = execMock.run.mock.calls.at(-1) as [string, string[]]
    expect(command).toBe('/usr/bin/osascript')
    const payload = JSON.parse(argv[argv.length - 1]) as { action: string; x: number; y: number }
    expect(payload.action).toBe('click')
    expect(payload.x).toBeCloseTo(756, 3)
    expect(payload.y).toBeCloseTo(491, 0)
    registry.dispose()
  })

  it('Windows: converts DIPs to physical pixels for the DPI-aware script', async () => {
    mockState.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5, label: 'Laptop' }]
    const { host } = makeHost('win32')
    const registry = createToolRegistry(host)
    sources({ 1: new FakeImage(1920, 1080) })
    expect((await registry.execute('take_screenshot', {}, ctx())).ok).toBe(true)
    execMock.run.mockResolvedValue({ code: 0, signal: null, stdout: '@@JARVIS_RESULT@@{"x":1440,"y":810}', stderr: '', timedOut: false, truncated: false })
    expect((await registry.execute('mouse', { action: 'double_click', x: 1440, y: 810 }, ctx())).ok).toBe(true)
    const [, , opts] = execMock.run.mock.calls.at(-1) as [string, string[], { env: Record<string, string> }]
    // image pixel 1440 -> DIP 960 -> physical 1440 at 150 %
    expect(JSON.parse(opts.env.JARVIS_ARGS)).toEqual({ action: 'double_click', x: 1440, y: 810, dy: 0 })
    registry.dispose()
  })
})
