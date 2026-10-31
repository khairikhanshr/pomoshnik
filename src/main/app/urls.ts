// Pure URL helpers: our own page origins and which links may be opened in the system browser.
import { APP_ORIGIN } from './protocol-path'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 8192) return false
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    // Non-special schemes report an opaque "null" origin in Node; rebuild it from the parts.
    if (origin !== 'null') return origin
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** Origins our renderer pages are served from: app://jarvis (production) and the Vite dev server. */
export function appOrigins(rendererUrl?: string): string[] {
  const origins = [APP_ORIGIN]
  const dev = rendererUrl ? originOf(rendererUrl) : null
  if (dev) origins.push(dev)
  return origins
}

export function isAppUrl(url: string, origins: readonly string[]): boolean {
  const origin = originOf(url)
  return !!origin && origins.includes(origin)
}

/** Base URL of the renderer pages (no trailing slash). */
export function rendererBaseUrl(rendererUrl?: string): string {
  return rendererUrl ? rendererUrl.replace(/\/+$/, '') : APP_ORIGIN
}
