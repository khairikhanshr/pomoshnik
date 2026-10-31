import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectImageMime, readImageSize } from '../../src/main/store/image-info'
import { createMediaStore } from '../../src/main/store/media'

/** Minimal PNG: signature + IHDR (CRC is not checked by the header parser). */
export function fakePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b[24] = 8
  b[25] = 6
  return b
}

/** Minimal JPEG: SOI + APP0 + SOF0. */
export function fakeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(9), Buffer.from([0xff, 0xd9])])
}

let dir: string

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'jarvis-media-')), 'media')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

describe('image-info', () => {
  it('detects formats by magic bytes', () => {
    expect(detectImageMime(fakePng(1, 1))).toBe('image/png')
    expect(detectImageMime(fakeJpeg(1, 1))).toBe('image/jpeg')
    expect(detectImageMime(Buffer.from('GIF89a......'))).toBe('image/gif')
    expect(detectImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(detectImageMime(Buffer.from('\0\0\0\x18ftypheic\0\0'))).toBe('image/heic')
    expect(detectImageMime(Buffer.from('hello world!'))).toBeNull()
    expect(detectImageMime(Buffer.alloc(0))).toBeNull()
  })

  it('reads PNG and JPEG sizes from headers', () => {
    expect(readImageSize(fakePng(2560, 1600), 'image/png')).toEqual({ width: 2560, height: 1600 })
    expect(readImageSize(fakeJpeg(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 })
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBeNull()
    expect(readImageSize(fakePng(0, 10), 'image/png')).toBeNull()
    expect(readImageSize(fakePng(1, 1).subarray(0, 20), 'image/png')).toBeNull()
  })
})

describe('createMediaStore', () => {
  it('saves images with ids, urls, sizes and kinds', () => {
    const media = createMediaStore(dir)
    const shot = media.save(fakePng(800, 600), { kind: 'screenshot', mime: 'image/png' })
    expect(shot.id).toMatch(/^s[a-z0-9]+$/)
    expect(shot).toMatchObject({ url: `jarvis-media://image/${shot.id}`, kind: 'screenshot', width: 800, height: 600 })
    expect(existsSync(join(dir, `${shot.id}.png`))).toBe(true)

    // The bytes win over a wrong declared mime.
    const photo = media.save(fakeJpeg(640, 480), { kind: 'upload', mime: 'image/png' })
    expect(photo.id).toMatch(/^u/)
    expect(media.path(photo.id)).toBe(join(dir, `${photo.id}.jpg`))

    const reopened = createMediaStore(dir)
    expect(reopened.ref(shot.id)).toEqual(shot)
    expect(reopened.ref(photo.id)).toMatchObject({ kind: 'upload', width: 640, height: 480 })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('rejects invalid data and ids', () => {
    const media = createMediaStore(dir)
    expect(() => media.save(Buffer.from('not an image'), { kind: 'upload', mime: 'image/png' })).toThrow()
    expect(() => media.save(Buffer.alloc(0), { kind: 'upload', mime: 'image/png' })).toThrow()
    expect(media.ref('../secrets')).toBeNull()
    expect(media.path('..%2Fsecrets')).toBeNull()
    expect(media.path('UPPER')).toBeNull()
    expect(media.ref('missing123')).toBeNull()
  })

  it('builds data URLs and downscales only when needed', async () => {
    const downscale = vi.fn((_data: Buffer, mime: 'image/png' | 'image/jpeg', maxSide: number) => ({
      data: Buffer.from('small'),
      mime,
      width: maxSide,
      height: maxSide / 2
    }))
    const media = createMediaStore(dir, { downscale })
    const png = fakePng(4000, 2000)
    const ref = media.save(png, { kind: 'screenshot', mime: 'image/png' })

    expect(await media.dataUrl(ref.id)).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(await media.dataUrl(ref.id, { maxSide: 4000 })).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(downscale).not.toHaveBeenCalled()
    expect(await media.dataUrl(ref.id, { maxSide: 1000 })).toBe(
      `data:image/png;base64,${Buffer.from('small').toString('base64')}`
    )
    expect(downscale).toHaveBeenCalledOnce()
    expect(await media.dataUrl('nope')).toBeNull()
  })

  it('removes images and tolerates files deleted behind its back', () => {
    const media = createMediaStore(dir)
    const ref = media.save(fakePng(10, 10), { kind: 'upload', mime: 'image/png' })
    media.remove(ref.id)
    expect(media.ref(ref.id)).toBeNull()
    expect(media.path(ref.id)).toBeNull()
    expect(() => media.remove('../../etc')).not.toThrow()

    const other = media.save(fakePng(10, 10), { kind: 'upload', mime: 'image/png' })
    rmSync(join(dir, `${other.id}.png`))
    expect(media.ref(other.id)).toBeNull()
    writeFileSync(join(dir, 'abc.png'), 'garbage')
    expect(media.ref('abc')).toMatchObject({ id: 'abc', kind: 'upload' })
  })
})
