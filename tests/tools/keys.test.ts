import { describe, expect, it } from 'vitest'
import { formatCombo, MAX_COMBOS, parseKeys, toMacKey, toWinKeys } from '../../src/main/tools/keys'

const CMD = 0x100000
const SHIFT = 0x20000
const CTRL = 0x40000
const ALT = 0x80000
const NUMPAD = 0x200000
const FN = 0x800000

const mac = (keys: string) => parseKeys(keys, 'darwin').map(toMacKey)
const win = (keys: string) => parseKeys(keys, 'win32').map(toWinKeys)

describe('parseKeys', () => {
  it('parses modifiers and the main key', () => {
    expect(parseKeys('cmd+shift+4', 'darwin')).toEqual([{ modifiers: ['cmd', 'shift'], key: '4' }])
    expect(parseKeys('Ctrl + Shift + Esc', 'win32')).toEqual([{ modifiers: ['ctrl', 'shift'], key: 'escape' }])
  })

  it('maps "mod" / "meta" per platform', () => {
    expect(parseKeys('mod+c', 'darwin')[0].modifiers).toEqual(['cmd'])
    expect(parseKeys('mod+c', 'win32')[0].modifiers).toEqual(['ctrl'])
    expect(parseKeys('meta+d', 'win32')[0].modifiers).toEqual(['win'])
    expect(parseKeys('cmd+c', 'win32')[0].modifiers).toEqual(['ctrl'])
    expect(parseKeys('win+d', 'darwin')[0].modifiers).toEqual(['cmd'])
    expect(parseKeys('option+left', 'darwin')[0].modifiers).toEqual(['alt'])
  })

  it('splits sequences and repeats', () => {
    expect(parseKeys('ctrl+c, ctrl+v', 'win32')).toHaveLength(2)
    expect(parseKeys('ctrl+c,ctrl+v', 'win32')).toHaveLength(2)
    expect(parseKeys('down*3 enter', 'darwin').map((c) => c.key)).toEqual(['down', 'down', 'down', 'enter'])
    expect(parseKeys(['cmd+a', 'cmd+c'], 'darwin')).toHaveLength(2)
  })

  it('keeps punctuation keys that look like separators', () => {
    expect(parseKeys('cmd+,', 'darwin')).toEqual([{ modifiers: ['cmd'], key: 'comma' }])
    expect(parseKeys(',', 'darwin')).toEqual([{ modifiers: [], key: 'comma' }])
    expect(parseKeys('ctrl++', 'win32')).toEqual([{ modifiers: ['ctrl'], key: 'equal' }])
    expect(parseKeys('ctrl+-', 'win32')).toEqual([{ modifiers: ['ctrl'], key: 'minus' }])
  })

  it('accepts dash-separated combos, aliases and Russian names', () => {
    expect(parseKeys('cmd-shift-4', 'darwin')).toEqual([{ modifiers: ['cmd', 'shift'], key: '4' }])
    expect(parseKeys('return', 'darwin')[0].key).toBe('enter')
    expect(parseKeys('ввод', 'darwin')[0].key).toBe('enter')
    expect(parseKeys('пробел', 'win32')[0].key).toBe('space')
    expect(parseKeys('pgdn', 'win32')[0].key).toBe('pagedown')
    // Cyrillic letters are the physical keys of the ЙЦУКЕН layout: "с" sits on C.
    expect(parseKeys('ctrl+с', 'win32')).toEqual([{ modifiers: ['ctrl'], key: 'c' }])
    expect(parseKeys('cmd+м', 'darwin')).toEqual([{ modifiers: ['cmd'], key: 'v' }])
  })

  it('supports modifier-only combos', () => {
    expect(parseKeys('win', 'win32')).toEqual([{ modifiers: ['win'], key: null }])
  })

  it('rejects unknown keys and too many presses', () => {
    expect(() => parseKeys('ctrl+foo', 'win32')).toThrow(/Unknown key "foo"/)
    expect(() => parseKeys('a+b', 'win32')).toThrow(/more than one/)
    expect(() => parseKeys('', 'win32')).toThrow(/No keys/)
    expect(() => parseKeys(`down*${MAX_COMBOS + 1}`, 'win32')).toThrow(/Too many/)
  })
})

describe('macOS key codes and flags', () => {
  it('maps letters, digits and modifiers', () => {
    expect(mac('cmd+shift+4')).toEqual([{ code: 21, flags: CMD | SHIFT }])
    expect(mac('cmd+c')).toEqual([{ code: 8, flags: CMD }])
    expect(mac('cmd+v')).toEqual([{ code: 9, flags: CMD }])
    expect(mac('ctrl+cmd+q')).toEqual([{ code: 12, flags: CTRL | CMD }])
    expect(mac('alt+e')).toEqual([{ code: 14, flags: ALT }])
    expect(mac('cmd+space')).toEqual([{ code: 49, flags: CMD }])
  })

  it('adds the flags real keyboards report for arrows and F-keys', () => {
    expect(mac('up')).toEqual([{ code: 126, flags: NUMPAD | FN }])
    expect(mac('shift+left')).toEqual([{ code: 123, flags: SHIFT | NUMPAD | FN }])
    expect(mac('f5')).toEqual([{ code: 96, flags: FN }])
    expect(mac('delete')).toEqual([{ code: 117, flags: FN }])
    expect(mac('backspace')).toEqual([{ code: 51, flags: 0 }])
    expect(mac('enter')).toEqual([{ code: 36, flags: 0 }])
    expect(mac('escape')).toEqual([{ code: 53, flags: 0 }])
  })

  it('presses a lone modifier as its own key', () => {
    expect(mac('shift')).toEqual([{ code: 56, flags: SHIFT }])
  })

  it('rejects keys a Mac does not have', () => {
    expect(() => mac('printscreen')).toThrow(/cmd\+shift\+3/)
    expect(() => mac('menu')).toThrow(/does not exist on macOS/)
  })
})

describe('Windows virtual keys', () => {
  it('maps combos with modifiers first', () => {
    expect(win('ctrl+c')).toEqual([{ vks: [0x11, 0x43], ext: [0, 0] }])
    expect(win('alt+tab')).toEqual([{ vks: [0x12, 0x09], ext: [0, 0] }])
    expect(win('ctrl+shift+esc')).toEqual([{ vks: [0x11, 0x10, 0x1b], ext: [0, 0, 0] }])
    expect(win('alt+f4')).toEqual([{ vks: [0x12, 0x73], ext: [0, 0] }])
  })

  it('marks extended keys', () => {
    expect(win('win+d')).toEqual([{ vks: [0x5b, 0x44], ext: [1, 0] }])
    expect(win('delete')).toEqual([{ vks: [0x2e], ext: [1] }])
    expect(win('left')).toEqual([{ vks: [0x25], ext: [1] }])
    expect(win('volumeup')).toEqual([{ vks: [0xaf], ext: [1] }])
    expect(win('enter')).toEqual([{ vks: [0x0d], ext: [0] }])
  })

  it('maps digits, F-keys and punctuation (US layout)', () => {
    expect(win('7')).toEqual([{ vks: [0x37], ext: [0] }])
    expect(win('f12')).toEqual([{ vks: [0x7b], ext: [0] }])
    expect(win('f24')).toEqual([{ vks: [0x87], ext: [0] }])
    expect(win('ctrl+period')).toEqual([{ vks: [0x11, 0xbe], ext: [0, 0] }])
    expect(win('printscreen')).toEqual([{ vks: [0x2c], ext: [0] }])
    expect(win('win')).toEqual([{ vks: [0x5b], ext: [1] }])
  })

  it('rejects modifiers Windows cannot synthesize', () => {
    expect(() => win('fn+f1')).toThrow(/cannot be pressed/)
  })
})

describe('formatCombo', () => {
  it('renders readable names', () => {
    expect(formatCombo(parseKeys('ctrl+shift+esc', 'win32')[0], 'win32')).toBe('Ctrl+Shift+Escape')
    expect(formatCombo(parseKeys('cmd+shift+4', 'darwin')[0], 'darwin')).toBe('⌘+Shift+4')
  })
})
