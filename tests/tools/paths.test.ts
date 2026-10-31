import { describe, expect, it } from 'vitest'
import { displayPath, resolveUserPath, specialDirAlias, type PathContext } from '../../src/main/tools/paths'

const mac: PathContext = { platform: 'darwin', home: '/Users/u', env: { HOME: '/Users/u' } }
const win: PathContext = {
  platform: 'win32',
  home: 'C:\\Users\\u',
  env: { USERPROFILE: 'C:\\Users\\u', Temp: 'C:\\Users\\u\\AppData\\Local\\Temp' },
  // Desktop redirected to OneDrive with a localized name, as Electron's app.getPath reports it.
  specialDir: (name) => (name === 'desktop' ? 'C:\\Users\\u\\OneDrive\\Рабочий стол' : undefined)
}

describe('macOS paths', () => {
  const cases: Array<[string, string]> = [
    ['~', '/Users/u'],
    ['~/Desktop/a.txt', '/Users/u/Desktop/a.txt'],
    ['рабочий стол/отчёт.txt', '/Users/u/Desktop/отчёт.txt'],
    ['Рабочий стол', '/Users/u/Desktop'],
    ['desktop/x', '/Users/u/Desktop/x'],
    ['Загрузки', '/Users/u/Downloads'],
    ['downloads/file.pdf', '/Users/u/Downloads/file.pdf'],
    ['документы/план.docx', '/Users/u/Documents/план.docx'],
    ['изображения', '/Users/u/Pictures'],
    ['картинки/кот.png', '/Users/u/Pictures/кот.png'],
    ['pictures', '/Users/u/Pictures'],
    ['музыка', '/Users/u/Music'],
    ['видео', '/Users/u/Movies'],
    ['movies', '/Users/u/Movies'],
    ['notes.txt', '/Users/u/notes.txt'],
    ['/tmp/x/../y', '/tmp/y'],
    ['"~/a b.txt"', '/Users/u/a b.txt'],
    ['«~/кавычки.txt»', '/Users/u/кавычки.txt'],
    ['file:///Users/u/x%20y.txt', '/Users/u/x y.txt'],
    ['$HOME/x', '/Users/u/x']
  ]
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => expect(resolveUserPath(input, mac)).toBe(expected))
  }

  it('rejects empty input', () => {
    expect(() => resolveUserPath('  ', mac)).toThrow(/empty/)
  })
})

describe('Windows paths', () => {
  const cases: Array<[string, string]> = [
    ['~', 'C:\\Users\\u'],
    ['рабочий стол\\a.txt', 'C:\\Users\\u\\OneDrive\\Рабочий стол\\a.txt'],
    ['Desktop/a.txt', 'C:\\Users\\u\\OneDrive\\Рабочий стол\\a.txt'],
    ['Downloads/x.zip', 'C:\\Users\\u\\Downloads\\x.zip'],
    ['документы', 'C:\\Users\\u\\Documents'],
    ['видео', 'C:\\Users\\u\\Videos'],
    ['%USERPROFILE%\\Music\\a.mp3', 'C:\\Users\\u\\Music\\a.mp3'],
    ['%temp%\\log.txt', 'C:\\Users\\u\\AppData\\Local\\Temp\\log.txt'],
    ['C:/temp/x.txt', 'C:\\temp\\x.txt'],
    ['~\\Desktop', 'C:\\Users\\u\\Desktop'],
    ['notes.txt', 'C:\\Users\\u\\notes.txt']
  ]
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => expect(resolveUserPath(input, win)).toBe(expected))
  }
})

describe('helpers', () => {
  it('recognises folder aliases', () => {
    expect(specialDirAlias('Загрузках')).toBe('downloads')
    expect(specialDirAlias('мои документы')).toBe('documents')
    expect(specialDirAlias('Report')).toBeUndefined()
  })

  it('shortens home paths for display', () => {
    expect(displayPath('/Users/u/Desktop/a.txt', mac)).toBe('~/Desktop/a.txt')
    expect(displayPath('/etc/hosts', mac)).toBe('/etc/hosts')
    expect(displayPath('C:\\Users\\u\\Downloads', win)).toBe('~\\Downloads')
  })
})
