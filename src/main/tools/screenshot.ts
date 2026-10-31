// Screen capture: desktopCapturer at native resolution with Jarvis' windows hidden, optional zoom
// region, downscale, MediaStore save. The geometry of the latest screenshot per chat maps `mouse`
// coordinates back to the screen.
import { desktopCapturer, nativeImage, screen, type DesktopCapturerSource, type NativeImage } from 'electron'
import { LIMITS } from '@shared/defaults'
import type { ImageRef } from '@shared/types'
import type { Logger } from '../log'
import {
  bestDisplay,
  blitBitmap,
  compositeLayout,
  cropInCapture,
  fitWithin,
  intersect,
  nativeSize,
  regionToScreenRect,
  virtualGeometry,
  type DisplayInfo,
  type Rect,
  type ScreenshotGeometry
} from './coords'
import { ToolError } from './errors'
import { ensureScreenAccess } from './mac/permissions'
import type { ToolHost } from './types'

export type DisplayChoice = 'cursor' | 'primary' | 'all'

export interface CaptureRequest {
  display: DisplayChoice
  /** Zoom region in pixels of the previous screenshot. */
  region?: Rect
  chatId?: string
}

export interface CaptureResult {
  image: ImageRef
  geometry: ScreenshotGeometry
  /** For the model: image size and coordinate system. */
  description: string
  /** Russian, for the UI. */
  summary: string
}

const PNG_MAX_BYTES = 3 * 1024 * 1024
const MAX_REMEMBERED_CHATS = 50
/** A composer screenshot newer than the chat's last take_screenshot wins for mouse mapping. */
const COMPOSER_TTL_MS = 30 * 60 * 1000

export function currentDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: { ...d.bounds },
    scaleFactor: d.scaleFactor || 1,
    primary: d.id === primary
  }))
}

function toInfo(id: number, displays: DisplayInfo[]): DisplayInfo {
  return displays.find((d) => d.id === id) ?? displays[0]
}

export function chooseDisplay(choice: DisplayChoice, displays: DisplayInfo[]): DisplayInfo {
  if (choice === 'cursor') return toInfo(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id, displays)
  return toInfo(screen.getPrimaryDisplay().id, displays)
}

function matchSource(sources: DesktopCapturerSource[], display: DisplayInfo, displays: DisplayInfo[]): DesktopCapturerSource {
  const byId = sources.find((s) => s.display_id === String(display.id))
  if (byId) return byId
  if (sources.length === 1) return sources[0]
  const index = displays.findIndex((d) => d.id === display.id)
  if (sources.length === displays.length && index >= 0) return sources[index]
  throw new ToolError('Could not match the display to a capture source')
}

function encode(img: NativeImage): { data: Buffer; mime: 'image/png' | 'image/jpeg' } {
  const png = img.toPNG()
  if (png.length <= PNG_MAX_BYTES) return { data: png, mime: 'image/png' }
  return { data: img.toJPEG(90), mime: 'image/jpeg' }
}

function describeDisplay(d: DisplayInfo, displays: DisplayInfo[]): string {
  const index = displays.findIndex((x) => x.id === d.id) + 1
  const role = d.primary ? 'primary, ' : ''
  return `display ${index} of ${displays.length} (${role}${d.bounds.width}×${d.bounds.height} pt at scale ${d.scaleFactor})`
}

export class ScreenshotService {
  private readonly byChat = new Map<string, ScreenshotGeometry>()
  private composer: ScreenshotGeometry | null = null

  constructor(
    private readonly host: ToolHost,
    private readonly log: Logger
  ) {}

  /** Geometry `mouse` coordinates refer to: the newest screenshot of this chat or of the composer. */
  geometryFor(chatId: string | undefined, now = Date.now()): ScreenshotGeometry | null {
    const chat = chatId ? this.byChat.get(chatId) : undefined
    const composer = this.composer && now - this.composer.takenAt < COMPOSER_TTL_MS ? this.composer : null
    if (chat && composer) return composer.takenAt > chat.takenAt ? composer : chat
    return chat ?? composer
  }

  private remember(chatId: string | undefined, geometry: ScreenshotGeometry): void {
    if (!chatId) {
      this.composer = geometry
      return
    }
    this.byChat.delete(chatId)
    this.byChat.set(chatId, geometry)
    if (this.byChat.size > MAX_REMEMBERED_CHATS) {
      const oldest = this.byChat.keys().next().value
      if (oldest !== undefined) this.byChat.delete(oldest)
    }
  }

  forget(chatId: string): void {
    this.byChat.delete(chatId)
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    ensureScreenAccess(this.host.platform)
    const displays = currentDisplays()
    if (displays.length === 0) throw new ToolError('No displays found')
    const maxSide = LIMITS.screenshotMaxSide

    if (req.region) {
      const base = chooseDisplay(req.display === 'all' ? 'primary' : req.display, displays)
      const previous = this.geometryFor(req.chatId) ?? virtualGeometry(base, maxSide)
      const wanted = regionToScreenRect(previous, req.region)
      const display = bestDisplay(wanted, displays)
      const rect = intersect(wanted, display.bounds)
      if (!rect) throw new ToolError('The region is not on any display')
      return this.captureDisplay(display, displays, rect, req.chatId, true)
    }
    if (req.display === 'all' && displays.length > 1) return this.captureAll(displays, req.chatId)
    const display = chooseDisplay(req.display, displays)
    return this.captureDisplay(display, displays, display.bounds, req.chatId, false)
  }

  private async grab(size: { width: number; height: number }): Promise<DesktopCapturerSource[]> {
    const sources = await this.host.windows.withUiHidden(() =>
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size, fetchWindowIcons: false })
    )
    if (sources.length === 0) throw new ToolError('Screen capture returned no screens')
    return sources
  }

  private async captureDisplay(
    display: DisplayInfo,
    displays: DisplayInfo[],
    rect: Rect,
    chatId: string | undefined,
    zoom: boolean
  ): Promise<CaptureResult> {
    const sources = await this.grab(nativeSize(display))
    let img = matchSource(sources, display, displays).thumbnail
    if (img.isEmpty()) throw new ToolError('Screen capture returned an empty image')
    const full = img.getSize()
    const crop = cropInCapture(display, full.width, full.height, rect)
    if (crop.width < full.width || crop.height < full.height) img = img.crop(crop)
    const sx = display.bounds.width / full.width
    const sy = display.bounds.height / full.height
    const shown: Rect = {
      x: display.bounds.x + crop.x * sx,
      y: display.bounds.y + crop.y * sy,
      width: crop.width * sx,
      height: crop.height * sy
    }
    return this.finish(img, shown, [display], chatId, (w, h) =>
      zoom
        ? `Zoomed region of ${describeDisplay(display, displays)}: screen area x=${Math.round(shown.x)}, y=${Math.round(shown.y)}, ` +
          `${Math.round(shown.width)}×${Math.round(shown.height)} pt, image ${w}×${h} px.`
        : `Screenshot of ${describeDisplay(display, displays)}, image ${w}×${h} px.`
    )
  }

  private async captureAll(displays: DisplayInfo[], chatId: string | undefined): Promise<CaptureResult> {
    const layout = compositeLayout(displays, LIMITS.screenshotMaxSide)
    const largest = displays.map(nativeSize).reduce((a, b) => ({ width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) }))
    const sources = await this.grab(largest)
    const canvas = Buffer.alloc(layout.width * layout.height * 4)
    for (const place of layout.placements) {
      const display = displays.find((d) => d.id === place.id)
      if (!display) continue
      const thumb = matchSource(sources, display, displays).thumbnail
      if (thumb.isEmpty()) continue
      const part = thumb.resize({ width: place.width, height: place.height, quality: 'best' })
      const size = part.getSize()
      const bitmap = part.toBitmap()
      if (bitmap.length !== size.width * size.height * 4) {
        this.log.warn('unexpected bitmap layout, display skipped', place.id)
        continue
      }
      blitBitmap(canvas, layout.width, layout.height, bitmap, size.width, size.height, place.x, place.y)
    }
    const img = nativeImage.createFromBitmap(canvas, { width: layout.width, height: layout.height })
    return this.finish(img, layout.union, displays, chatId, (w, h) => {
      const parts = displays.map((d) => {
        const p = layout.placements.find((x) => x.id === d.id)
        return p ? `${describeDisplay(d, displays)} at image x=${p.x}, y=${p.y}, ${p.width}×${p.height} px` : ''
      })
      return `Screenshot of all ${displays.length} displays combined, image ${w}×${h} px: ${parts.filter(Boolean).join('; ')}.`
    })
  }

  private finish(
    source: NativeImage,
    rect: Rect,
    displays: DisplayInfo[],
    chatId: string | undefined,
    describe: (w: number, h: number) => string
  ): CaptureResult {
    let img = source
    const size = img.getSize()
    const target = fitWithin(size.width, size.height, LIMITS.screenshotMaxSide)
    if (target.width !== size.width || target.height !== size.height) {
      img = img.resize({ width: target.width, height: target.height, quality: 'best' })
    }
    const final = img.getSize()
    const { data, mime } = encode(img)
    const image = this.host.media.save(data, { kind: 'screenshot', mime, width: final.width, height: final.height })
    const geometry: ScreenshotGeometry = {
      rect,
      imageWidth: final.width,
      imageHeight: final.height,
      displays,
      takenAt: Date.now()
    }
    this.remember(chatId, geometry)
    const description =
      `${describe(final.width, final.height)} Coordinates for the mouse tool are pixels of this image ` +
      `(origin top-left, x 0-${final.width - 1}, y 0-${final.height - 1}). To read small text, call take_screenshot ` +
      'again with region {x, y, width, height} in these pixel coordinates.'
    return { image, geometry, description, summary: `${final.width}×${final.height}` }
  }
}
