import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReminderScheduler, type Reminder } from '../../src/main/tools/reminders/store'
import { formatRelativeRu, formatWhenRu, parseDueTime } from '../../src/main/tools/reminders/time'

let dir: string
let file: string

function makeScheduler(onFire: (r: Reminder, late: number) => void, extra: Partial<ConstructorParameters<typeof ReminderScheduler>[0]> = {}) {
  return new ReminderScheduler({ file, onFire, ...extra })
}

function stored(): Reminder[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { reminders: Reminder[] }).reminders
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 29, 10, 0, 0))
  dir = mkdtempSync(join(tmpdir(), 'jarvis-reminders-'))
  file = join(dir, 'reminders.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('ReminderScheduler', () => {
  it('fires at the due time, not before, and removes the reminder', () => {
    const fired: Array<[string, number]> = []
    const s = makeScheduler((r, late) => fired.push([r.text, late]))
    s.start()
    s.add({ text: 'чай', dueAt: Date.now() + 10_000, chatId: 'c1' })
    expect(stored()).toHaveLength(1)
    vi.advanceTimersByTime(9_000)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(fired).toEqual([['чай', 0]])
    expect(stored()).toEqual([])
    expect(s.list()).toEqual([])
    s.dispose()
  })

  it('handles long delays through periodic re-checks', () => {
    const onFire = vi.fn()
    const s = makeScheduler(onFire, { maxTimerMs: 30_000 })
    s.start()
    s.add({ text: 'встреча', dueAt: Date.now() + 2 * 3600_000 })
    vi.advanceTimersByTime(2 * 3600_000 - 1000)
    expect(onFire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(onFire).toHaveBeenCalledTimes(1)
    s.dispose()
  })

  it('fires reminders in order', () => {
    const order: string[] = []
    const s = makeScheduler((r) => order.push(r.text))
    s.start()
    s.add({ text: 'second', dueAt: Date.now() + 20_000 })
    s.add({ text: 'first', dueAt: Date.now() + 5_000 })
    vi.advanceTimersByTime(25_000)
    expect(order).toEqual(['first', 'second'])
    s.dispose()
  })

  it('persists across restarts', () => {
    const s1 = makeScheduler(vi.fn())
    s1.start()
    const a = s1.add({ text: 'A', dueAt: Date.now() + 60_000 })
    s1.add({ text: 'B', dueAt: Date.now() + 120_000 })
    s1.dispose()

    const onFire = vi.fn()
    const s2 = makeScheduler(onFire)
    s2.start()
    expect(s2.list().map((r) => r.text)).toEqual(['A', 'B'])
    expect(s2.list()[0].id).toBe(a.id)
    vi.advanceTimersByTime(60_000)
    expect(onFire).toHaveBeenCalledTimes(1)
    expect(onFire.mock.calls[0][0].text).toBe('A')
    s2.dispose()
  })

  it('delivers reminders missed while the app was closed, after the startup delay', () => {
    const due = Date.now() - 3600_000
    writeFileSync(file, JSON.stringify({ version: 1, reminders: [{ id: 'abc123', text: 'пропущено', dueAt: due, createdAt: due - 1000 }] }))
    const onFire = vi.fn()
    const s = makeScheduler(onFire, { startupDelayMs: 5000 })
    s.start()
    vi.advanceTimersByTime(4999)
    expect(onFire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onFire).toHaveBeenCalledTimes(1)
    expect(onFire.mock.calls[0][1]).toBeGreaterThanOrEqual(3600_000)
    s.dispose()
  })

  it('cancels reminders', () => {
    const onFire = vi.fn()
    const s = makeScheduler(onFire)
    s.start()
    const r = s.add({ text: 'x', dueAt: Date.now() + 1000 })
    expect(s.cancel('nope')).toBeNull()
    expect(s.cancel(r.id)?.text).toBe('x')
    vi.advanceTimersByTime(5000)
    expect(onFire).not.toHaveBeenCalled()
    expect(stored()).toEqual([])
    s.dispose()
  })

  it('survives corrupt files and drops invalid entries', () => {
    writeFileSync(file, '{ not json')
    const s1 = makeScheduler(vi.fn())
    expect(() => s1.start()).not.toThrow()
    expect(s1.list()).toEqual([])
    s1.dispose()
    writeFileSync(file, JSON.stringify({ version: 1, reminders: [{ id: 'ok1', text: 't', dueAt: Date.now() + 1, createdAt: 1 }, { id: 5 }, null] }))
    const s2 = makeScheduler(vi.fn())
    s2.start()
    expect(s2.list().map((r) => r.id)).toEqual(['ok1'])
    s2.dispose()
  })

  it('keeps firing other reminders when a callback throws', () => {
    const onError = vi.fn()
    const seen: string[] = []
    const s = makeScheduler(
      (r) => {
        seen.push(r.text)
        if (r.text === 'bad') throw new Error('boom')
      },
      { onError }
    )
    s.start()
    s.add({ text: 'bad', dueAt: Date.now() + 1000 })
    s.add({ text: 'good', dueAt: Date.now() + 1000 })
    vi.advanceTimersByTime(1000)
    expect(seen.sort()).toEqual(['bad', 'good'])
    expect(onError).toHaveBeenCalled()
    s.dispose()
  })
})

describe('due time parsing', () => {
  const now = () => Date.now()

  it('accepts relative seconds', () => {
    expect(parseDueTime(600, undefined, now())).toBe(now() + 600_000)
    expect(() => parseDueTime(-5, undefined, now())).toThrow(/positive/)
  })

  it('accepts HH:MM for today or tomorrow', () => {
    expect(new Date(parseDueTime(undefined, '18:30', now())).toString()).toBe(new Date(2026, 9, 29, 18, 30).toString())
    expect(new Date(parseDueTime(undefined, '09:00', now())).toString()).toBe(new Date(2026, 9, 30, 9, 0).toString())
  })

  it('reads ISO times without an offset as local time and date-only as 09:00', () => {
    expect(parseDueTime(undefined, '2026-10-29T12:15', now())).toBe(new Date(2026, 9, 29, 12, 15).getTime())
    expect(parseDueTime(undefined, '2026-10-29 12:15', now())).toBe(new Date(2026, 9, 29, 12, 15).getTime())
    expect(parseDueTime(undefined, '2026-11-02', now())).toBe(new Date(2026, 10, 2, 9, 0).getTime())
    expect(parseDueTime(undefined, '2026-10-29T12:00:00Z', now())).toBe(Date.UTC(2026, 9, 29, 12, 0, 0))
  })

  it('prefers "at" over in_seconds and validates the range', () => {
    expect(parseDueTime(60, '18:30', now())).toBe(new Date(2026, 9, 29, 18, 30).getTime())
    expect(() => parseDueTime(undefined, '2026-10-28T10:00', now())).toThrow(/past/)
    expect(() => parseDueTime(undefined, '2030-01-01T10:00', now())).toThrow(/two years/)
    expect(() => parseDueTime(undefined, 'завтра', now())).toThrow(/Cannot parse/)
    expect(() => parseDueTime(undefined, undefined, now())).toThrow(/either/)
    expect(parseDueTime(undefined, new Date(now() - 10_000).toISOString(), now())).toBe(now() + 1000)
  })

  it('formats Russian summaries', () => {
    expect(formatWhenRu(new Date(2026, 9, 29, 18, 30).getTime(), now())).toBe('в 18:30')
    expect(formatWhenRu(new Date(2026, 9, 30, 9, 5).getTime(), now())).toBe('завтра в 09:05')
    expect(formatWhenRu(new Date(2026, 10, 5, 9, 0).getTime(), now())).toBe('5 ноября в 09:00')
    expect(formatRelativeRu(now() + 10 * 60_000, now())).toBe('через 10 мин')
    expect(formatRelativeRu(now() + 125 * 60_000, now())).toBe('через 2 ч 5 мин')
  })
})
