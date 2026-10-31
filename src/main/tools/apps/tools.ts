import { shell } from 'electron'
import type { ToolResult } from '../types'
import { appQueryVariants, findAppAlias } from '../app-aliases'
import { clip, optBoolean, optString, reqString } from '../args'
import { denied, fail, ok, type ToolDef, type ToolEnv } from '../define'
import { decideMatch, rankCandidates, type Ranked } from '../fuzzy'
import type { AppBackend, InstalledApp, RunningApp } from './types'

const MAX_LISTED = 400

function unique(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))]
}

export function suggestionNames<T extends { name: string }>(ranked: Ranked<T>[], limit = 5): string[] {
  return unique(ranked.filter((r) => r.score > 25).map((r) => r.item.name)).slice(0, limit)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function rankInstalled(name: string, apps: InstalledApp[], platform: NodeJS.Platform): Ranked<InstalledApp>[] {
  return rankCandidates(appQueryVariants(name, platform), apps.map((a) => ({ item: a, names: a.names })))
}

function rankRunning(name: string, apps: RunningApp[], platform: NodeJS.Platform): Ranked<RunningApp>[] {
  return rankCandidates(appQueryVariants(name, platform), apps.map((a) => ({ item: a, names: a.names })))
}

export function appTools(env: ToolEnv, backend: AppBackend): ToolDef[] {
  const platform = env.platform

  async function openApp(name: string, signal: AbortSignal): Promise<ToolResult> {
    const alias = findAppAlias(name)
    if (alias?.browser) {
      const browser = await backend.openDefaultBrowser(signal)
      return ok(`Opened ${browser}.`, `Открыт браузер: ${browser}`)
    }
    const targets = platform === 'darwin' ? alias?.mac : alias?.win
    if (alias?.url && !targets) {
      await shell.openExternal(alias.url)
      return ok(`"${name}" is a website: opened ${alias.url} in the default browser.`, `Открыто: ${hostOf(alias.url)}`)
    }
    // A failed scan must not block the fallbacks below (Start-Process / open -a / known URIs).
    const installed = await backend.installed().catch((err: unknown) => {
      env.log.warn('app catalog unavailable', err)
      return [] as InstalledApp[]
    })
    const ranked = rankInstalled(name, installed, platform)
    const outcome = decideMatch(ranked)
    if (outcome.kind === 'match') {
      const app = outcome.best.item
      await backend.launch(app)
      return ok(`Opened ${app.name}.`, `Открыто: ${app.name}`)
    }
    if (alias?.url) {
      await shell.openExternal(alias.url)
      return ok(`No ${name} app is installed: opened ${alias.url} in the browser instead.`, `Открыто: ${hostOf(alias.url)}`)
    }
    if (platform === 'win32' && alias?.winFallback) {
      await backend.launchFallback(alias.winFallback, signal)
      return ok(`Opened ${name} (${alias.winFallback}).`, `Открыто: ${clip(name, 40)}`)
    }
    const suggestions = suggestionNames(ranked)
    if (outcome.kind === 'ambiguous') {
      return fail(
        `Several apps match "${name}": ${suggestions.join(', ')}. Ask the user which one, or call open_application with the exact name.`,
        `Уточните приложение: ${clip(suggestions.join(', '), 60)}`
      )
    }
    if (await backend.launchByName(name, signal)) return ok(`Opened ${name}.`, `Открыто: ${clip(name, 40)}`)
    return fail(
      `No installed app matches "${name}".${suggestions.length ? ` Closest names: ${suggestions.join(', ')}.` : ''}`,
      `Не найдено: ${clip(name, 40)}`
    )
  }

  const openApplication: ToolDef = {
    spec: {
      name: 'open_application',
      description:
        'Open (launch) an application installed on this computer. Pass the name as the user said it, in any language: ' +
        'localized and Russian names are matched (e.g. "калькулятор" -> Calculator, "телеграм" -> Telegram, ' +
        '"браузер" -> the default browser); sites such as YouTube open in the browser. If several apps match, the result ' +
        'lists them: ask the user which one.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'App name, e.g. "Telegram", "калькулятор", "Microsoft Word".' } },
        required: ['name'],
        additionalProperties: false
      }
    },
    title: (args) => `Открываю «${clip(String(args.name ?? ''), 40)}»`,
    run: async (args, ctx) => openApp(reqString(args, 'name', { max: 200 }), ctx.signal)
  }

  const listApplications: ToolDef = {
    spec: {
      name: 'list_applications',
      description: 'List applications installed on this computer (names), optionally filtered by a fuzzy query.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Optional filter, e.g. "office" or "браузер".' } },
        additionalProperties: false
      }
    },
    title: (args) => (args.query ? `Ищу приложение «${clip(String(args.query), 40)}»` : 'Смотрю установленные приложения'),
    run: async (args) => {
      const query = optString(args, 'query', { max: 200 })
      const apps = await backend.installed()
      if (!query) {
        const names = unique(apps.map((a) => a.name))
        const shown = names.slice(0, MAX_LISTED)
        const more = names.length > shown.length ? ` … and ${names.length - shown.length} more` : ''
        return ok(`${names.length} installed apps: ${shown.join(', ')}${more}.`, `Приложений: ${names.length}`)
      }
      const names = unique(rankInstalled(query, apps, platform).filter((r) => r.score >= 50).map((r) => r.item.name)).slice(0, 50)
      if (names.length === 0) return ok(`No installed apps match "${query}".`, 'Ничего не найдено')
      return ok(`Installed apps matching "${query}": ${names.join(', ')}.`, `Найдено: ${names.length}`)
    }
  }

  const closeApplication: ToolDef = {
    spec: {
      name: 'close_application',
      description:
        'Quit a running application gracefully. force=true kills it immediately (unsaved work is lost; the user is asked to confirm).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'App name as the user said it.' },
          force: { type: 'boolean', description: 'Kill immediately instead of asking the app to quit.' }
        },
        required: ['name'],
        additionalProperties: false
      }
    },
    title: (args) =>
      args.force === true || args.force === 'true'
        ? `Принудительно закрываю «${clip(String(args.name ?? ''), 40)}»`
        : `Закрываю «${clip(String(args.name ?? ''), 40)}»`,
    run: async (args, ctx) => {
      const name = reqString(args, 'name', { max: 200 })
      const force = optBoolean(args, 'force') ?? false
      const running = await backend.running(ctx.signal)
      const outcome = decideMatch(rankRunning(name, running, platform))
      if (outcome.kind === 'none') return ok(`"${name}" is not running.`, `«${clip(name, 40)}» не запущено`)
      if (outcome.kind === 'ambiguous') {
        const options = suggestionNames(outcome.ranked)
        return fail(`Several running apps match "${name}": ${options.join(', ')}. Ask the user which one.`, `Уточните: ${clip(options.join(', '), 60)}`)
      }
      const app = outcome.best.item
      const targets = outcome.ranked.filter((r) => r.score === outcome.best.score && r.item.name === app.name).map((r) => r.item)
      if (force) {
        const allowed = await env.confirm(ctx, {
          message: `Принудительно закрыть «${app.name}»?`,
          detail: 'Несохранённые изменения в этом приложении будут потеряны.'
        })
        if (!allowed) return denied(`force quit ${app.name}`)
      }
      const result = await backend.close(targets, force, ctx.signal)
      if (result.closed.length === 0 && result.stillRunning.length > 0) {
        return ok(
          `Asked ${app.name} to quit, but it is still running (it may be showing an unsaved-changes dialog or keep running in the tray). ` +
            'Tell the user; use force: true only if they want it killed.',
          `«${app.name}» ещё работает`
        )
      }
      return ok(`${force ? 'Killed' : 'Closed'} ${app.name}.`, `Закрыто: ${app.name}`)
    }
  }

  const listRunning: ToolDef = {
    spec: {
      name: 'list_running_applications',
      description: 'List applications that are currently running with a window (the active one is marked on macOS).',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    title: () => 'Смотрю запущенные приложения',
    run: async (_args, ctx) => {
      const running = await backend.running(ctx.signal)
      const names = unique(running.map((a) => (a.active ? `${a.name} (active)` : a.name)))
      return ok(`Running apps (${names.length}): ${names.join(', ') || 'none'}.`, `Запущено приложений: ${names.length}`)
    }
  }

  const focusApplication: ToolDef = {
    spec: {
      name: 'focus_application',
      description: 'Bring a running application to the front. If it is not running, it is opened.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'App name as the user said it.' } },
        required: ['name'],
        additionalProperties: false
      }
    },
    title: (args) => `Переключаюсь на «${clip(String(args.name ?? ''), 40)}»`,
    run: async (args, ctx) => {
      const name = reqString(args, 'name', { max: 200 })
      const outcome = decideMatch(rankRunning(name, await backend.running(ctx.signal), platform))
      if (outcome.kind === 'ambiguous') {
        const options = suggestionNames(outcome.ranked)
        return fail(`Several running apps match "${name}": ${options.join(', ')}. Ask the user which one.`, `Уточните: ${clip(options.join(', '), 60)}`)
      }
      if (outcome.kind === 'none') {
        const opened = await openApp(name, ctx.signal)
        return opened.ok ? { ...opened, output: `${name} was not running, so it was opened. ${opened.output}` } : opened
      }
      const app = outcome.best.item
      if (await backend.focus(app, ctx.signal)) return ok(`${app.name} is now in front.`, `Переключено: ${app.name}`)
      return fail(`The system did not allow bringing ${app.name} to the front.`, `Не удалось переключиться на ${app.name}`)
    }
  }

  return [openApplication, listApplications, closeApplication, listRunning, focusApplication]
}
