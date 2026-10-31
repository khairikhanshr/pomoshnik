import { describe, expect, it } from 'vitest'
import {
  bestDisplay,
  blitBitmap,
  compositeLayout,
  cropInCapture,
  fitWithin,
  imageToScreen,
  regionToScreenRect,
  virtualGeometry,
  type DisplayInfo,
  type ScreenshotGeometry
} from '../../src/main/tools/coords'

const retina: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, primary: true }
// External monitor to the right, top edge 200 pt above the laptop's.
const external: DisplayInfo = { id: 2, bounds: { x: 1512, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 }
// Windows laptop at 150 % scaling: DIP bounds, physical 1920×1080.
const win150: DisplayInfo = { id: 3, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5, primary: true }

describe('fitWithin', () => {
  it('downscales the longest side and keeps small images', () => {
    expect(fitWithin(5120, 2880, 2560)).toEqual({ width: 2560, height: 1440 })
    expect(fitWithin(3024, 1964, 2560)).toEqual({ width: 2560, height: 1663 })
    expect(fitWithin(1000, 500, 2560)).toEqual({ width: 1000, height: 500 })
  })
})

describe('image -> screen mapping', () => {
  it('accounts for the scale factor and the downscale', () => {
    const geo = virtualGeometry(retina, 2560)
    expect(geo.imageWidth).toBe(2560)
    expect(geo.imageHeight).toBe(1663)
    const center = imageToScreen(geo, 1280, 831.5)
    expect(center.x).toBeCloseTo(756, 5)
    expect(center.y).toBeCloseTo(491, 0)
    expect(imageToScreen(geo, 0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('adds the display offset (secondary display left/above the primary origin)', () => {
    const geo = virtualGeometry(external, 2560)
    expect(geo.imageWidth).toBe(1920)
    expect(imageToScreen(geo, 100, 50)).toEqual({ x: 1612, y: -150 })
  })

  it('maps Windows high-DPI captures back to DIPs', () => {
    const geo = virtualGeometry(win150, 2560)
    expect(geo.imageWidth).toBe(1920)
    expect(geo.imageHeight).toBe(1080)
    expect(imageToScreen(geo, 960, 540)).toEqual({ x: 640, y: 360 })
  })

  it('clamps tiny overshoots and rejects points outside the image', () => {
    const geo = virtualGeometry(external, 2560)
    expect(imageToScreen(geo, 1921, 1080).x).toBeCloseTo(1512 + (1919 * 1920) / 1920, 5)
    expect(() => imageToScreen(geo, 2500, 10)).toThrow(/outside the screenshot/)
    expect(() => imageToScreen(geo, -50, 10)).toThrow(/outside/)
  })
})

describe('zoom regions', () => {
  it('converts a region of the previous screenshot to a screen rectangle', () => {
    const geo = virtualGeometry(retina, 2560)
    const rect = regionToScreenRect(geo, { x: 1280, y: 0, width: 1280, height: 1663 })
    expect(rect.x).toBeCloseTo(756, 5)
    expect(rect.y).toBe(0)
    expect(rect.width).toBeCloseTo(756, 5)
    expect(rect.height).toBeCloseTo(982, 5)
  })

  it('maps clicks in a zoomed image (nested zoom keeps working)', () => {
    const zoomed: ScreenshotGeometry = {
      rect: { x: 1612, y: -100, width: 400, height: 300 },
      imageWidth: 400,
      imageHeight: 300,
      displays: [external],
      takenAt: 0
    }
    expect(imageToScreen(zoomed, 200, 150)).toEqual({ x: 1812, y: 50 })
    const inner = regionToScreenRect(zoomed, { x: 100, y: 100, width: 100, height: 50 })
    expect(inner).toEqual({ x: 1712, y: 0, width: 100, height: 50 })
  })

  it('clips regions to the image and rejects useless ones', () => {
    const geo = virtualGeometry(external, 2560)
    expect(regionToScreenRect(geo, { x: 1800, y: 1000, width: 400, height: 400 })).toEqual({ x: 3312, y: 800, width: 120, height: 80 })
    expect(() => regionToScreenRect(geo, { x: 0, y: 0, width: 4, height: 100 })).toThrow(/too small/)
    expect(() => regionToScreenRect(geo, { x: 5000, y: 5000, width: 100, height: 100 })).toThrow(/outside/)
  })

  it('crops in capture pixels', () => {
    const rect = { x: 756, y: 100, width: 100, height: 50 }
    expect(cropInCapture(retina, 3024, 1964, rect)).toEqual({ x: 1512, y: 200, width: 200, height: 100 })
    expect(cropInCapture(external, 1920, 1080, { x: 1612, y: -150, width: 10, height: 10 })).toEqual({ x: 100, y: 50, width: 10, height: 10 })
  })
})

describe('displays', () => {
  it('picks the display that shows most of a rectangle, else the nearest', () => {
    expect(bestDisplay({ x: 1400, y: 0, width: 400, height: 100 }, [retina, external]).id).toBe(2)
    expect(bestDisplay({ x: 100, y: 100, width: 10, height: 10 }, [retina, external]).id).toBe(1)
    expect(bestDisplay({ x: 9000, y: 0, width: 10, height: 10 }, [retina, external]).id).toBe(2)
  })

  it('lays out all displays on one canvas', () => {
    const layout = compositeLayout([retina, external], 2560)
    expect(layout.union).toEqual({ x: 0, y: -200, width: 3432, height: 1182 })
    const k = 2560 / 3432
    expect(layout.width).toBe(2560)
    expect(layout.height).toBe(Math.round(1182 * k))
    expect(layout.placements[0]).toMatchObject({ id: 1, x: 0, y: Math.round(200 * k) })
    expect(layout.placements[1]).toMatchObject({ id: 2, x: Math.round(1512 * k), y: 0 })
  })

  it('never upscales beyond the highest scale factor', () => {
    const small: DisplayInfo = { id: 9, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 }
    const layout = compositeLayout([small, { ...small, id: 10, bounds: { ...small.bounds, x: 800 } }], 2560)
    expect(layout.width).toBe(1600)
    expect(layout.height).toBe(600)
  })

  it('blits bitmaps with clipping', () => {
    const dst = Buffer.alloc(4 * 4 * 4)
    const src = Buffer.alloc(2 * 2 * 4, 0xff)
    blitBitmap(dst, 4, 4, src, 2, 2, 3, 3)
    const filled = [...Array(16).keys()].filter((i) => dst[i * 4] === 0xff)
    expect(filled).toEqual([15])
  })
})
