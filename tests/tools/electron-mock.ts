// Minimal stand-in for the 'electron' module: use with
// vi.mock('electron', async () => (await import('./electron-mock')).electronMock())
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

export interface MockDisplay {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  label?: string
}

export const mockState = {
  displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, label: 'Built-in' }] as MockDisplay[],
  cursor: { x: 10, y: 10 },
  clipboardText: '',
  trusted: false,
  screenAccess: 'denied' as string,
  dialogResponse: 1
}

export function electronMock(): Record<string, unknown> {
  const displayFor = (p: { x: number; y: number }): MockDisplay =>
    mockState.displays.find(
      (d) => p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height
    ) ?? mockState.displays[0]
  return {
    app: {
      getPath: (name: string) => (name === 'home' ? homedir() : name === 'userData' ? join(tmpdir(), 'jarvis-test') : join(homedir(), name)),
      getVersion: () => '1.0.0-test',
      getLocale: () => 'ru-RU',
      hide: vi.fn(),
      focus: vi.fn()
    },
    shell: {
      openExternal: vi.fn(async () => {}),
      openPath: vi.fn(async () => '')
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: mockState.dialogResponse, checkboxChecked: false }))
    },
    clipboard: {
      readText: vi.fn(async () => mockState.clipboardText),
      writeText: vi.fn(async (text: string) => {
        mockState.clipboardText = text
      }),
      read: vi.fn(async () => []),
      write: vi.fn(async () => {}),
      has: vi.fn(async () => false),
      clear: vi.fn(() => {
        mockState.clipboardText = ''
      })
    },
    ClipboardItem: class {
      readonly types: string[]
      constructor(readonly data: Record<string, unknown>) {
        this.types = Object.keys(data)
      }
    },
    screen: {
      getAllDisplays: () => mockState.displays,
      getPrimaryDisplay: () => mockState.displays[0],
      getCursorScreenPoint: () => mockState.cursor,
      getDisplayNearestPoint: (p: { x: number; y: number }) => displayFor(p),
      dipToScreenPoint: (p: { x: number; y: number }) => {
        const d = displayFor(p)
        return { x: Math.round(p.x * d.scaleFactor), y: Math.round(p.y * d.scaleFactor) }
      }
    },
    desktopCapturer: { getSources: vi.fn(async () => []) },
    nativeImage: { createFromBitmap: vi.fn() },
    systemPreferences: {
      isTrustedAccessibilityClient: vi.fn(() => mockState.trusted),
      getMediaAccessStatus: vi.fn(() => mockState.screenAccess)
    },
    Notification: class {
      static isSupported(): boolean {
        return false
      }
      on(): void {}
      show(): void {}
    },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
  }
}
