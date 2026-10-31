// The only module that touches window.jarvis; every renderer imports `api` from here.
import type { JarvisApi } from '@shared/ipc'

export const apiAvailable: boolean = typeof window.jarvis === 'object' && window.jarvis !== null

export const api: JarvisApi = window.jarvis

/** Error text without Electron's "Error invoking remote method '…': Error: " prefix. */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(\w*Error):\s*/, '')
  return cleaned.trim()
}
