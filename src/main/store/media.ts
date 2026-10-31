// MediaStore: screenshots and uploaded images under userData/media as <id>.png / <id>.jpg.
// The kind is encoded in the id prefix ("s" screenshot, "u" upload), sizes come from the file header.
// Electron-free: downscaling for data URLs is injected (see image-tools.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageRef } from '@shared/types'
import { createLogger } from '../log'
import type { MediaStore } from '../services'
import { newId } from '../util/fs'
import { detectImageMime, isStoredMime, readImageSize, type StoredImageMime } from './image-info'

const log = createLogger('media')

export const MEDIA_SCHEME = 'jarvis-media'
export const MEDIA_ID_RE = /^[a-z0-9]{1,64}$/

export function mediaUrl(id: string): string {
  return `${MEDIA_SCHEME}://image/${id}`
}

export interface Downscaled {
  data: Buffer
  mime: StoredImageMime
  width: number
  height: number
}

export interface MediaStoreOptions {
  /** Re-encodes an image so its longest side is <= maxSide; null when it cannot be decoded. */
  downscale?: (data: Buffer, mime: StoredImageMime, maxSide: number) => Downscaled | null
}

const EXTENSIONS: Array<[string, StoredImageMime]> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg']
]

export function createMediaStore(dir: string, opts: MediaStoreOptions = {}): MediaStore {
  const refs = new Map<string, ImageRef>()

  function locate(id: string): { file: string; mime: StoredImageMime } | null {
    if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) return null
    for (const [ext, mime] of EXTENSIONS) {
      const file = join(dir, `${id}.${ext}`)
      if (existsSync(file)) return { file, mime }
    }
    return null
  }

  return {
    save(data, { kind, width, height }) {
      if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('Пустое изображение.')
      // The bytes decide the format; the declared mime may be wrong.
      const mime = detectImageMime(data)
      if (!isStoredMime(mime)) throw new Error('Неподдерживаемый формат изображения: нужен PNG или JPEG.')
      const id = `${kind === 'screenshot' ? 's' : 'u'}${newId()}`
      const file = join(dir, `${id}.${mime === 'image/png' ? 'png' : 'jpg'}`)
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, data)
        renameSync(tmp, file)
      } catch (err) {
        rmSync(tmp, { force: true })
        throw err
      }
      const size = width && height ? { width, height } : readImageSize(data, mime)
      const ref: ImageRef = { id, url: mediaUrl(id), kind: kind === 'screenshot' ? 'screenshot' : 'upload' }
      if (size) {
        ref.width = Math.round(size.width)
        ref.height = Math.round(size.height)
      }
      refs.set(id, ref)
      return { ...ref }
    },

    ref(id) {
      const cached = refs.get(id)
      if (cached && locate(id)) return { ...cached }
      const found = locate(id)
      if (!found) {
        refs.delete(id)
        return null
      }
      const ref: ImageRef = { id, url: mediaUrl(id), kind: id.startsWith('s') ? 'screenshot' : 'upload' }
      try {
        const size = readImageSize(readFileSync(found.file), found.mime)
        if (size) Object.assign(ref, size)
      } catch (err) {
        log.warn(`cannot read image ${id}`, err)
      }
      refs.set(id, ref)
      return { ...ref }
    },

    path: (id) => locate(id)?.file ?? null,

    async dataUrl(id, options) {
      const found = locate(id)
      if (!found) return null
      let data: Buffer
      try {
        data = await readFile(found.file)
      } catch (err) {
        log.warn(`cannot read image ${id}`, err)
        return null
      }
      let mime = found.mime
      const maxSide = options?.maxSide
      if (maxSide && maxSide > 0 && opts.downscale) {
        const size = readImageSize(data, mime)
        if (!size || Math.max(size.width, size.height) > maxSide) {
          const scaled = opts.downscale(data, mime, maxSide)
          if (scaled) {
            data = scaled.data
            mime = scaled.mime
          }
        }
      }
      return `data:${mime};base64,${data.toString('base64')}`
    },

    remove(id) {
      refs.delete(id)
      if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) return
      for (const [ext] of EXTENSIONS) {
        try {
          rmSync(join(dir, `${id}.${ext}`), { force: true })
        } catch (err) {
          log.warn(`cannot delete image ${id}`, err)
        }
      }
    }
  }
}
