import { join } from 'node:path'
import { Notification } from 'electron'
import { clip, optNumber, optString, reqString } from '../args'
import { fail, ok, type ToolDef, type ToolEnv } from '../define'
import { decideMatch, rankCandidates } from '../fuzzy'
import { ReminderScheduler, type Reminder } from './store'
import { formatLocal, formatWhenRu, parseDueTime } from './time'

const ALL_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32', 'linux']
const MAX_LIVE_NOTIFICATIONS = 20

export interface ReminderService {
  tools: ToolDef[]
  start(): void
  dispose(): void
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

function inMinutes(due: number, now: number): string {
  const minutes = Math.round((due - now) / 60_000)
  if (minutes < 1) return 'in less than a minute'
  if (minutes < 120) return `in ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `in about ${hours} h` : `in about ${Math.round(hours / 24)} days`
}

export function createReminderService(env: ToolEnv): ReminderService {
  const { host, log } = env
  // Notifications are kept referenced so click handlers survive garbage collection.
  const live = new Set<Notification>()

  function notify(reminder: Reminder, late: string): void {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: 'Джарвис — напоминание', body: `${reminder.text}${late}` })
    live.add(n)
    if (live.size > MAX_LIVE_NOTIFICATIONS) live.delete(live.values().next().value as Notification)
    const release = (): void => {
      live.delete(n)
    }
    n.on('click', () => {
      release()
      host.windows.showMain(reminder.chatId ? { chatId: reminder.chatId } : undefined)
    })
    n.on('close', release)
    n.on('failed', release)
    n.show()
  }

  function deliver(reminder: Reminder, lateMs: number): void {
    const settings = host.settings.get()
    const late = lateMs > 60_000 ? ` (пропущено, было назначено ${formatWhenRu(reminder.dueAt, Date.now())})` : ''
    log.info(`reminder ${reminder.id} fired${late ? ' late' : ''}`)
    notify(reminder, late)
    if (settings.speakMode !== 'never') {
      const title = capitalize(settings.userTitle.trim() || 'сэр')
      host.bus.emit('speak', { turnId: `reminder-${reminder.id}`, seq: 0, text: `${title}, напоминаю: ${reminder.text}`, final: true })
    }
    if (settings.showOverlay) {
      host.windows.showOverlay()
      if (host.bus.getState().phase === 'idle') {
        host.bus.patchState({ response: `Напоминание: ${reminder.text}`, transcript: undefined, toolTitle: undefined, error: undefined })
      }
    }
  }

  const scheduler = new ReminderScheduler({
    file: join(host.userDataDir, 'reminders.json'),
    onFire: deliver,
    startupDelayMs: 5000,
    onError: (err) => log.warn('reminders:', err)
  })

  const setReminder: ToolDef = {
    spec: {
      name: 'set_reminder',
      description:
        'Set a reminder: at the given time Jarvis shows a notification and says the text aloud (survives restarts). ' +
        'Use in_seconds for relative times ("in 10 minutes" = 600) or at for an absolute local time ' +
        '(ISO 8601 such as 2026-05-01T18:30, or "18:30" for the next occurrence).',
      parameters: {
        type: 'object',
        properties: {
          in_seconds: { type: 'number', description: 'Seconds from now.' },
          at: { type: 'string', description: 'Local date-time (ISO 8601) or HH:MM.' },
          text: { type: 'string', description: "What to remind about, in the user's language." }
        },
        required: ['text'],
        additionalProperties: false
      }
    },
    harmless: true,
    platforms: ALL_PLATFORMS,
    title: () => 'Ставлю напоминание',
    run: async (args, ctx) => {
      const text = reqString(args, 'text', { max: 500 })
      const now = Date.now()
      const due = parseDueTime(optNumber(args, 'in_seconds', { min: 1 }), optString(args, 'at', { max: 100 }), now)
      const reminder = scheduler.add({ text, dueAt: due, chatId: ctx.chatId })
      return ok(
        `Reminder ${reminder.id} set for ${formatLocal(due)} (${inMinutes(due, now)}): "${text}".`,
        `Напомню ${formatWhenRu(due, now)}: ${clip(text, 40)}`
      )
    }
  }

  const listReminders: ToolDef = {
    spec: {
      name: 'list_reminders',
      description: 'List pending reminders with their ids and times.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    harmless: true,
    platforms: ALL_PLATFORMS,
    title: () => 'Смотрю напоминания',
    run: async () => {
      const list = scheduler.list()
      if (list.length === 0) return ok('No pending reminders.', 'Напоминаний нет')
      const lines = list.map((r) => `${r.id} — ${formatLocal(r.dueAt)} — ${r.text}`)
      return ok(`Pending reminders (${list.length}):\n${lines.join('\n')}`, `Напоминаний: ${list.length}`)
    }
  }

  const cancelReminder: ToolDef = {
    spec: {
      name: 'cancel_reminder',
      description: 'Cancel a pending reminder by id (from set_reminder / list_reminders).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Reminder id.' } },
        required: ['id'],
        additionalProperties: false
      }
    },
    harmless: true,
    platforms: ALL_PLATFORMS,
    title: () => 'Отменяю напоминание',
    run: async (args) => {
      const id = reqString(args, 'id', { max: 500 })
      let removed = scheduler.cancel(id)
      if (!removed) {
        // Models sometimes pass the reminder text instead of its id.
        const outcome = decideMatch(rankCandidates([id], scheduler.list().map((r) => ({ item: r, names: [r.text] }))))
        if (outcome.kind === 'match') removed = scheduler.cancel(outcome.best.item.id)
        else if (outcome.kind === 'ambiguous') {
          const ids = outcome.ranked.slice(0, 5).map((r) => `${r.item.id} ("${clip(r.item.text, 40)}")`)
          return fail(`Several reminders match "${id}": ${ids.join(', ')}. Pass the exact id.`, 'Уточните напоминание')
        }
      }
      if (!removed) return fail(`No pending reminder with id "${id}". Call list_reminders to see the ids.`, 'Напоминание не найдено')
      return ok(`Cancelled reminder ${removed.id} ("${removed.text}", was due ${formatLocal(removed.dueAt)}).`, `Отменено: ${clip(removed.text, 40)}`)
    }
  }

  return {
    tools: [setReminder, listReminders, cancelReminder],
    start: () => scheduler.start(),
    dispose: () => scheduler.dispose()
  }
}
