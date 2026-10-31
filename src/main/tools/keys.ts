// Cross-platform key combo parsing: "cmd+shift+4", "ctrl+c, ctrl+v", "down*3", "mod+t".
// Pure: maps to macOS virtual key codes + CGEventFlags and Windows virtual-key codes.
import { ToolError } from './errors'

export type Modifier = 'cmd' | 'ctrl' | 'alt' | 'shift' | 'win' | 'fn'

export interface KeyCombo {
  /** In press order, without duplicates. */
  modifiers: Modifier[]
  /** Canonical key name; null when the combo consists of modifiers only (e.g. "win"). */
  key: string | null
}

export const MAX_COMBOS = 50

type ModifierAlias = Modifier | 'mod' | 'meta'

const MODIFIER_ALIASES: Record<string, ModifierAlias> = {
  cmd: 'cmd',
  command: 'cmd',
  '⌘': 'cmd',
  команд: 'cmd',
  команда: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  '⌃': 'ctrl',
  контрол: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  '⌥': 'alt',
  альт: 'alt',
  shift: 'shift',
  '⇧': 'shift',
  шифт: 'shift',
  win: 'win',
  windows: 'win',
  start: 'win',
  вин: 'win',
  fn: 'fn',
  function: 'fn',
  mod: 'mod',
  meta: 'meta',
  super: 'meta'
}

const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  ввод: 'enter',
  энтер: 'enter',
  esc: 'escape',
  эскейп: 'escape',
  escape: 'escape',
  spacebar: 'space',
  пробел: 'space',
  ' ': 'space',
  таб: 'tab',
  tab: 'tab',
  del: 'delete',
  forwarddelete: 'delete',
  удалить: 'delete',
  делит: 'delete',
  back: 'backspace',
  bksp: 'backspace',
  backspace: 'backspace',
  бэкспейс: 'backspace',
  ins: 'insert',
  pgup: 'pageup',
  page_up: 'pageup',
  pgdn: 'pagedown',
  pagedn: 'pagedown',
  page_down: 'pagedown',
  arrowup: 'up',
  uparrow: 'up',
  вверх: 'up',
  arrowdown: 'down',
  downarrow: 'down',
  вниз: 'down',
  arrowleft: 'left',
  leftarrow: 'left',
  влево: 'left',
  arrowright: 'right',
  rightarrow: 'right',
  вправо: 'right',
  '-': 'minus',
  dash: 'minus',
  hyphen: 'minus',
  '=': 'equal',
  equals: 'equal',
  '+': 'equal',
  plus: 'equal',
  '[': 'leftbracket',
  bracketleft: 'leftbracket',
  ']': 'rightbracket',
  bracketright: 'rightbracket',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'quote',
  apostrophe: 'quote',
  ',': 'comma',
  '.': 'period',
  dot: 'period',
  '/': 'slash',
  '`': 'grave',
  backtick: 'grave',
  tilde: 'grave',
  caps: 'capslock',
  prtsc: 'printscreen',
  prtscn: 'printscreen',
  print: 'printscreen',
  snapshot: 'printscreen',
  apps: 'menu',
  contextmenu: 'menu',
  volume_up: 'volumeup',
  volume_down: 'volumedown',
  volumemute: 'mute',
  play: 'playpause',
  pause: 'playpause',
  play_pause: 'playpause',
  next: 'nexttrack',
  previous: 'prevtrack',
  prev: 'prevtrack'
}

const NAMED_KEYS = new Set([
  'enter', 'tab', 'space', 'escape', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'minus', 'equal', 'leftbracket', 'rightbracket', 'backslash', 'semicolon',
  'quote', 'comma', 'period', 'slash', 'grave', 'capslock', 'printscreen', 'menu', 'volumeup', 'volumedown',
  'mute', 'playpause', 'nexttrack', 'prevtrack'
])

function resolveModifier(alias: ModifierAlias, platform: NodeJS.Platform): Modifier {
  const mac = platform === 'darwin'
  if (alias === 'mod') return mac ? 'cmd' : 'ctrl'
  if (alias === 'meta') return mac ? 'cmd' : 'win'
  // The model often says "cmd" on Windows meaning the shortcut key, and "win" on a Mac means ⌘.
  if (alias === 'cmd' && !mac) return 'ctrl'
  if (alias === 'win' && mac) return 'cmd'
  return alias
}

/** Russian ЙЦУКЕН letters -> the physical (US) key they sit on, so "ctrl+с" means Ctrl+C. */
const CYRILLIC_KEYS: Record<string, string> = {
  й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p', х: 'leftbracket',
  ъ: 'rightbracket', ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l', ж: 'semicolon',
  э: 'quote', я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm', б: 'comma', ю: 'period', ё: 'grave'
}

export function canonicalKey(name: string): string | null {
  const lower = name.toLowerCase()
  const alias = KEY_ALIASES[lower] ?? CYRILLIC_KEYS[lower] ?? lower
  if (/^[a-z0-9]$/.test(alias)) return alias
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(alias)) return alias
  return NAMED_KEYS.has(alias) ? alias : null
}

function splitParts(combo: string): string[] {
  // "ctrl++" / "cmd+=" style: a trailing empty part means the key itself is "+".
  if (combo === '+') return ['+']
  const parts = combo.split('+')
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    parts.splice(parts.length - 2, 2, '+')
  }
  if (parts.length > 1 || combo.length < 3 || !combo.includes('-')) return parts
  // Emacs-style "cmd-shift-4" when every part before the last is a modifier.
  const dashed = combo.split('-')
  const head = dashed.slice(0, -1)
  if (head.length > 0 && head.every((p) => p in MODIFIER_ALIASES) && dashed[dashed.length - 1] !== '') return dashed
  return parts
}

function parseCombo(raw: string, platform: NodeJS.Platform): KeyCombo {
  const parts = splitParts(raw)
  const modifiers: Modifier[] = []
  let key: string | null = null
  for (const part of parts) {
    const token = part.trim()
    if (!token) throw new ToolError(`Invalid key combo "${raw}"`)
    const alias = MODIFIER_ALIASES[token]
    if (alias) {
      const mod = resolveModifier(alias, platform)
      if (!modifiers.includes(mod)) modifiers.push(mod)
      continue
    }
    if (key !== null) throw new ToolError(`Invalid key combo "${raw}": more than one non-modifier key`)
    const canonical = canonicalKey(token)
    if (!canonical) throw new ToolError(`Unknown key "${token}" in "${raw}". ${KEY_HELP}`)
    key = canonical
  }
  if (!key && modifiers.length === 0) throw new ToolError(`Invalid key combo "${raw}"`)
  return { modifiers, key }
}

export const KEY_HELP =
  'Keys: a-z, 0-9, f1-f24, enter, tab, space, escape, backspace, delete, insert, home, end, pageup, pagedown, ' +
  'up, down, left, right, minus, equal (plus), [ ] \\ ; \' , . / `, capslock, printscreen, menu, volumeup, volumedown, ' +
  'mute, playpause, nexttrack, prevtrack. Modifiers: cmd, ctrl, alt/option, shift, win, fn, mod (cmd on macOS, ctrl on Windows).'

/** Splits on whitespace, and on , / ; unless they are the key itself ("cmd+,", a lone ","). */
function tokenize(text: string): string[] {
  const out: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word === ',' || word === ';') out.push(word)
    else for (const part of word.split(/(?<!\+)[,;]/)) if (part) out.push(part)
  }
  return out
}

/** Parses one or more combos separated by spaces / commas. "down*3" repeats a combo. */
export function parseKeys(input: string | readonly string[], platform: NodeJS.Platform): KeyCombo[] {
  const items = typeof input === 'string' ? [input] : [...input]
  const combos: KeyCombo[] = []
  for (const item of items) {
    const text = item.toLowerCase().replace(/\s*\+\s*/g, '+').trim()
    for (const token of tokenize(text)) {
      const repeat = /^(.+?)\*(\d{1,2})$/.exec(token)
      const combo = parseCombo(repeat ? repeat[1] : token, platform)
      const times = repeat ? Math.max(1, Number(repeat[2])) : 1
      for (let i = 0; i < times; i++) combos.push(combo)
      if (combos.length > MAX_COMBOS) throw new ToolError(`Too many key presses (max ${MAX_COMBOS})`)
    }
  }
  if (combos.length === 0) throw new ToolError(`No keys given. ${KEY_HELP}`)
  return combos
}

// --- macOS -------------------------------------------------------------------------------------

const MAC_KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, equal: 24, '9': 25, '7': 26, minus: 27, '8': 28, '0': 29,
  rightbracket: 30, o: 31, u: 32, leftbracket: 33, i: 34, p: 35, enter: 36, l: 37, j: 38, quote: 39, k: 40,
  semicolon: 41, backslash: 42, comma: 43, slash: 44, n: 45, m: 46, period: 47, tab: 48, space: 49, grave: 50,
  backspace: 51, escape: 53, capslock: 57, f17: 64, volumeup: 72, volumedown: 73, mute: 74, f18: 79, f19: 80,
  f20: 90, f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101, f11: 103, f13: 105, f16: 106, f14: 107, f10: 109,
  f12: 111, f15: 113, insert: 114, home: 115, pageup: 116, delete: 117, f4: 118, end: 119, f2: 120, pagedown: 121,
  f1: 122, left: 123, right: 124, down: 125, up: 126
}

const MAC_MODIFIER_KEYS: Record<Modifier, { code: number; flag: number }> = {
  cmd: { code: 55, flag: 0x100000 },
  shift: { code: 56, flag: 0x20000 },
  alt: { code: 58, flag: 0x80000 },
  ctrl: { code: 59, flag: 0x40000 },
  fn: { code: 63, flag: 0x800000 },
  win: { code: 55, flag: 0x100000 }
}

const FLAG_NUMERIC_PAD = 0x200000
const FLAG_SECONDARY_FN = 0x800000
const MAC_ARROWS = new Set(['left', 'right', 'up', 'down'])
const MAC_FN_KEYS = new Set(['home', 'end', 'pageup', 'pagedown', 'delete', 'insert'])

export interface MacKeyEvent {
  code: number
  flags: number
}

export function toMacKey(combo: KeyCombo): MacKeyEvent {
  let flags = 0
  for (const mod of combo.modifiers) flags |= MAC_MODIFIER_KEYS[mod].flag
  if (combo.key === null) {
    const last = combo.modifiers[combo.modifiers.length - 1]
    return { code: MAC_MODIFIER_KEYS[last].code, flags }
  }
  const code = MAC_KEY_CODES[combo.key]
  if (code === undefined) {
    const hint = combo.key === 'printscreen' ? ' Use cmd+shift+3 (full screen) or cmd+shift+4 (area) instead.' : ''
    throw new ToolError(`Key "${combo.key}" does not exist on macOS.${hint}`)
  }
  // Real keyboards report arrows and navigation / F-keys with these flags; some apps rely on them.
  if (MAC_ARROWS.has(combo.key)) flags |= FLAG_NUMERIC_PAD | FLAG_SECONDARY_FN
  else if (MAC_FN_KEYS.has(combo.key) || /^f\d+$/.test(combo.key)) flags |= FLAG_SECONDARY_FN
  return { code, flags }
}

// --- Windows -----------------------------------------------------------------------------------

const WIN_KEYS: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, capslock: 0x14, escape: 0x1b, space: 0x20, pageup: 0x21,
  pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c,
  insert: 0x2d, delete: 0x2e, menu: 0x5d, mute: 0xad, volumedown: 0xae, volumeup: 0xaf, nexttrack: 0xb0,
  prevtrack: 0xb1, playpause: 0xb3, semicolon: 0xba, equal: 0xbb, comma: 0xbc, minus: 0xbd, period: 0xbe,
  slash: 0xbf, grave: 0xc0, leftbracket: 0xdb, backslash: 0xdc, rightbracket: 0xdd, quote: 0xde
}

const WIN_EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb3])

const WIN_MODIFIERS: Partial<Record<Modifier, number>> = { ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5b }

export function winVirtualKey(key: string): number | undefined {
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0)
  const fn = /^f(\d+)$/.exec(key)
  if (fn) return 0x6f + Number(fn[1])
  return WIN_KEYS[key]
}

export interface WinKeyCombo {
  /** Modifiers first, main key last. */
  vks: number[]
  /** 1 = KEYEVENTF_EXTENDEDKEY. */
  ext: number[]
}

export function toWinKeys(combo: KeyCombo): WinKeyCombo {
  const vks: number[] = []
  for (const mod of combo.modifiers) {
    const vk = WIN_MODIFIERS[mod]
    if (vk === undefined) throw new ToolError(`Modifier "${mod}" cannot be pressed programmatically on Windows`)
    vks.push(vk)
  }
  if (combo.key !== null) {
    const vk = winVirtualKey(combo.key)
    if (vk === undefined) throw new ToolError(`Key "${combo.key}" is not supported on Windows`)
    vks.push(vk)
  }
  return { vks, ext: vks.map((vk) => (WIN_EXTENDED.has(vk) ? 1 : 0)) }
}

const DISPLAY_NAMES: Record<Modifier, [mac: string, win: string]> = {
  cmd: ['⌘', 'Ctrl'],
  ctrl: ['Ctrl', 'Ctrl'],
  alt: ['Option', 'Alt'],
  shift: ['Shift', 'Shift'],
  win: ['⌘', 'Win'],
  fn: ['Fn', 'Fn']
}

/** Human-readable form for summaries, e.g. "Ctrl+Shift+Esc". */
export function formatCombo(combo: KeyCombo, platform: NodeJS.Platform): string {
  const mac = platform === 'darwin'
  const parts = combo.modifiers.map((m) => DISPLAY_NAMES[m][mac ? 0 : 1])
  if (combo.key) parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key[0].toUpperCase() + combo.key.slice(1))
  return parts.join('+')
}
