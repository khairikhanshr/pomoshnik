import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mimeTypeFor, parseMediaUrl, resolveAppPath } from '../../src/main/app/protocol-path'

const root = resolve('/opt/jarvis/out/renderer')

describe('resolveAppPath', () => {
  it('maps app://jarvis paths into the renderer directory', () => {
    expect(resolveAppPath(root, 'app://jarvis/index.html')).toEqual({ ok: true, file: join(root, 'index.html') })
    expect(resolveAppPath(root, 'app://jarvis/')).toEqual({ ok: true, file: join(root, 'index.html') })
    expect(resolveAppPath(root, 'app://jarvis')).toEqual({ ok: true, file: join(root, 'index.html') })
    expect(resolveAppPath(root, 'app://jarvis/overlay.html?window=overlay#x')).toEqual({
      ok: true,
      file: join(root, 'overlay.html')
    })
    expect(resolveAppPath(root, 'app://jarvis/assets/index-abc.js')).toEqual({
      ok: true,
      file: join(root, 'assets', 'index-abc.js')
    })
    expect(resolveAppPath(root, 'app://jarvis/models/%D0%BC%D0%BE%D0%B4%D0%B5%D0%BB%D1%8C.onnx')).toEqual({
      ok: true,
      file: join(root, 'models', 'модель.onnx')
    })
  })

  it('makes path traversal impossible', () => {
    const attacks = [
      'app://jarvis/../secrets.json',
      'app://jarvis/%2e%2e/%2e%2e/etc/passwd',
      'app://jarvis/assets/%2E%2E%2F%2E%2E%2Fsecret',
      'app://jarvis/..%2f..%2fsecret',
      'app://jarvis/assets/..%5C..%5Csecret',
      'app://jarvis/%5C%5Cserver%5Cshare',
      'app://jarvis/C:%5CWindows%5Cwin.ini',
      'app://jarvis/C:/Windows/win.ini',
      'app://jarvis/a%00b.html',
      'app://jarvis/%E0%A4%A'
    ]
    for (const url of attacks) {
      const result = resolveAppPath(root, url)
      if (result.ok) expect(result.file.startsWith(root + (root.endsWith('/') ? '' : '/'))).toBe(true)
      else expect([400, 404]).toContain(result.status)
    }
    expect(resolveAppPath(root, 'app://jarvis/a%00b.html')).toEqual({ ok: false, status: 400 })
    expect(resolveAppPath(root, 'app://jarvis/..%2fsecret')).toEqual({ ok: false, status: 400 })
  })

  it('rejects foreign hosts, schemes and garbage', () => {
    expect(resolveAppPath(root, 'app://evil/index.html')).toEqual({ ok: false, status: 404 })
    expect(resolveAppPath(root, 'file:///etc/passwd')).toEqual({ ok: false, status: 404 })
    expect(resolveAppPath(root, 'not a url')).toEqual({ ok: false, status: 400 })
  })
})

describe('mimeTypeFor', () => {
  it('returns the types the renderer needs', () => {
    expect(mimeTypeFor('a/ort-wasm-simd-threaded.wasm')).toBe('application/wasm')
    expect(mimeTypeFor('a/ort.bundle.min.mjs')).toBe('text/javascript; charset=utf-8')
    expect(mimeTypeFor('a/index.js')).toBe('text/javascript; charset=utf-8')
    expect(mimeTypeFor('a/silero_vad.onnx')).toBe('application/octet-stream')
    expect(mimeTypeFor('a/config.json')).toBe('application/json; charset=utf-8')
    expect(mimeTypeFor('index.HTML')).toBe('text/html; charset=utf-8')
    expect(mimeTypeFor('a/style.css')).toBe('text/css; charset=utf-8')
    expect(mimeTypeFor('a/exo-2-cyrillic.woff2')).toBe('font/woff2')
    expect(mimeTypeFor('a/unknown.xyz')).toBe('application/octet-stream')
  })
})

describe('parseMediaUrl', () => {
  it('accepts only plain ids', () => {
    expect(parseMediaUrl('jarvis-media://image/s0123abc')).toBe('s0123abc')
    expect(parseMediaUrl('jarvis-media://image/s0123abc/')).toBe('s0123abc')
    // Dot segments are resolved by the URL parser; what remains is a plain id inside the media dir.
    expect(parseMediaUrl('jarvis-media://image/../secrets')).toBe('secrets')
    expect(parseMediaUrl('jarvis-media://image/%2e%2e%2fsecrets')).toBeNull()
    expect(parseMediaUrl('jarvis-media://image/a%2fb')).toBeNull()
    expect(parseMediaUrl('jarvis-media://image/ABC')).toBeNull()
    expect(parseMediaUrl('jarvis-media://video/abc')).toBeNull()
    expect(parseMediaUrl('app://image/abc')).toBeNull()
    expect(parseMediaUrl('jarvis-media://image/')).toBeNull()
  })
})
