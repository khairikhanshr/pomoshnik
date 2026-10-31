// Tray icons (idle + active variants) with a generated "arc reactor" ring as a fallback when the
// icon files are missing.
import { app, nativeImage, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../log'

const log = createLogger('tray')

export interface TrayIcons {
  idle: NativeImage
  /** Shown while the assistant is listening / thinking / speaking. */
  active: NativeImage
}

const NAMES: Record<'darwin' | 'win32' | 'other', { idle: string[]; active: string[] }> = {
  // Template images: Electron picks @2x and template mode from the file name.
  darwin: { idle: ['trayTemplate.png'], active: ['trayActiveTemplate.png'] },
  win32: { idle: ['tray.ico', 'tray.png'], active: ['tray-active.ico', 'tray-active.png'] },
  other: { idle: ['tray.png'], active: ['tray-active.png'] }
}

function candidateDirs(): string[] {
  const dirs = [
    // Packaged builds: electron-builder extraResources; dev: the project's resources folder.
    app.isPackaged ? join(process.resourcesPath, 'tray') : join(app.getAppPath(), 'resources', 'tray'),
    join(__dirname, '..', '..', 'resources', 'tray'),
    join(process.cwd(), 'resources', 'tray')
  ]
  return [...new Set(dirs)]
}

/** Raw premultiplied BGRA ring + center dot, anti-aliased. */
function ringBitmap(px: number, rgb: [number, number, number]): Buffer {
  const buf = Buffer.alloc(px * px * 4)
  const c = (px - 1) / 2
  const outer = px * 0.46
  const ringWidth = px * 0.13
  const dot = px * 0.17
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const d = Math.hypot(x - c, y - c)
      const ring = Math.min(1, Math.max(0, outer - d + 0.5)) * Math.min(1, Math.max(0, d - (outer - ringWidth) + 0.5))
      const center = Math.min(1, Math.max(0, dot - d + 0.5))
      const a = Math.max(ring, center)
      const i = (y * px + x) * 4
      buf[i] = Math.round(rgb[2] * a)
      buf[i + 1] = Math.round(rgb[1] * a)
      buf[i + 2] = Math.round(rgb[0] * a)
      buf[i + 3] = Math.round(255 * a)
    }
  }
  return buf
}

function fallbackIcon(platform: NodeJS.Platform): NativeImage {
  const template = platform === 'darwin'
  const dip = template ? 18 : 16
  const image = nativeImage.createFromBitmap(ringBitmap(dip * 2, template ? [0, 0, 0] : [58, 216, 255]), {
    width: dip * 2,
    height: dip * 2,
    scaleFactor: 2
  })
  if (template) image.setTemplateImage(true)
  return image
}

function loadFirst(platform: NodeJS.Platform, names: string[]): NativeImage | null {
  for (const dir of candidateDirs()) {
    for (const name of names) {
      const file = join(dir, name)
      if (!existsSync(file)) continue
      let image = nativeImage.createFromPath(file)
      if (image.isEmpty()) continue
      if (platform === 'darwin') image.setTemplateImage(true)
      else if (name.endsWith('.png') && image.getSize().width > 32) {
        image = image.resize({ width: 32, height: 32, quality: 'best' })
      }
      return image
    }
  }
  return null
}

export function loadTrayIcons(platform: NodeJS.Platform): TrayIcons {
  const names = NAMES[platform === 'darwin' || platform === 'win32' ? platform : 'other']
  let idle = loadFirst(platform, names.idle)
  if (!idle) {
    log.warn('tray icon files not found, using a generated icon')
    idle = fallbackIcon(platform)
  }
  return { idle, active: loadFirst(platform, names.active) ?? idle }
}
