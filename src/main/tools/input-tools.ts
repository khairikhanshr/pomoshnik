import { clipboard } from 'electron'
import { LIMITS } from '@shared/defaults'
import { clip, optNumber, reqEnum, reqString } from './args'
import { imageToScreen, virtualGeometry, type Point } from './coords'
import { ok, type ToolDef, type ToolEnv } from './define'
import { sleep, ToolError } from './errors'
import {
  clearPoint,
  platformKeys,
  restoreClipboard,
  snapshotClipboard,
  yieldKeyboardFocus,
  type InputDriver,
  type MouseAction
} from './input'
import { formatCombo, KEY_HELP, parseKeys } from './keys'
import { ensureAccessibility } from './mac/permissions'
import { chooseDisplay, currentDisplays, type ScreenshotService } from './screenshot'

const MOUSE_ACTIONS: readonly MouseAction[] = ['move', 'click', 'double_click', 'right_click', 'scroll']
const PASTE_SETTLE_MS = 400

const MOUSE_TITLES: Record<MouseAction, string> = {
  move: 'Двигаю курсор',
  click: 'Кликаю мышью',
  double_click: 'Делаю двойной клик',
  right_click: 'Кликаю правой кнопкой',
  scroll: 'Прокручиваю'
}

const MOUSE_SUMMARIES: Record<MouseAction, string> = {
  move: 'Курсор перемещён',
  click: 'Клик выполнен',
  double_click: 'Двойной клик выполнен',
  right_click: 'Правый клик выполнен',
  scroll: 'Прокручено'
}

function keysArg(value: unknown): string | string[] {
  if (typeof value === 'string' && value.trim()) return value
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) return value as string[]
  throw new ToolError(`Missing required argument "keys", e.g. "cmd+c" or "ctrl+shift+esc". ${KEY_HELP}`)
}

export function inputTools(env: ToolEnv, driver: InputDriver, screenshots: ScreenshotService): ToolDef[] {
  const { platform, host } = env
  const mod = platform === 'darwin' ? 'cmd' : 'ctrl'

  const typeText: ToolDef = {
    spec: {
      name: 'type_text',
      description:
        'Type text into the focused app (pasted through the clipboard, so any language works; the clipboard is restored). ' +
        'Focus the target app first (focus_application or a mouse click) if needed.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Exact text to type.' } },
        required: ['text'],
        additionalProperties: false
      }
    },
    title: (args) => `Печатаю «${clip(String(args.text ?? ''), 30)}»`,
    run: async (args, ctx) => {
      const text = reqString(args, 'text', { raw: true, max: 20_000 })
      ensureAccessibility(platform)
      await yieldKeyboardFocus(platform, ctx.signal)
      const saved = await snapshotClipboard()
      try {
        await clipboard.writeText(text)
        await sleep(60, ctx.signal)
        await driver.pressCombos([{ modifiers: [mod], key: 'v' }], ctx.signal)
        await sleep(PASTE_SETTLE_MS)
      } finally {
        // Only restore if nobody copied something else meanwhile.
        const current = await clipboard.readText().catch(() => '')
        if (current === text) await restoreClipboard(saved)
      }
      return ok(`Typed ${text.length} characters into the focused app.`, `Напечатано: ${clip(text, 40)}`)
    }
  }

  const pressKeys: ToolDef = {
    spec: {
      name: 'press_keys',
      description:
        'Press keys or shortcuts in the focused app, e.g. "enter", "cmd+shift+4", "ctrl+c", "alt+tab", "win+d", ' +
        '"ctrl+c, ctrl+v" (sequence), "down*3" (repeat). "mod" = Cmd on macOS / Ctrl on Windows. ' +
        'Letter keys are physical keys; use type_text to enter text.',
      parameters: {
        type: 'object',
        properties: { keys: { type: 'string', description: 'Key combo(s), separated by spaces or commas.' } },
        required: ['keys'],
        additionalProperties: false
      }
    },
    title: (args) => `Нажимаю ${clip(Array.isArray(args.keys) ? args.keys.join(' ') : String(args.keys ?? ''), 30)}`,
    run: async (args, ctx) => {
      const combos = parseKeys(keysArg(args.keys), platform)
      platformKeys(combos, platform)
      ensureAccessibility(platform)
      await yieldKeyboardFocus(platform, ctx.signal)
      await driver.pressCombos(combos, ctx.signal)
      const shown = combos.map((c) => formatCombo(c, platform)).join(', ')
      return ok(`Pressed ${shown}.`, `Нажато: ${clip(shown, 50)}`)
    }
  }

  const mouse: ToolDef = {
    spec: {
      name: 'mouse',
      description:
        'Move, click or scroll the mouse. x/y are pixel coordinates in the latest take_screenshot image of this chat ' +
        '(they are mapped to the real screen). Omit x/y to act at the current cursor position. ' +
        'scroll_dy: lines to scroll, positive = down, negative = up.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...MOUSE_ACTIONS] },
          x: { type: 'number', description: 'Screenshot pixel x.' },
          y: { type: 'number', description: 'Screenshot pixel y.' },
          scroll_dy: { type: 'number', description: 'For scroll: lines, positive = down.' }
        },
        required: ['action'],
        additionalProperties: false
      }
    },
    title: (args) => MOUSE_TITLES[(String(args.action ?? '') as MouseAction)] ?? 'Управляю мышью',
    run: async (args, ctx) => {
      const action = reqEnum(args, 'action', MOUSE_ACTIONS)
      const x = optNumber(args, 'x')
      const y = optNumber(args, 'y')
      if ((x === undefined) !== (y === undefined)) throw new ToolError('Give both x and y, or neither')
      if (action === 'move' && x === undefined) throw new ToolError('move needs x and y')
      const dy = action === 'scroll' ? optNumber(args, 'scroll_dy', { min: -100, max: 100, integer: true }) ?? 3 : 0
      if (action === 'scroll' && dy === 0) throw new ToolError('scroll_dy must not be 0')

      let point: Point | null = null
      let note = ''
      if (x !== undefined && y !== undefined) {
        let geometry = screenshots.geometryFor(ctx.chatId)
        if (!geometry) {
          geometry = virtualGeometry(chooseDisplay('primary', currentDisplays()), LIMITS.screenshotMaxSide)
          note = ` No screenshot was taken in this chat, so the coordinates were read as pixels of a full primary-display screenshot (${geometry.imageWidth}×${geometry.imageHeight}); take a screenshot first for precise clicks.`
        }
        point = imageToScreen(geometry, x, y)
      }
      ensureAccessibility(platform)
      if (point) await clearPoint(host, point, ctx.signal)
      await driver.mouse(action, point, dy, ctx.signal)
      const where = point
        ? ` at screenshot pixel (${Math.round(x ?? 0)}, ${Math.round(y ?? 0)}) = screen point (${Math.round(point.x)}, ${Math.round(point.y)})`
        : ' at the current cursor position'
      const what = action === 'scroll' ? `Scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)} lines` : `Done: ${action.replace('_', ' ')}`
      return ok(`${what}${where}.${note}`, MOUSE_SUMMARIES[action])
    }
  }

  return [typeText, pressKeys, mouse]
}
