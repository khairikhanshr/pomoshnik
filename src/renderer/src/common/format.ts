// Pure formatting helpers (no DOM access; unit-tested in tests/ui).
import type { ChatSummary, Platform } from '@shared/types'

export type ChatGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'earlier'

export interface ChatGroup {
  key: ChatGroupKey
  chats: ChatSummary[]
}

const DAY_MS = 86_400_000

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function groupKeyFor(ts: number, now: number): Exclude<ChatGroupKey, 'pinned'> {
  const today = startOfDay(now)
  if (ts >= today) return 'today'
  if (ts >= today - DAY_MS) return 'yesterday'
  if (ts >= today - 7 * DAY_MS) return 'week'
  return 'earlier'
}

/** Groups chats (newest first) into Сегодня / Вчера / Последние 7 дней / Ранее; pinned chats first. */
export function groupChats(chats: ChatSummary[], now = Date.now()): ChatGroup[] {
  const order: ChatGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'earlier']
  const buckets = new Map<ChatGroupKey, ChatSummary[]>()
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const chat of sorted) {
    const key: ChatGroupKey = chat.pinned ? 'pinned' : groupKeyFor(chat.updatedAt, now)
    const list = buckets.get(key) ?? []
    list.push(chat)
    buckets.set(key, list)
  }
  return order.filter((k) => buckets.has(k)).map((key) => ({ key, chats: buckets.get(key) ?? [] }))
}

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const weekdayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' })
const dayMonthFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
const fullDateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
const fullDateTimeFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

export function formatTime(ts: number): string {
  return timeFmt.format(ts)
}

/** Compact label for the chat list: 14:05 · вчера · пн · 12 окт. · 12 окт. 2024 г. */
export function formatListDate(ts: number, now = Date.now()): string {
  const key = groupKeyFor(ts, now)
  if (key === 'today') return timeFmt.format(ts)
  if (key === 'yesterday') return 'вчера'
  if (key === 'week') return weekdayFmt.format(ts)
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear()
  return (sameYear ? dayMonthFmt : fullDateFmt).format(ts)
}

export function formatFullDate(ts: number): string {
  return fullDateTimeFmt.format(ts)
}

/** 0:07, 1:23 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1).replace('.', ',')
}

/** Russian decimal comma: 0,75 */
export function formatDecimal(value: number, digits = 2): string {
  return value.toFixed(digits).replace('.', ',')
}

/** "джарвис" -> "Джарвис" */
export function capitalize(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase('ru-RU') + text.slice(1) : text
}

// ---------- Electron accelerators ----------

export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete'
}

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return CODE_KEYS[code] ?? null
}

export type AcceleratorResult = { kind: 'cancel' } | { kind: 'clear' } | { kind: 'pending' } | { kind: 'done'; accelerator: string }

/**
 * Converts a keydown into an Electron accelerator. Cmd (mac) / Ctrl (others) map to CommandOrControl so
 * the setting stays portable. Requires at least one modifier unless the key is a function key.
 */
export function acceleratorFromKey(e: KeyLike, platform: Platform): AcceleratorResult {
  const noMods = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  if (e.key === 'Escape' && noMods) return { kind: 'cancel' }
  if ((e.key === 'Backspace' || e.key === 'Delete') && noMods) return { kind: 'clear' }
  const key = keyFromCode(e.code)
  if (!key) return { kind: 'pending' }
  const mods: string[] = []
  const mac = platform === 'darwin'
  if (mac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl')
  if (mac && e.ctrlKey) mods.push('Control')
  if (!mac && e.metaKey) mods.push('Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const isFunctionKey = /^F\d+$/.test(key)
  if (mods.length === 0 && !isFunctionKey) return { kind: 'pending' }
  if (mods.length === 1 && mods[0] === 'Shift' && !isFunctionKey) return { kind: 'pending' }
  return { kind: 'done', accelerator: [...mods, key].join('+') }
}

const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: '⌘',
  CmdOrCtrl: '⌘',
  Command: '⌘',
  Cmd: '⌘',
  Super: '⌘',
  Meta: '⌘',
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  AltGr: '⌥',
  Shift: '⇧'
}

const PC_NAMES: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Command: 'Ctrl',
  Cmd: 'Ctrl',
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  Super: 'Win',
  Meta: 'Win',
  Alt: 'Alt',
  Option: 'Alt',
  AltGr: 'AltGr',
  Shift: 'Shift'
}

const KEY_LABELS: Record<string, string> = {
  Space: 'Пробел',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: 'Enter',
  Tab: 'Tab'
}

/** Human-readable accelerator parts, e.g. ['⌘', '⇧', 'Пробел'] or ['Ctrl', 'Shift', 'Пробел']. */
export function acceleratorParts(accelerator: string, platform: Platform): string[] {
  if (!accelerator) return []
  const mac = platform === 'darwin'
  return accelerator
    .split('+')
    .filter(Boolean)
    .map((part) => {
      const mod = mac ? MAC_SYMBOLS[part] : PC_NAMES[part]
      if (mod) return mod
      return KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part)
    })
}

export function formatAccelerator(accelerator: string, platform: Platform): string {
  const parts = acceleratorParts(accelerator, platform)
  return platform === 'darwin' ? parts.join('') : parts.join('+')
}
