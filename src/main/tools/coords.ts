// Screenshot geometry. A screenshot image shows a rectangle of the global desktop in DIP
// (Electron screen coordinates = macOS points / Windows DIPs) mapped linearly onto its pixels.
import { ToolError } from './errors'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  bounds: Rect
  scaleFactor: number
  primary?: boolean
}

export interface ScreenshotGeometry {
  /** Global DIP rectangle shown by the image. */
  rect: Rect
  imageWidth: number
  imageHeight: number
  /** Displays the image covers. */
  displays: DisplayInfo[]
  takenAt: number
}

/** Smallest region (in screenshot pixels) accepted for a zoom. */
export const MIN_REGION_PX = 8

export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const longest = Math.max(w, h)
  if (longest <= maxSide) return { width: w, height: h }
  const k = maxSide / longest
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

export function unionRect(rects: readonly Rect[]): Rect {
  if (rects.length === 0) throw new Error('unionRect of nothing')
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

function area(r: Rect | null): number {
  return r ? r.width * r.height : 0
}

/** Display showing most of `rect` (nearest one when none intersects). */
export function bestDisplay(rect: Rect, displays: readonly DisplayInfo[]): DisplayInfo {
  if (displays.length === 0) throw new ToolError('No displays found')
  let best = displays[0]
  let bestArea = -1
  for (const d of displays) {
    const a = area(intersect(rect, d.bounds))
    if (a > bestArea) {
      best = d
      bestArea = a
    }
  }
  if (bestArea > 0) return best
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const dist = (d: DisplayInfo): number =>
    Math.hypot(d.bounds.x + d.bounds.width / 2 - cx, d.bounds.y + d.bounds.height / 2 - cy)
  return [...displays].sort((a, b) => dist(a) - dist(b))[0]
}

/** Native pixel size of a display. */
export function nativeSize(d: DisplayInfo): { width: number; height: number } {
  return { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) }
}

/** Geometry a full screenshot of `display` would have (used before any screenshot was taken). */
export function virtualGeometry(display: DisplayInfo, maxSide: number, now = Date.now()): ScreenshotGeometry {
  const size = nativeSize(display)
  const image = fitWithin(size.width, size.height, maxSide)
  return { rect: { ...display.bounds }, imageWidth: image.width, imageHeight: image.height, displays: [display], takenAt: now }
}

/** Screenshot pixel -> global DIP point. Throws when the point is clearly outside the image. */
export function imageToScreen(geo: ScreenshotGeometry, px: number, py: number): Point {
  const slack = 2
  if (px < -slack || py < -slack || px > geo.imageWidth + slack || py > geo.imageHeight + slack) {
    throw new ToolError(
      `Point (${px}, ${py}) is outside the screenshot (${geo.imageWidth}×${geo.imageHeight} px). Use coordinates of the latest screenshot.`
    )
  }
  const x = Math.min(Math.max(px, 0), geo.imageWidth - 1)
  const y = Math.min(Math.max(py, 0), geo.imageHeight - 1)
  return {
    x: geo.rect.x + (x * geo.rect.width) / geo.imageWidth,
    y: geo.rect.y + (y * geo.rect.height) / geo.imageHeight
  }
}

/** Zoom region in screenshot pixels -> global DIP rectangle (clamped to the screenshot). */
export function regionToScreenRect(geo: ScreenshotGeometry, region: Rect): Rect {
  if (region.width < MIN_REGION_PX || region.height < MIN_REGION_PX) {
    throw new ToolError(`Region is too small (min ${MIN_REGION_PX}×${MIN_REGION_PX} px)`)
  }
  const imageRect = { x: 0, y: 0, width: geo.imageWidth, height: geo.imageHeight }
  const clipped = intersect(region, imageRect)
  if (!clipped) {
    throw new ToolError(`Region is outside the previous screenshot (${geo.imageWidth}×${geo.imageHeight} px)`)
  }
  const sx = geo.rect.width / geo.imageWidth
  const sy = geo.rect.height / geo.imageHeight
  return {
    x: geo.rect.x + clipped.x * sx,
    y: geo.rect.y + clipped.y * sy,
    width: clipped.width * sx,
    height: clipped.height * sy
  }
}

/** Crop rectangle in a display capture's own pixels for a global DIP rect. */
export function cropInCapture(display: DisplayInfo, captureWidth: number, captureHeight: number, rect: Rect): Rect {
  const sx = captureWidth / display.bounds.width
  const sy = captureHeight / display.bounds.height
  const x = Math.max(0, Math.floor((rect.x - display.bounds.x) * sx))
  const y = Math.max(0, Math.floor((rect.y - display.bounds.y) * sy))
  const right = Math.min(captureWidth, Math.ceil((rect.x + rect.width - display.bounds.x) * sx))
  const bottom = Math.min(captureHeight, Math.ceil((rect.y + rect.height - display.bounds.y) * sy))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

export interface CompositeLayout {
  union: Rect
  width: number
  height: number
  placements: Array<{ id: number; x: number; y: number; width: number; height: number }>
}

/** One image of all displays: DIP union scaled by a common factor (<= the highest scale factor). */
export function compositeLayout(displays: readonly DisplayInfo[], maxSide: number): CompositeLayout {
  const union = unionRect(displays.map((d) => d.bounds))
  const maxScale = Math.max(...displays.map((d) => d.scaleFactor))
  const k = Math.min(maxScale, maxSide / Math.max(union.width, union.height))
  const width = Math.max(1, Math.round(union.width * k))
  const height = Math.max(1, Math.round(union.height * k))
  const placements = displays.map((d) => {
    const x = Math.round((d.bounds.x - union.x) * k)
    const y = Math.round((d.bounds.y - union.y) * k)
    return {
      id: d.id,
      x,
      y,
      width: Math.max(1, Math.min(width - x, Math.round(d.bounds.width * k))),
      height: Math.max(1, Math.min(height - y, Math.round(d.bounds.height * k)))
    }
  })
  return { union, width, height, placements }
}

/** Copies a 4-byte-per-pixel bitmap into a larger one at (dx, dy), clipping at the edges. */
export function blitBitmap(
  dst: Buffer,
  dstWidth: number,
  dstHeight: number,
  src: Buffer,
  srcWidth: number,
  srcHeight: number,
  dx: number,
  dy: number
): void {
  const x0 = Math.max(0, dx)
  const x1 = Math.min(dstWidth, dx + srcWidth)
  if (x1 <= x0) return
  for (let row = 0; row < srcHeight; row++) {
    const y = dy + row
    if (y < 0 || y >= dstHeight) continue
    const srcStart = (row * srcWidth + (x0 - dx)) * 4
    src.copy(dst, (y * dstWidth + x0) * 4, srcStart, srcStart + (x1 - x0) * 4)
  }
}
