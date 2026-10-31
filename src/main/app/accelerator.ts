// Pure validation of Electron accelerator strings (globalShortcut throws on invalid ones).

const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta'
])

const NAMED_KEYS = new Set(
  [
    'plus',
    'space',
    'tab',
    'capslock',
    'numlock',
    'scrolllock',
    'backspace',
    'delete',
    'insert',
    'return',
    'enter',
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'pageup',
    'pagedown',
    'escape',
    'esc',
    'volumeup',
    'volumedown',
    'volumemute',
    'medianexttrack',
    'mediaprevioustrack',
    'mediastop',
    'mediaplaypause',
    'printscreen',
    'numdec',
    'numadd',
    'numsub',
    'nummult',
    'numdiv',
    ...Array.from({ length: 10 }, (_, i) => `num${i}`),
    ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`)
  ].map((k) => k.toLowerCase())
)

const PUNCTUATION = new Set([...')!@#$%^&*(:;<,_->.?/~`{][|\\}"\'='])

/** Keys that are acceptable as global shortcuts without a modifier. */
const STANDALONE = /^(f([1-9]|1\d|2[0-4])|volumeup|volumedown|volumemute|medianexttrack|mediaprevioustrack|mediastop|mediaplaypause|printscreen)$/

export interface AcceleratorCheck {
  valid: boolean
  /** Russian reason when invalid. */
  reason?: string
}

export function checkAccelerator(accelerator: string): AcceleratorCheck {
  const acc = accelerator.trim()
  if (!acc) return { valid: false, reason: 'пустая комбинация' }
  const parts = acc.split('+').map((p) => p.trim())
  if (parts.some((p) => !p)) return { valid: false, reason: 'используйте «Plus» вместо «+»' }
  const key = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase())
  const seen = new Set<string>()
  for (const m of modifiers) {
    if (!MODIFIERS.has(m)) return { valid: false, reason: `неизвестный модификатор «${m}»` }
    if (seen.has(m)) return { valid: false, reason: `модификатор «${m}» указан дважды` }
    seen.add(m)
  }
  const lower = key.toLowerCase()
  if (MODIFIERS.has(lower)) return { valid: false, reason: 'нет основной клавиши' }
  const isKey = /^[a-z0-9]$/i.test(key) || PUNCTUATION.has(key) || NAMED_KEYS.has(lower)
  if (!isKey) return { valid: false, reason: `неизвестная клавиша «${key}»` }
  if (!modifiers.length && !STANDALONE.test(lower)) {
    return { valid: false, reason: 'без модификатора (Cmd/Ctrl/Alt/Shift) комбинация мешала бы набору текста' }
  }
  return { valid: true }
}
