// app:// (renderer files, cross-origin isolated) and jarvis-media:// (MediaStore images) protocol handlers.
import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createLogger } from '../log'
import type { MediaStore } from '../services'
import {
  APP_RESPONSE_HEADERS,
  APP_SCHEME,
  MEDIA_RESPONSE_HEADERS,
  MEDIA_SCHEME,
  mimeTypeFor,
  parseMediaUrl,
  resolveAppPath
} from './protocol-path'

const log = createLogger('protocol')

/** Must run before app 'ready'. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true }
    },
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

function errorResponse(status: number, headers: Readonly<Record<string, string>>): Response {
  const text = status === 404 ? 'Not found' : status === 405 ? 'Method not allowed' : 'Bad request'
  return new Response(text, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } })
}

async function serveFile(
  request: Request,
  file: string,
  headers: Readonly<Record<string, string>>
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, headers)
  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile()) return errorResponse(404, headers)
    size = info.size
  } catch {
    return errorResponse(404, headers)
  }
  const responseHeaders = { ...headers, 'Content-Type': mimeTypeFor(file), 'Content-Length': String(size) }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: responseHeaders })
  const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status: 200, headers: responseHeaders })
}

export interface ProtocolOptions {
  /** Directory with the built renderer (out/renderer). */
  rendererDir: string
  media: Pick<MediaStore, 'path'>
}

/** Call after 'ready'. Handlers are registered on the default session. */
export function registerProtocolHandlers(opts: ProtocolOptions): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const resolved = resolveAppPath(opts.rendererDir, request.url)
    if (!resolved.ok) {
      log.warn(`rejected ${request.url} (${resolved.status})`)
      return errorResponse(resolved.status, APP_RESPONSE_HEADERS)
    }
    try {
      return await serveFile(request, resolved.file, APP_RESPONSE_HEADERS)
    } catch (err) {
      log.error(`failed to serve ${request.url}`, err)
      return errorResponse(404, APP_RESPONSE_HEADERS)
    }
  })

  protocol.handle(MEDIA_SCHEME, async (request) => {
    const id = parseMediaUrl(request.url)
    const file = id ? opts.media.path(id) : null
    if (!file) return errorResponse(404, MEDIA_RESPONSE_HEADERS)
    try {
      return await serveFile(request, file, MEDIA_RESPONSE_HEADERS)
    } catch (err) {
      log.error(`failed to serve ${request.url}`, err)
      return errorResponse(404, MEDIA_RESPONSE_HEADERS)
    }
  })
}
