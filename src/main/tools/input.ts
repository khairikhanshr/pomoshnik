// Synthetic keyboard / mouse input. macOS: CGEvent via JXA (needs Accessibility);
// Windows: keybd_event / SetCursorPos / mouse_event via PowerShell with a DPI-aware process.
import { app, BrowserWindow, clipboard, ClipboardItem, screen } from 'electron'
import type { Point } from './coords'
import { sleep } from './errors'
import { toMacKey, toWinKeys, type KeyCombo } from './keys'
import { runOsa } from './mac/osa'
import { JXA_KEYS, JXA_MOUSE } from './mac/scripts'
import type { ToolHost } from './types'
import { runPowerShell } from './win/ps'
import { PS_KEYS, PS_MOUSE } from './win/scripts'

export type MouseAction = 'move' | 'click' | 'double_click' | 'right_click' | 'scroll'

export interface InputDriver {
  pressCombos(combos: KeyCombo[], signal?: AbortSignal): Promise<void>
  /** `point` is a global DIP point (null = current cursor position). Resolves with the final cursor position. */
  mouse(action: MouseAction, point: Point | null, scrollDy: number, signal?: AbortSignal): Promise<Point | null>
}

/** Validates and converts every combo before anything is pressed. */
export function platformKeys(combos: KeyCombo[], platform: NodeJS.Platform): unknown[] {
  return platform === 'darwin' ? combos.map(toMacKey) : combos.map(toWinKeys)
}

export function createInputDriver(platform: NodeJS.Platform): InputDriver {
  if (platform === 'darwin') {
    return {
      async pressCombos(combos, signal) {
        await runOsa(JXA_KEYS, [JSON.stringify({ combos: platformKeys(combos, platform) })], 'Pressing keys', { signal })
      },
      async mouse(action, point, scrollDy, signal) {
        const payload = { action, x: point?.x, y: point?.y, dy: scrollDy }
        const out = await runOsa(JXA_MOUSE, [JSON.stringify(payload)], 'Mouse action', { signal })
        try {
          return JSON.parse(out) as Point
        } catch {
          return null
        }
      }
    }
  }
  return {
    async pressCombos(combos, signal) {
      await runPowerShell(PS_KEYS, 'Pressing keys', { args: { combos: platformKeys(combos, platform) }, signal })
    },
    async mouse(action, point, scrollDy, signal) {
      // The PowerShell process is per-monitor DPI aware, so it needs physical pixels.
      const physical = point ? screen.dipToScreenPoint({ x: Math.round(point.x), y: Math.round(point.y) }) : null
      const result = await runPowerShell<Point>(PS_MOUSE, 'Mouse action', {
        args: { action, x: physical?.x, y: physical?.y, dy: scrollDy },
        signal
      })
      return result ?? null
    }
  }
}

function contains(win: BrowserWindow, p: Point): boolean {
  const b = win.getBounds()
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
}

/** Keystrokes must not land in Jarvis' own window: hand the focus back to the previous app. */
export async function yieldKeyboardFocus(platform: NodeJS.Platform, signal?: AbortSignal): Promise<boolean> {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return false
  if (platform === 'darwin') app.hide()
  else focused.minimize()
  await sleep(350, signal)
  return true
}

/** Hides a Jarvis window lying under the point a click is aimed at. */
export async function clearPoint(host: ToolHost, point: Point, signal?: AbortSignal): Promise<boolean> {
  const main = host.windows.getMainWindow()
  let moved = false
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !win.isVisible() || !contains(win, point)) continue
    if (main && win.id === main.id) host.windows.hideMain()
    else host.windows.hideOverlay()
    moved = true
  }
  if (moved) await sleep(250, signal)
  return moved
}

/**
 * Materialized copy of the clipboard: items returned by clipboard.read() may resolve their data
 * lazily from the live clipboard, which is about to be overwritten. Null when unreadable.
 */
export async function snapshotClipboard(): Promise<ClipboardItem[] | null> {
  try {
    const copies: ClipboardItem[] = []
    for (const item of await clipboard.read()) {
      const data: Record<string, Blob | Electron.ClipboardBookmark> = {}
      for (const type of item.types) {
        try {
          data[type] = await item.getType(type)
        } catch {
          // format not readable: skip it
        }
      }
      if (Object.keys(data).length > 0) copies.push(new ClipboardItem(data))
    }
    return copies
  } catch {
    return null
  }
}

export async function restoreClipboard(items: ClipboardItem[] | null): Promise<void> {
  if (items === null) return
  if (items.length === 0) {
    clipboard.clear()
    return
  }
  try {
    await clipboard.write(items)
  } catch {
    clipboard.clear()
  }
}
