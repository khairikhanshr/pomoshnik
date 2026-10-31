// Main stores PNG/JPEG as-is and converts other formats only best-effort, so the renderer re-encodes the rest.
const NATIVE = new Set(['image/png', 'image/jpeg'])

async function decode(file: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  try {
    return await createImageBitmap(file)
  } catch {
    // createImageBitmap cannot decode SVG; an <img> can.
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return img
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** Returns PNG/JPEG data ready for media.importImage; other formats (WebP, GIF, BMP, SVG…) become PNG. */
export async function toImportable(file: Blob): Promise<{ data: ArrayBuffer; mime: string }> {
  if (NATIVE.has(file.type)) return { data: await file.arrayBuffer(), mime: file.type }
  const image = await decode(file)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, image.width)
  canvas.height = Math.max(1, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(image, 0, 0)
  if ('close' in image && typeof image.close === 'function') image.close()
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!png) throw new Error('png encoding failed')
  return { data: await png.arrayBuffer(), mime: 'image/png' }
}
