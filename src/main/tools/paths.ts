// User path resolution: "~", "рабочий стол/отчёт.txt", "Downloads\\file.pdf", "%USERPROFILE%\\x".
// Relative paths resolve against the home directory (the app's cwd means nothing to the user).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolError } from './errors'
import { normalizeName } from './fuzzy'

export type SpecialDir = 'home' | 'desktop' | 'downloads' | 'documents' | 'pictures' | 'music' | 'videos'

export interface PathContext {
  platform: NodeJS.Platform
  home: string
  /** Real folder location (Electron app.getPath follows OneDrive redirection and localized names). */
  specialDir?: (name: SpecialDir) => string | undefined
  env?: Record<string, string | undefined>
}

const DIR_ALIASES: ReadonlyArray<readonly [SpecialDir, readonly string[]]> = [
  ['desktop', ['рабочий стол', 'рабочем столе', 'рабочего стола', 'desktop']],
  ['downloads', ['загрузки', 'загрузках', 'загрузок', 'закачки', 'downloads', 'download']],
  ['documents', ['документы', 'документах', 'документов', 'мои документы', 'documents', 'my documents']],
  ['pictures', ['изображения', 'изображениях', 'картинки', 'картинках', 'фотографии', 'pictures', 'my pictures', 'images']],
  ['music', ['музыка', 'музыке', 'музыку', 'music', 'my music']],
  ['videos', ['видео', 'видеозаписи', 'фильмы', 'videos', 'movies', 'my videos']],
  ['home', ['домашняя папка', 'домашней папке', 'домашнюю папку', 'home']]
]

const ALIAS_INDEX = new Map<string, SpecialDir>()
for (const [dir, names] of DIR_ALIASES) for (const name of names) ALIAS_INDEX.set(normalizeName(name), dir)

/** Folder for a spoken alias ("Загрузки" -> 'downloads'), if any. */
export function specialDirAlias(segment: string): SpecialDir | undefined {
  return ALIAS_INDEX.get(normalizeName(segment))
}

function defaultSpecialDir(name: SpecialDir, ctx: PathContext): string {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix
  const folder: Record<SpecialDir, string> = {
    home: '',
    desktop: 'Desktop',
    downloads: 'Downloads',
    documents: 'Documents',
    pictures: 'Pictures',
    music: 'Music',
    videos: ctx.platform === 'darwin' ? 'Movies' : 'Videos'
  }
  return folder[name] ? p.join(ctx.home, folder[name]) : ctx.home
}

export function specialDirPath(name: SpecialDir, ctx: PathContext): string {
  return ctx.specialDir?.(name) || defaultSpecialDir(name, ctx)
}

function stripQuotes(text: string): string {
  const t = text.trim()
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['«', '»'], ['“', '”']]
  for (const [open, close] of pairs) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) return t.slice(1, -1).trim()
  }
  return t
}

function expandEnv(text: string, ctx: PathContext): string {
  const env = ctx.env ?? {}
  const lookup = (name: string): string | undefined => {
    if (ctx.platform !== 'win32') return env[name]
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
    return key ? env[key] : undefined
  }
  let out = text
  if (ctx.platform === 'win32') out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => lookup(name) ?? m)
  return out.replace(/^\$(?:\{HOME\}|HOME)(?=$|[\\/])/, ctx.home)
}

/** Absolute, normalized path for user input. Throws a ToolError for empty input. */
export function resolveUserPath(input: string, ctx: PathContext): string {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix
  let text = stripQuotes(input)
  if (!text) throw new ToolError('Path is empty')
  if (/^file:\/\//i.test(text)) {
    try {
      text = fileURLToPath(text, { windows: ctx.platform === 'win32' })
    } catch {
      throw new ToolError(`Invalid file URL: ${text}`)
    }
  }
  text = expandEnv(text, ctx)
  if (text === '~') return p.normalize(ctx.home)
  if (/^~[\\/]/.test(text)) return p.normalize(p.join(ctx.home, text.slice(2)))
  if (p.isAbsolute(text)) return p.normalize(text)

  const separators = ctx.platform === 'win32' ? /[\\/]/ : /\//
  const [first, ...rest] = text.split(separators)
  const alias = specialDirAlias(first)
  if (alias) return p.normalize(p.join(specialDirPath(alias, ctx), ...rest))
  return p.normalize(p.join(ctx.home, text))
}

/** "~/Desktop/x" style display form for summaries. */
export function displayPath(full: string, ctx: PathContext): string {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix
  const rel = p.relative(ctx.home, full)
  if (!rel) return '~'
  if (rel.startsWith('..') || p.isAbsolute(rel)) return full
  return ctx.platform === 'win32' ? `~\\${rel}` : `~/${rel}`
}
