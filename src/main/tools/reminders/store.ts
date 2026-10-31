// Persistent reminder scheduler (userData/reminders.json). Electron-free so it can be tested
// with fake timers; delivery (notification, speech) is the onFire callback's job.
import { newId, readJson, writeJsonAtomic } from '../../util/fs'

export interface Reminder {
  id: string
  text: string
  /** Epoch ms. */
  dueAt: number
  createdAt: number
  chatId?: string
}

interface RemindersFile {
  version: 1
  reminders: Reminder[]
}

export interface SchedulerOptions {
  file: string
  /** lateMs > 0 when the reminder was missed (app was not running or the computer slept). */
  onFire: (reminder: Reminder, lateMs: number) => void
  now?: () => number
  /** Timers stop during system sleep, so pending reminders are re-checked at least this often. */
  maxTimerMs?: number
  /** Reminders already overdue at startup wait this long, so the windows are ready. */
  startupDelayMs?: number
  onError?: (err: unknown) => void
}

export const MAX_REMINDERS = 200
const DUE_SLACK_MS = 250

function isReminder(value: unknown): value is Reminder {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    /^[a-z0-9]{1,40}$/.test(r.id) &&
    typeof r.text === 'string' &&
    typeof r.dueAt === 'number' &&
    Number.isFinite(r.dueAt) &&
    typeof r.createdAt === 'number' &&
    (r.chatId === undefined || typeof r.chatId === 'string')
  )
}

export class ReminderScheduler {
  private reminders: Reminder[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private readonly now: () => number

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? Date.now
  }

  start(): void {
    if (this.started) return
    this.started = true
    const data = readJson<RemindersFile>(this.opts.file)
    const list = Array.isArray(data?.reminders) ? data.reminders.filter(isReminder) : []
    this.reminders = list.sort((a, b) => a.dueAt - b.dueAt)
    this.arm(this.opts.startupDelayMs ?? 0)
  }

  list(): Reminder[] {
    return [...this.reminders].sort((a, b) => a.dueAt - b.dueAt)
  }

  add(input: { text: string; dueAt: number; chatId?: string }): Reminder {
    if (this.reminders.length >= MAX_REMINDERS) throw new Error(`Too many pending reminders (max ${MAX_REMINDERS})`)
    const reminder: Reminder = { id: newId(), text: input.text, dueAt: input.dueAt, createdAt: this.now() }
    if (input.chatId) reminder.chatId = input.chatId
    this.reminders.push(reminder)
    this.save()
    this.arm()
    return reminder
  }

  cancel(id: string): Reminder | null {
    const index = this.reminders.findIndex((r) => r.id === id)
    if (index < 0) return null
    const [removed] = this.reminders.splice(index, 1)
    this.save()
    this.arm()
    return removed
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.started = false
  }

  private save(): void {
    try {
      writeJsonAtomic(this.opts.file, { version: 1, reminders: this.list() } satisfies RemindersFile)
    } catch (err) {
      this.opts.onError?.(err)
    }
  }

  private arm(minDelay = 0): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started || this.reminders.length === 0) return
    const next = Math.min(...this.reminders.map((r) => r.dueAt))
    const delay = Math.max(minDelay, next - this.now(), 0)
    this.timer = setTimeout(() => this.tick(), Math.min(delay, this.opts.maxTimerMs ?? 30_000))
    this.timer.unref?.()
  }

  private tick(): void {
    this.timer = null
    const now = this.now()
    const due = this.reminders.filter((r) => r.dueAt <= now + DUE_SLACK_MS)
    if (due.length > 0) {
      this.reminders = this.reminders.filter((r) => !due.includes(r))
      this.save()
      for (const reminder of due) {
        try {
          this.opts.onFire(reminder, Math.max(0, now - reminder.dueAt))
        } catch (err) {
          this.opts.onError?.(err)
        }
      }
    }
    this.arm()
  }
}
