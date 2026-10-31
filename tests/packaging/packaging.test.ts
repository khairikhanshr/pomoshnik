// Packaging checks: generated icons (app + tray) and the electron-builder configuration.
// Icons are produced by scripts/gen-icons.mjs; this suite validates the committed files and the script's output.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const p = (...parts: string[]): string => join(ROOT, ...parts)

// ---------------------------------------------------------------------------------------------
// Minimal readers (no extra dependencies)
// ---------------------------------------------------------------------------------------------
interface Png {
  width: number
  height: number
  colorType: number
  bitDepth: number
  /** RGBA8 pixels (decoded only for 8-bit RGBA, non-interlaced images — what resvg writes). */
  rgba: Uint8Array
}

function decodePng(buf: Buffer): Png {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    return { width, height, colorType, bitDepth, rgba: new Uint8Array(0) }
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pr = a + b - c
        const pa = Math.abs(pr - a)
        const pb = Math.abs(pr - b)
        const pc = Math.abs(pr - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`)
      out[y * stride + x] = v & 255
    }
  }
  return { width, height, colorType, bitDepth, rgba: out }
}

/** Sizes (px) of the images in an .ico file. */
function icoSizes(buf: Buffer): number[] {
  expect(buf.readUInt16LE(0)).toBe(0)
  expect(buf.readUInt16LE(2)).toBe(1)
  const count = buf.readUInt16LE(4)
  const sizes: number[] = []
  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i
    const w = buf[o] || 256
    const h = buf[o + 1] || 256
    expect(w).toBe(h)
    const bytes = buf.readUInt32LE(o + 8)
    const offset = buf.readUInt32LE(o + 12)
    expect(offset + bytes).toBeLessThanOrEqual(buf.length)
    sizes.push(w)
  }
  return sizes.sort((a, b) => a - b)
}

/** Entry types of an .icns file → payload. */
function icnsEntries(buf: Buffer): Map<string, Buffer> {
  expect(buf.toString('ascii', 0, 4)).toBe('icns')
  expect(buf.readUInt32BE(4)).toBe(buf.length)
  const entries = new Map<string, Buffer>()
  let pos = 8
  while (pos < buf.length) {
    const type = buf.toString('ascii', pos, pos + 4)
    const len = buf.readUInt32BE(pos + 4)
    expect(len).toBeGreaterThan(8)
    entries.set(type, buf.subarray(pos + 8, pos + len))
    pos += len
  }
  return entries
}

const pngAt = (...parts: string[]): Png => decodePng(readFileSync(p(...parts)))

/** Share of pixels with any opacity. */
function coverage(png: Png): number {
  let n = 0
  for (let i = 3; i < png.rgba.length; i += 4) if (png.rgba[i] > 0) n++
  return n / (png.width * png.height)
}

// ---------------------------------------------------------------------------------------------
// App icon
// ---------------------------------------------------------------------------------------------
describe('app icon', () => {
  it('build/icon.png is a 1024 px RGBA master with a transparent macOS margin', () => {
    const png = pngAt('build', 'icon.png')
    expect([png.width, png.height]).toEqual([1024, 1024])
    expect(png.colorType).toBe(6)
    const alpha = (x: number, y: number): number => png.rgba[(y * png.width + x) * 4 + 3]
    expect(alpha(4, 4)).toBe(0) // corner outside the tile
    expect(alpha(512, 512)).toBe(255) // reactor core
    expect(alpha(512, 140)).toBe(255) // inside the 824 px tile
  })

  it('build/icon.icns contains every macOS representation up to 1024 px', () => {
    const entries = icnsEntries(readFileSync(p('build', 'icon.icns')))
    const expected: Record<string, number> = { ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 }
    for (const [type, size] of Object.entries(expected)) {
      const data = entries.get(type)
      expect(data, `icns entry ${type}`).toBeDefined()
      const png = decodePng(data as Buffer)
      expect([png.width, png.height]).toEqual([size, size])
    }
    // 16 px (1x) representation: PNG (icp4) or ARGB (ic04), depending on the writer
    expect(entries.has('ic04') || entries.has('icp4')).toBe(true)
  })

  it('build/icon.ico contains 16…256 px images for Windows', () => {
    const sizes = icoSizes(readFileSync(p('build', 'icon.ico')))
    for (const s of [16, 24, 32, 48, 64, 128, 256]) expect(sizes).toContain(s)
  })
})

// ---------------------------------------------------------------------------------------------
// Tray icons
// ---------------------------------------------------------------------------------------------
describe('tray icons', () => {
  const templates: Array<[string, number]> = [
    ['trayTemplate.png', 16],
    ['trayTemplate@2x.png', 32],
    ['trayActiveTemplate.png', 16],
    ['trayActiveTemplate@2x.png', 32]
  ]

  it.each(templates)('%s is a %i px black-on-transparent template image', (file, size) => {
    const png = pngAt('resources', 'tray', file)
    expect([png.width, png.height]).toEqual([size, size])
    let visible = 0
    for (let i = 0; i < png.rgba.length; i += 4) {
      if (png.rgba[i + 3] === 0) continue
      visible++
      // template images must be pure black; macOS only uses the alpha channel
      expect(png.rgba[i] + png.rgba[i + 1] + png.rgba[i + 2]).toBe(0)
    }
    expect(visible).toBeGreaterThan(size * size * 0.2)
    expect(coverage(png)).toBeLessThan(1)
  })

  it('the active (listening) template is visibly heavier than the idle one', () => {
    for (const suffix of ['', '@2x']) {
      const idle = coverage(pngAt('resources', 'tray', `trayTemplate${suffix}.png`))
      const active = coverage(pngAt('resources', 'tray', `trayActiveTemplate${suffix}.png`))
      expect(active).toBeGreaterThan(idle * 1.15)
    }
  })

  it.each(['tray.png', 'tray-active.png'])('%s is a 32 px coloured icon', (file) => {
    const png = pngAt('resources', 'tray', file)
    expect([png.width, png.height]).toEqual([32, 32])
    const center = (16 * 32 + 16) * 4
    expect(png.rgba[center + 3]).toBe(255)
    expect(png.rgba[3]).toBe(0) // transparent corner (round icon)
  })

  it.each(['tray.ico', 'tray-active.ico'])('%s has the Windows notification-area sizes', (file) => {
    const sizes = icoSizes(readFileSync(p('resources', 'tray', file)))
    for (const s of [16, 20, 24, 32, 40, 48]) expect(sizes).toContain(s)
  })
})

// ---------------------------------------------------------------------------------------------
// Installer artwork (picked up by electron-builder from build/ by file name)
// ---------------------------------------------------------------------------------------------
describe('installer artwork', () => {
  it('build/installerSidebar.bmp is a 164×314 24-bit BMP for the NSIS welcome/finish pages', () => {
    const bmp = readFileSync(p('build', 'installerSidebar.bmp'))
    expect(bmp.toString('ascii', 0, 2)).toBe('BM')
    expect(bmp.readUInt32LE(2)).toBe(bmp.length)
    expect(bmp.readInt32LE(18)).toBe(164)
    expect(bmp.readInt32LE(22)).toBe(314)
    expect(bmp.readUInt16LE(28)).toBe(24)
  })

  it('build/background.png (+@2x) matches the 540×380 DMG window', () => {
    const bg = pngAt('build', 'background.png')
    const bg2 = pngAt('build', 'background@2x.png')
    expect([bg.width, bg.height]).toEqual([540, 380])
    expect([bg2.width, bg2.height]).toEqual([1080, 760])
  })
})

// ---------------------------------------------------------------------------------------------
// Generator script
// ---------------------------------------------------------------------------------------------
describe('scripts/gen-icons.mjs', () => {
  it('renders every artwork at the exact requested pixel size', async () => {
    const mod = (await import(pathToFileURL(p('scripts', 'gen-icons.mjs')).href)) as {
      appIconSvg: (px: number, platform?: 'mac' | 'win') => string
      trayTemplateSvg: (px: number, active: boolean) => string
      trayColorSvg: (px: number, active: boolean) => string
      render: (svg: string, px: number) => Buffer
    }
    const cases: Array<[string, number]> = [
      [mod.appIconSvg(16, 'mac'), 16],
      [mod.appIconSvg(64, 'win'), 64],
      [mod.appIconSvg(256, 'mac'), 256],
      [mod.trayTemplateSvg(32, false), 32],
      [mod.trayTemplateSvg(16, true), 16],
      [mod.trayColorSvg(20, true), 20]
    ]
    for (const [svg, px] of cases) {
      expect(svg.startsWith('<svg')).toBe(true)
      const png = decodePng(mod.render(svg, px))
      expect([png.width, png.height]).toEqual([px, px])
      expect(coverage(png)).toBeGreaterThan(0.2)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// electron-builder configuration
// ---------------------------------------------------------------------------------------------
interface BuilderConfig {
  appId: string
  productName: string
  directories: { buildResources: string; output: string }
  files: string[]
  asar: boolean
  electronLanguages: string[]
  extraResources: Array<{ from: string; to: string }>
  electronFuses?: Record<string, boolean>
  mac: {
    icon: string
    target: Array<string | { target: string }>
    identity: string | null
    entitlements: string
    entitlementsInherit: string
    extendInfo: Record<string, unknown>
  }
  win: { icon: string; target: Array<{ target: string; arch: string[] }> }
  nsis: Record<string, unknown>
}

describe('electron-builder.yml', () => {
  const require = createRequire(import.meta.url)
  const yaml = require('js-yaml') as { load: (text: string) => unknown }
  const config = yaml.load(readFileSync(p('electron-builder.yml'), 'utf8')) as BuilderConfig
  const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8')) as { main: string; scripts: Record<string, string> }

  it('identifies the app', () => {
    expect(config.appId).toBe('com.pomoshnik.jarvis')
    expect(config.productName).toBe('Jarvis')
    expect(config.directories).toEqual({ buildResources: 'build', output: 'release' })
  })

  it('ships out/** (incl. renderer model/wasm assets) without source maps', () => {
    expect(config.files).toContain('out/**/*')
    expect(config.files).toContain('package.json')
    expect(config.files).toContain('!**/*.map')
    expect(config.asar).toBe(true)
    expect(pkg.main.replace(/^\.\//, '').startsWith('out/')).toBe(true)
  })

  it('copies the tray icons to <resources>/tray', () => {
    expect(config.extraResources).toContainEqual(expect.objectContaining({ from: 'resources/tray', to: 'tray' }))
  })

  it('keeps only Russian and English Electron locales', () => {
    expect(config.electronLanguages).toEqual(['ru', 'en'])
  })

  it('disables the Node.js escape hatches of the Electron binary', () => {
    expect(config.electronFuses?.runAsNode).toBe(false)
    expect(config.electronFuses?.enableNodeCliInspectArguments).toBe(false)
    expect(config.electronFuses?.enableNodeOptionsEnvironmentVariable).toBe(false)
  })

  it('builds an ad-hoc signed macOS dmg + zip with usage descriptions', () => {
    const targets = config.mac.target.map((t) => (typeof t === 'string' ? t : t.target))
    expect(targets).toEqual(expect.arrayContaining(['dmg', 'zip']))
    expect(config.mac.identity).toBe('-')
    expect(existsSync(p(config.mac.icon))).toBe(true)
    expect(existsSync(p(config.mac.entitlements))).toBe(true)
    expect(existsSync(p(config.mac.entitlementsInherit))).toBe(true)
    for (const key of [
      'NSMicrophoneUsageDescription',
      'NSAppleEventsUsageDescription',
      'NSScreenCaptureUsageDescription',
      'NSAccessibilityUsageDescription'
    ]) {
      expect(typeof config.mac.extendInfo[key]).toBe('string')
      expect(String(config.mac.extendInfo[key])).toMatch(/[А-Яа-яЁё]/)
    }
    // architectures are passed on the command line
    expect(pkg.scripts['dist:mac']).toMatch(/--arm64/)
    expect(pkg.scripts['dist:mac']).toMatch(/--x64/)
  })

  it('builds a per-user NSIS installer for Windows x64 in Russian and English', () => {
    expect(config.win.target).toContainEqual({ target: 'nsis', arch: ['x64'] })
    expect(existsSync(p(config.win.icon))).toBe(true)
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true
    })
    expect(config.nsis.installerLanguages).toEqual(['ru_RU', 'en_US'])
    const include = String(config.nsis.include)
    expect(existsSync(p(include))).toBe(true)
    expect(readFileSync(p(include), 'utf8')).toMatch(/!macro customUnInstall[\s\S]*!macroend/)
  })
})
