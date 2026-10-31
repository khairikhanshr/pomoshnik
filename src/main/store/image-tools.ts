// nativeImage-based image processing for the MediaStore (downscaling) and image imports (format conversion).
import { nativeImage, type NativeImage } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../log'
import { newId } from '../util/fs'
import { detectImageMime, extensionForMime, isStoredMime, readImageSize, type StoredImageMime } from './image-info'
import type { Downscaled } from './media'

const log = createLogger('images')

/** Longest side for images converted through the OS thumbnailer (WebP, GIF, HEIC, TIFF, BMP…). */
const THUMBNAIL_SIDE = 2560

export function downscaleImage(data: Buffer, mime: StoredImageMime, maxSide: number): Downscaled | null {
  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { data, mime, width, height }
  const scale = maxSide / longest
  const resized = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best'
  })
  const size = resized.getSize()
  return { data: mime === 'image/png' ? resized.toPNG() : resized.toJPEG(90), mime, ...size }
}

export interface ImportedImage {
  data: Buffer
  mime: StoredImageMime
  width?: number
  height?: number
}

/**
 * Prepares user-provided image bytes for the MediaStore: PNG and JPEG are kept as they are, other formats
 * are converted to PNG with nativeImage or, failing that, the OS thumbnail generator (macOS / Windows).
 */
export async function prepareImportedImage(data: Buffer, declaredMime: string, tmpDir: string): Promise<ImportedImage> {
  const mime = detectImageMime(data) ?? declaredMime
  if (isStoredMime(mime)) {
    const size = readImageSize(data, mime)
    if (!size) throw new Error('Не удалось прочитать изображение: файл повреждён.')
    return { data, mime, ...size }
  }
  let image: NativeImage = nativeImage.createFromBuffer(data)
  if (image.isEmpty() && (process.platform === 'darwin' || process.platform === 'win32')) {
    image = await thumbnail(data, mime, tmpDir)
  }
  if (image.isEmpty()) throw new Error('Формат изображения не поддерживается. Используйте PNG или JPEG.')
  const png = image.toPNG()
  return { data: png, mime: 'image/png', ...image.getSize() }
}

async function thumbnail(data: Buffer, mime: string, tmpDir: string): Promise<NativeImage> {
  const file = join(tmpDir, `import-${newId()}.${extensionForMime(mime)}`)
  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(file, data)
    return await nativeImage.createThumbnailFromPath(file, { width: THUMBNAIL_SIDE, height: THUMBNAIL_SIDE })
  } catch (err) {
    log.warn('thumbnail conversion failed', err)
    return nativeImage.createEmpty()
  } finally {
    rmSync(file, { force: true })
  }
}
