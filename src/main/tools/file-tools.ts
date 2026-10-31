import type { Stats } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { shell } from 'electron'
import { LIMITS } from '@shared/defaults'
import { clip, optBoolean, optNumber, reqString } from './args'
import { denied, fail, ok, type ToolDef, type ToolEnv } from './define'
import { ToolError } from './errors'
import { decideMatch, rankCandidates } from './fuzzy'
import { hostPathContext } from './host-paths'
import { displayPath, resolveUserPath, type PathContext } from './paths'

export const MAX_READ_BYTES = 1024 * 1024
const MAX_WRITE_CHARS = 2_000_000
const MAX_LISTED = 300
const DEFAULT_READ_CHARS = 6000

const EXECUTABLE_EXT = new Set([
  '.app', '.command', '.sh', '.zsh', '.bash', '.pkg', '.dmg', '.scpt', '.applescript', '.workflow', '.jar', '.exe', '.msi', '.bat',
  '.cmd', '.com', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.scr', '.lnk', '.reg', '.hta', '.cpl'
])

function baseTitle(raw: unknown): string {
  const text = String(raw ?? '').trim().replace(/[\\/]+$/, '')
  return clip(path.win32.basename(path.posix.basename(text)) || text, 40)
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/** Hidden files, startup folders and executables need confirmation before being written. */
export function isSensitivePath(full: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix
  const parts = full.split(/[\\/]+/)
  if (parts.some((s) => s.startsWith('.') && s !== '.' && s !== '..')) return true
  if (/LaunchAgents|LaunchDaemons|[\\/]Start Menu[\\/]Programs[\\/]Startup/i.test(full)) return true
  return EXECUTABLE_EXT.has(p.extname(full).toLowerCase())
}

/** Decodes text files: UTF-8 (BOM optional), UTF-16 with BOM, legacy Windows-1251. Null for binary data. */
export function decodeText(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf
  if (body.subarray(0, 8000).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(body)
    } catch {
      return null
    }
  }
}

async function statOrNull(full: string): Promise<Stats | null> {
  try {
    return await stat(full)
  } catch {
    return null
  }
}

/** "Not found" with close sibling names (e.g. "отчет" vs "Отчёт.docx"). */
async function notFound(full: string, ctx: PathContext): Promise<ToolError> {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix
  let hint = ''
  try {
    const names = await readdir(p.dirname(full))
    const ranked = rankCandidates([p.basename(full)], names.map((n) => ({ item: n, names: [n] }))).filter((r) => r.score >= 60)
    const outcome = decideMatch(ranked)
    const picks = (outcome.kind === 'match' ? [outcome.best] : ranked).slice(0, 3).map((r) => p.join(p.dirname(full), r.item))
    if (picks.length) hint = ` Did you mean: ${picks.map((x) => displayPath(x, ctx)).join(', ')}?`
  } catch {
    // parent folder missing too
  }
  return new ToolError(`Not found: ${displayPath(full, ctx)}.${hint}`, 'Не найдено')
}

export function fileTools(env: ToolEnv, pathContext: () => PathContext = () => hostPathContext(env.platform)): ToolDef[] {
  const openPath: ToolDef = {
    spec: {
      name: 'open_path',
      description:
        'Open a file (in its default app) or a folder (in Finder / Explorer). Accepts absolute paths, "~", and folder aliases in ' +
        'Russian or English: Desktop/рабочий стол, Downloads/загрузки, Documents/документы, Pictures/изображения, Music/музыка, ' +
        'Videos/видео. Relative paths start at the home folder.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'e.g. "~/Downloads/report.pdf", "загрузки", "C:\\\\Users\\\\me\\\\file.txt".' } },
        required: ['path'],
        additionalProperties: false
      }
    },
    title: (args) => `Открываю ${baseTitle(args.path)}`,
    run: async (args, ctx) => {
      const pc = pathContext()
      const full = resolveUserPath(reqString(args, 'path', { max: 4096 }), pc)
      const info = await statOrNull(full)
      if (!info) throw await notFound(full, pc)
      const p = pc.platform === 'win32' ? path.win32 : path.posix
      const isApp = info.isDirectory() && p.extname(full).toLowerCase() === '.app'
      if ((info.isFile() || isApp) && EXECUTABLE_EXT.has(p.extname(full).toLowerCase())) {
        const allowed = await env.confirm(ctx, { message: `Запустить «${p.basename(full)}»?`, detail: full })
        if (!allowed) return denied(`run ${full}`)
      }
      const error = await shell.openPath(full)
      if (error) return fail(`Could not open ${displayPath(full, pc)}: ${error}`, 'Не удалось открыть')
      const kind = info.isDirectory() && !isApp ? 'folder' : 'file'
      return ok(`Opened the ${kind} ${displayPath(full, pc)}.`, `Открыто: ${p.basename(full) || full}`)
    }
  }

  const listDirectory: ToolDef = {
    spec: {
      name: 'list_directory',
      description: 'List the contents of a folder (same path rules as open_path). Hidden files are not shown.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder path or alias, e.g. "~/Desktop" or "загрузки".' } },
        required: ['path'],
        additionalProperties: false
      }
    },
    title: (args) => `Смотрю папку ${baseTitle(args.path)}`,
    run: async (args) => {
      const pc = pathContext()
      const full = resolveUserPath(reqString(args, 'path', { max: 4096 }), pc)
      const info = await statOrNull(full)
      if (!info) throw await notFound(full, pc)
      if (!info.isDirectory()) throw new ToolError(`${displayPath(full, pc)} is a file, not a folder`)
      const p = pc.platform === 'win32' ? path.win32 : path.posix
      const entries = await readdir(full, { withFileTypes: true })
      const visible = entries.filter((e) => !e.name.startsWith('.') && !/^(desktop\.ini|thumbs\.db)$/i.test(e.name))
      const hidden = entries.length - visible.length
      visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      const shown = visible.slice(0, MAX_LISTED)
      const lines = await Promise.all(
        shown.map(async (e) => {
          if (e.isDirectory()) return `${e.name}/`
          const s = await statOrNull(p.join(full, e.name))
          if (!s) return e.name
          if (s.isDirectory()) return `${e.name}/`
          return `${e.name} — ${formatSize(s.size)}, ${s.mtime.toISOString().slice(0, 10)}`
        })
      )
      const folders = visible.filter((e) => e.isDirectory()).length
      const files = visible.length - folders
      const header =
        `${displayPath(full, pc)}: ${folders} folders, ${files} files` +
        (hidden ? ` (${hidden} hidden not shown)` : '') +
        (visible.length > shown.length ? `; first ${shown.length} listed` : '')
      return ok(lines.length ? `${header}\n${lines.join('\n')}` : `${header}. The folder is empty.`, `Папок: ${folders}, файлов: ${files}`)
    }
  }

  const readTextFile: ToolDef = {
    spec: {
      name: 'read_text_file',
      description: 'Read a text file (up to 1 MB; UTF-8, UTF-16 or Windows-1251). Same path rules as open_path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          maxChars: { type: 'number', description: `Max characters to return (default ${DEFAULT_READ_CHARS}).` }
        },
        required: ['path'],
        additionalProperties: false
      }
    },
    title: (args) => `Читаю файл ${baseTitle(args.path)}`,
    run: async (args) => {
      const pc = pathContext()
      const full = resolveUserPath(reqString(args, 'path', { max: 4096 }), pc)
      const limit = Math.min(optNumber(args, 'maxChars', { min: 1, integer: true }) ?? DEFAULT_READ_CHARS, LIMITS.maxToolOutputChars - 300)
      const info = await statOrNull(full)
      if (!info) throw await notFound(full, pc)
      if (info.isDirectory()) throw new ToolError(`${displayPath(full, pc)} is a folder; use list_directory`)
      if (info.size > MAX_READ_BYTES) throw new ToolError(`File is too large (${formatSize(info.size)}; max 1 MB)`)
      const text = decodeText(await readFile(full))
      if (text === null) throw new ToolError(`${displayPath(full, pc)} is not a text file`, 'Это не текстовый файл')
      const lines = text.split(/\r\n|\r|\n/).length
      const body = text.length > limit ? `${text.slice(0, limit)}\n[truncated: first ${limit} of ${text.length} characters]` : text
      const name = (pc.platform === 'win32' ? path.win32 : path.posix).basename(full)
      return ok(`File ${displayPath(full, pc)} (${formatSize(info.size)}, ${lines} lines):\n---\n${body}`, `Прочитано: ${name}`)
    }
  }

  const writeTextFile: ToolDef = {
    spec: {
      name: 'write_text_file',
      description:
        'Create a UTF-8 text file (folders are created as needed). An existing file is replaced only with overwrite=true, ' +
        'after the user confirms. Same path rules as open_path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, e.g. "~/Desktop/notes.txt".' },
          content: { type: 'string', description: 'Full text content.' },
          overwrite: { type: 'boolean', description: 'Replace the file if it exists.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    },
    title: (args) => `Записываю файл ${baseTitle(args.path)}`,
    run: async (args, ctx) => {
      const pc = pathContext()
      const p = pc.platform === 'win32' ? path.win32 : path.posix
      const full = resolveUserPath(reqString(args, 'path', { max: 4096 }), pc)
      const raw = args.content
      if (typeof raw !== 'string') throw new ToolError('Missing required argument "content" (string)')
      if (raw.length > MAX_WRITE_CHARS) throw new ToolError(`Content is too long (max ${MAX_WRITE_CHARS} characters)`)
      const overwrite = optBoolean(args, 'overwrite') ?? false
      const info = await statOrNull(full)
      if (info?.isDirectory()) throw new ToolError(`${displayPath(full, pc)} is a folder`)
      if (info && !overwrite) {
        return fail(
          `${displayPath(full, pc)} already exists. Call again with overwrite: true to replace it (the user will be asked to confirm).`,
          'Файл уже существует'
        )
      }
      const name = p.basename(full)
      if (info || isSensitivePath(full, pc.platform)) {
        const allowed = await env.confirm(ctx, {
          message: info ? `Перезаписать файл «${name}»?` : `Создать файл «${name}»?`,
          detail: full
        })
        if (!allowed) return denied(`${info ? 'overwrite' : 'create'} ${full}`)
      }
      await mkdir(p.dirname(full), { recursive: true })
      await writeFile(full, raw, 'utf8')
      return ok(`${info ? 'Replaced' : 'Created'} ${displayPath(full, pc)} (${raw.length} characters).`, `Сохранено: ${name}`)
    }
  }

  return [openPath, listDirectory, readTextFile, writeTextFile]
}
