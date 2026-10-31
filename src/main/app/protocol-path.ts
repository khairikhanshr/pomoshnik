// Pure URL → file resolution and MIME types for the app:// and jarvis-media:// protocols.
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { MEDIA_ID_RE, MEDIA_SCHEME } from '../store/media'

export const APP_SCHEME = 'app'
export const APP_HOST = 'jarvis'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export { MEDIA_SCHEME }

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.ort': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4'
}

export function mimeTypeFor(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export type AppPathResult = { ok: true; file: string } | { ok: false; status: 400 | 404 }

/** Maps app://jarvis/<path> to a file inside `root`; anything that could escape `root` is rejected. */
export function resolveAppPath(root: string, requestUrl: string): AppPathResult {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return { ok: false, status: 400 }
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) return { ok: false, status: 404 }
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return { ok: false, status: 400 }
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return { ok: false, status: 400 }
  const segments = pathname.split('/').filter(Boolean)
  if (segments.some((s) => s === '.' || s === '..' || /^[a-zA-Z]:/.test(s))) return { ok: false, status: 400 }
  if (!segments.length) segments.push('index.html')
  const base = resolve(root)
  const file = resolve(base, ...segments)
  const rel = relative(base, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, status: 400 }
  return { ok: true, file }
}

/** Media id from jarvis-media://image/<id>, or null. */
export function parseMediaUrl(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl)
    if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== 'image') return null
    const id = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '')
    return MEDIA_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

export const APP_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache'
}

export const MEDIA_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  // Ids are never reused, so the content of a URL never changes.
  'Cache-Control': 'private, max-age=31536000, immutable'
}
