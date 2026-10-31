// Pure image sniffing: format from magic bytes and pixel size from PNG / JPEG headers.

export type StoredImageMime = 'image/png' | 'image/jpeg'

export function detectImageMime(buf: Uint8Array): string | null {
  const b = buf
  const ascii = (start: number, len: number): string => String.fromCharCode(...b.subarray(start, start + len))
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (b.length >= 2 && ascii(0, 2) === 'BM') return 'image/bmp'
  if (b.length >= 4 && (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*')) return 'image/tiff'
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
  }
  return null
}

export function isStoredMime(mime: string | null | undefined): mime is StoredImageMime {
  return mime === 'image/png' || mime === 'image/jpeg'
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR') return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    // Standalone markers have no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // end of image / start of scan before any SOF
    const length = (b[i + 2] << 8) | b[i + 3]
    if (length < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 8 >= b.length) return null
      const height = (b[i + 5] << 8) | b[i + 6]
      const width = (b[i + 7] << 8) | b[i + 8]
      return width > 0 && height > 0 ? { width, height } : null
    }
    i += 2 + length
  }
  return null
}

/** Pixel size from the header (no decoding); null when the data is not a readable PNG / JPEG. */
export function readImageSize(buf: Uint8Array, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png') return pngSize(buf)
  if (mime === 'image/jpeg') return jpegSize(buf)
  return null
}

export function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/bmp':
      return 'bmp'
    case 'image/tiff':
      return 'tiff'
    case 'image/heic':
      return 'heic'
    case 'image/avif':
      return 'avif'
    default:
      return 'img'
  }
}
