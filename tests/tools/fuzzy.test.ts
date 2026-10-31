import { describe, expect, it } from 'vitest'
import { appQueryVariants, findAppAlias } from '../../src/main/tools/app-aliases'
import {
  cleanDisplayName,
  decideMatch,
  levenshtein,
  normalizeName,
  phoneticKey,
  rankCandidates,
  scoreName,
  transliterate
} from '../../src/main/tools/fuzzy'

const MAC_APPS = [
  'Calculator',
  'Telegram',
  'Telegram Lite',
  'Google Chrome',
  'Safari',
  'Notes',
  'Music',
  'Яндекс Музыка',
  'Microsoft Word',
  'Microsoft Excel',
  'Microsoft PowerPoint',
  'WordPad Pro',
  'WhatsApp',
  'Discord',
  'zoom.us',
  'Slack',
  'Spotify',
  'Finder',
  'Photos',
  'Photo Booth',
  'Calendar',
  'TextEdit',
  'Terminal',
  'System Settings',
  'Visual Studio Code',
  'Postgres',
  'GitHub Desktop',
  'Antigravity',
  'Antigravity IDE'
]

// Russian Windows: Get-StartApps returns localized names.
const WIN_APPS = [
  'Калькулятор',
  'Блокнот',
  'Проводник',
  'Параметры',
  'Telegram Desktop',
  'Microsoft Edge',
  'Google Chrome',
  'Word',
  'Excel',
  'PowerPoint',
  'Командная строка',
  'Windows PowerShell',
  'Диспетчер задач',
  'Paint',
  'Фотографии'
]

function pick(query: string, apps: string[], platform: NodeJS.Platform): string | null {
  const ranked = rankCandidates(appQueryVariants(query, platform), apps.map((name) => ({ item: name, names: [name] })))
  const outcome = decideMatch(ranked)
  return outcome.kind === 'match' ? outcome.best.item : null
}

describe('normalization', () => {
  it('is case / diacritics insensitive and drops extensions and punctuation', () => {
    expect(normalizeName('  Ёлка  CAFÉ.app ')).toBe('елка cafe')
    expect(normalizeName('Microsoft-Word.exe')).toBe('microsoft word')
    expect(normalizeName('Zoom.us')).toBe('zoom us')
  })

  it('strips invisible bidi marks from display names', () => {
    expect(cleanDisplayName('\u200eWhatsApp')).toBe('WhatsApp')
    expect(cleanDisplayName(' Telegram\u200f ')).toBe('Telegram')
  })

  it('transliterates Cyrillic (incl. Kazakh letters)', () => {
    expect(transliterate('телеграм')).toBe('telegram')
    expect(transliterate('щука ёж')).toBe('schuka ezh')
    expect(transliterate('қазақ')).toBe('kazak')
  })

  it('maps sound-alike spellings to the same phonetic key', () => {
    expect(phoneticKey('дискорд')).toBe(phoneticKey('Discord'))
    expect(phoneticKey('фотошоп')).toBe(phoneticKey('Photoshop'))
    expect(phoneticKey('слак')).toBe(phoneticKey('Slack'))
    expect(phoneticKey('телеграмм')).toBe(phoneticKey('Telegram'))
    expect(phoneticKey('курсор')).toBe(phoneticKey('Cursor'))
  })

  it('computes edit distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(scoreName('Telegram', 'telegram')).toBe(100)
    expect(scoreName('word', 'Microsoft Word')).toBeGreaterThan(scoreName('word', 'WordPad Pro'))
  })
})

describe('app matching on macOS', () => {
  const cases: Array<[string, string]> = [
    ['калькулятор', 'Calculator'],
    ['КАЛЬКУЛЯТОР', 'Calculator'],
    ['телеграм', 'Telegram'],
    ['Телеграмм', 'Telegram'],
    ['приложение телеграм', 'Telegram'],
    ['хром', 'Google Chrome'],
    ['гугл хром', 'Google Chrome'],
    ['заметки', 'Notes'],
    ['музыка', 'Music'],
    ['яндекс музыка', 'Яндекс Музыка'],
    ['ворд', 'Microsoft Word'],
    ['word', 'Microsoft Word'],
    ['эксель', 'Microsoft Excel'],
    ['пауэрпоинт', 'Microsoft PowerPoint'],
    ['вотсап', 'WhatsApp'],
    ['дискорд', 'Discord'],
    ['зум', 'zoom.us'],
    ['слак', 'Slack'],
    ['спотифай', 'Spotify'],
    ['финдер', 'Finder'],
    ['фото', 'Photos'],
    ['календарь', 'Calendar'],
    ['блокнот', 'TextEdit'],
    ['терминал', 'Terminal'],
    ['настройки', 'System Settings'],
    ['вс код', 'Visual Studio Code'],
    ['safari', 'Safari'],
    // transliteration only (no alias entry)
    ['постгрес', 'Postgres'],
    ['гитхаб десктоп', 'GitHub Desktop'],
    ['антигравити', 'Antigravity']
  ]
  for (const [query, expected] of cases) {
    it(`"${query}" -> ${expected}`, () => expect(pick(query, MAC_APPS, 'darwin')).toBe(expected))
  }
})

describe('app matching on Russian Windows (localized Start menu names)', () => {
  const cases: Array<[string, string]> = [
    ['calculator', 'Калькулятор'],
    ['калькулятор', 'Калькулятор'],
    ['notepad', 'Блокнот'],
    ['блокнот', 'Блокнот'],
    ['проводник', 'Проводник'],
    ['explorer', 'Проводник'],
    ['настройки', 'Параметры'],
    ['settings', 'Параметры'],
    ['телеграм', 'Telegram Desktop'],
    ['ворд', 'Word'],
    ['эксель', 'Excel'],
    ['эдж', 'Microsoft Edge'],
    ['командная строка', 'Командная строка'],
    ['диспетчер задач', 'Диспетчер задач'],
    ['пейнт', 'Paint'],
    ['фото', 'Фотографии']
  ]
  for (const [query, expected] of cases) {
    it(`"${query}" -> ${expected}`, () => expect(pick(query, WIN_APPS, 'win32')).toBe(expected))
  }
})

describe('ambiguity and misses', () => {
  it('reports near-equal candidates as ambiguous', () => {
    const apps = ['Adobe Photoshop 2024', 'Adobe Photoshop 2025']
    const ranked = rankCandidates(appQueryVariants('фотошоп', 'darwin'), apps.map((n) => ({ item: n, names: [n] })))
    const outcome = decideMatch(ranked)
    expect(outcome.kind).toBe('ambiguous')
    expect(outcome.ranked.map((r) => r.item)).toEqual(expect.arrayContaining(apps))
  })

  it('returns none for unrelated names', () => {
    const ranked = rankCandidates(['абракадабра'], MAC_APPS.map((n) => ({ item: n, names: [n] })))
    expect(decideMatch(ranked).kind).toBe('none')
  })

  it('prefers the exact name over longer variants', () => {
    expect(pick('telegram', MAC_APPS, 'darwin')).toBe('Telegram')
  })
})

describe('alias dictionary', () => {
  it('maps websites and the default browser', () => {
    expect(findAppAlias('ютуб')?.url).toBe('https://www.youtube.com')
    expect(findAppAlias('YouTube')?.url).toBe('https://www.youtube.com')
    expect(findAppAlias('браузер')?.browser).toBe(true)
    expect(findAppAlias('программу калькулятор')?.mac).toContain('Calculator')
  })

  it('expands queries with platform-specific names', () => {
    expect(appQueryVariants('блокнот', 'darwin')).toContain('TextEdit')
    expect(appQueryVariants('блокнот', 'win32')).toEqual(expect.arrayContaining(['Notepad', 'Блокнот']))
    expect(appQueryVariants('Unknown App', 'darwin')).toEqual(['Unknown App', 'unknown app'])
  })
})
