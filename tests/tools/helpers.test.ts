import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./electron-mock')).electronMock())

import { toInstalled, toRunning } from '../../src/main/tools/apps/win'
import { decodeText, formatSize, isSensitivePath } from '../../src/main/tools/file-tools'
import { formatUptime, isoLocal, parsePmsetBattery, parseVmStatAvailable, winBattery } from '../../src/main/tools/info-tools'
import { describeVolume, parseMacVolume } from '../../src/main/tools/media-tools'
import { stripAnsi, truncateMiddle, userShell } from '../../src/main/tools/shell-tools'
import { normalizeUrl, searchUrl } from '../../src/main/tools/web-tools'


describe('URLs', () => {
  it('adds https to bare domains and keeps allowed schemes only', () => {
    expect(normalizeUrl('youtube.com').href).toBe('https://youtube.com/')
    expect(normalizeUrl('www.kaspi.kz/shop').href).toBe('https://www.kaspi.kz/shop')
    expect(normalizeUrl('яндекс.рф').hostname).toBe('xn--d1acpjx3f.xn--p1ai')
    expect(normalizeUrl('http://localhost:3000/x').href).toBe('http://localhost:3000/x')
    expect(normalizeUrl('mailto:a@b.kz').protocol).toBe('mailto:')
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/Only http/)
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/Only http/)
    expect(() => normalizeUrl('ms-settings:')).toThrow(/Only http/)
    expect(() => normalizeUrl('not a url')).toThrow(/Not a valid URL/)
  })

  it('builds search URLs', () => {
    expect(searchUrl('a b&c', 'google')).toBe('https://www.google.com/search?q=a%20b%26c')
    expect(searchUrl('кот', 'duckduckgo')).toBe('https://duckduckgo.com/?q=%D0%BA%D0%BE%D1%82')
  })
})

describe('text files', () => {
  it('decodes UTF-8 (with and without BOM), UTF-16 and Windows-1251', () => {
    expect(decodeText(Buffer.from('привет', 'utf8'))).toBe('привет')
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('да', 'utf8')]))).toBe('да')
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('мир', 'utf16le')]))).toBe('мир')
    const be = Buffer.from('мир', 'utf16le')
    be.swap16()
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('мир')
    // "Привет" in Windows-1251
    expect(decodeText(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).toBe('Привет')
    expect(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))).toBeNull()
  })

  it('flags hidden, startup and executable targets as sensitive', () => {
    expect(isSensitivePath('/Users/u/.zshrc', 'darwin')).toBe(true)
    expect(isSensitivePath('/Users/u/.ssh/authorized_keys', 'darwin')).toBe(true)
    expect(isSensitivePath('/Users/u/Library/LaunchAgents/x.plist', 'darwin')).toBe(true)
    expect(isSensitivePath('C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\a.txt', 'win32')).toBe(true)
    expect(isSensitivePath('C:\\Users\\u\\Desktop\\run.bat', 'win32')).toBe(true)
    expect(isSensitivePath('/Users/u/Desktop/notes.txt', 'darwin')).toBe(false)
  })

  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(25769803776)).toBe('24 GB')
  })
})

describe('system info parsing', () => {
  it('parses pmset battery output', () => {
    const text = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22610019)\t76%; discharging; 7:02 remaining present: true\n"
    expect(parsePmsetBattery(text)).toEqual({ percent: 76, state: 'discharging', remaining: '7:02', source: 'Battery Power' })
    const charged = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"
    expect(parsePmsetBattery(charged)).toMatchObject({ percent: 100, state: 'charged', remaining: undefined })
    expect(parsePmsetBattery("Now drawing from 'AC Power'\n")).toBeNull()
  })

  it('computes available memory from vm_stat', () => {
    const text = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                     9611.',
      'Pages active:                                 365807.',
      'Pages inactive:                               364104.',
      'Pages speculative:                               531.',
      'Pages purgeable:                                  41.'
    ].join('\n')
    expect(parseVmStatAvailable(text)).toBe((9611 + 364104 + 531 + 41) * 16384)
    expect(parseVmStatAvailable('garbage')).toBeNull()
  })

  it('maps Win32_Battery values', () => {
    expect(winBattery({ percent: 55, status: 1, minutes: 125 })).toEqual({ percent: 55, state: 'discharging', remaining: '2:05' })
    expect(winBattery({ percent: 90, status: 2, minutes: 71582788 })).toEqual({ percent: 90, state: 'on AC power', remaining: undefined })
    expect(winBattery(null)).toBeNull()
  })

  it('formats uptime and local ISO time', () => {
    expect(formatUptime(1244348)).toBe('14 d 9 h')
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe('3 h 12 min')
    expect(formatUptime(59)).toBe('0 min')
    expect(isoLocal(new Date(2026, 9, 29, 7, 5, 9))).toMatch(/^2026-10-29T07:05:09[+-]\d{2}:\d{2}$/)
  })
})

describe('volume results', () => {
  it('parses the AppleScript reply', () => {
    expect(parseMacVolume('50|false')).toEqual({ level: 50, muted: false, exact: true })
    expect(parseMacVolume('missing value|true')).toEqual({ level: null, muted: true, exact: true })
  })

  it('describes the outcome in English and Russian', () => {
    expect(describeVolume({ level: 30, muted: false, exact: true })).toEqual({ output: 'Volume is now 30%.', summary: 'Громкость: 30%' })
    expect(describeVolume({ level: 30, muted: true, exact: true }).summary).toBe('Звук выключен')
    expect(describeVolume({ level: null, muted: null, exact: false }).summary).toBe('Громкость изменена')
  })
})

describe('shell command output', () => {
  it('strips ANSI colors and keeps head and tail of long output', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07ok')).toBe('red ok')
    const long = 'a'.repeat(5000) + 'END'
    const cut = truncateMiddle(long, 1000)
    expect(cut.length).toBeLessThan(1100)
    expect(cut.endsWith('END')).toBe(true)
    expect(cut).toContain('characters omitted')
  })

  it('uses the login shell only when it is a known shell', () => {
    expect(userShell({ SHELL: '/bin/bash' }, () => true)).toBe('/bin/bash')
    expect(userShell({ SHELL: '/opt/homebrew/bin/fish' }, () => true)).toBe('/opt/homebrew/bin/fish')
    expect(userShell({ SHELL: '/tmp/evil; rm -rf ~' }, () => true)).toBe('/bin/zsh')
    expect(userShell({ SHELL: '/bin/bash' }, () => false)).toBe('/bin/zsh')
    expect(userShell({}, () => true)).toBe('/bin/zsh')
  })
})

describe('Windows app lists', () => {
  it('dedupes Start menu entries', () => {
    const apps = toInstalled([
      { name: 'Блокнот', id: 'notepad', kind: 'appx' },
      { name: 'Блокнот', id: 'notepad', kind: 'appx' },
      { name: 'Paint', id: 'C:\\x\\Paint.lnk', kind: 'shortcut' },
      { name: 'Uninstall Telegram', id: 'C:\\t\\unins000.exe', kind: 'appx' },
      { name: 'Удалить Zoom', id: 'zoom-uninstall', kind: 'appx' }
    ])
    expect(apps.map((a) => [a.name, a.kind])).toEqual([
      ['Paint', 'shortcut'],
      ['Блокнот', 'appx']
    ])
  })

  it('names running windows by description and skips Jarvis itself', () => {
    const running = toRunning(
      [
        { id: 10, name: 'Telegram', title: 'Telegram (3)', description: 'Telegram Desktop', path: 'C:\\t.exe' },
        { id: 11, name: 'ApplicationFrameHost', title: 'Калькулятор', description: null, path: null },
        { id: 99, name: 'Jarvis', title: 'Jarvis', description: 'Jarvis', path: null }
      ],
      99
    )
    expect(running.map((r) => r.name)).toEqual(['Telegram Desktop', 'Калькулятор'])
    expect(running[1].names).toContain('ApplicationFrameHost')
  })
})
