// Reminder time parsing and formatting (pure).
import { ToolError } from '../errors'

export const MAX_REMINDER_MS = 2 * 366 * 24 * 3600 * 1000
/** "at" values this far in the past are rejected; anything closer fires right away. */
const PAST_TOLERANCE_MS = 60_000

/**
 * Due time from `in_seconds` or `at`: ISO 8601 (local time when no offset), "YYYY-MM-DD HH:MM",
 * a bare date (09:00 local), or "HH:MM" (today, or tomorrow if that time has passed).
 */
export function parseDueTime(inSeconds: number | undefined, at: string | undefined, now: number): number {
  let due: number
  if (at !== undefined) due = parseAt(at, now)
  else if (inSeconds !== undefined) {
    if (!(inSeconds > 0)) throw new ToolError('in_seconds must be a positive number')
    due = now + Math.round(inSeconds * 1000)
  } else throw new ToolError('Give either in_seconds or at')
  if (due < now - PAST_TOLERANCE_MS) throw new ToolError(`The time ${new Date(due).toISOString()} is in the past`)
  if (due - now > MAX_REMINDER_MS) throw new ToolError('Reminders can be set at most two years ahead')
  return Math.max(due, now + 1000)
}

function parseAt(raw: string, now: number): number {
  const text = raw.trim()
  const time = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(text)
  if (time) {
    const [h, m, s] = [Number(time[1]), Number(time[2]), Number(time[3] ?? 0)]
    if (h > 23 || m > 59 || s > 59) throw new ToolError(`Invalid time "${raw}"`)
    const d = new Date(now)
    d.setHours(h, m, s, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (date) return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), 9, 0, 0, 0).getTime()
  const iso = text.replace(/^(\d{4}-\d{2}-\d{2})[ _](\d)/, '$1T$2')
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new ToolError(`Cannot parse time "${raw}"; use ISO 8601 like 2026-05-01T18:30`)
  return ms
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "2026-10-29 19:45 (+05:00)" — unambiguous local time for the model. */
export function formatLocal(ms: number): string {
  const d = new Date(ms)
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`
}

/** "через 10 мин" / "через 2 ч 5 мин" / "через 3 дн." */
export function formatRelativeRu(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((ms - now) / 60_000))
  if (minutes < 1) return 'меньше чем через минуту'
  if (minutes < 60) return `через ${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 ? `через ${hours} ч ${minutes % 60} мин` : `через ${hours} ч`
  return `через ${Math.round(hours / 24)} дн.`
}

/** "в 19:45" today, "завтра в 09:00", else "30 октября в 09:00". */
export function formatWhenRu(ms: number, now: number): string {
  const d = new Date(ms)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = new Date(now)
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000
  )
  if (dayDiff === 0) return `в ${hm}`
  if (dayDiff === 1) return `завтра в ${hm}`
  const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(d)
  return `${date} в ${hm}`
}
