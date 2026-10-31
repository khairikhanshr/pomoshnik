// Windows apps: Get-StartApps (localized names + AppUserModelIDs) launched through
// shell:AppsFolder, running windows via Get-Process, CloseMainWindow / Stop-Process.
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { shell } from 'electron'
import { ToolError } from '../errors'
import { cleanDisplayName } from '../fuzzy'
import { launchDetached } from '../exec'
import { runPowerShell } from '../win/ps'
import { PS_CLOSE, PS_DEFAULT_BROWSER, PS_FOCUS, PS_LIST_WINDOWS, PS_START_APPS, PS_START_PROCESS } from '../win/scripts'
import type { AppBackend, CloseOutcome, InstalledApp, RunningApp } from './types'

const CACHE_MS = 5 * 60_000

interface StartApp {
  name: string
  id: string
  kind: 'appx' | 'shortcut'
}

interface WinWindow {
  id: number
  name: string
  title: string
  description: string | null
  path: string | null
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Start menu also lists uninstallers; a fuzzy match must never launch one. */
const UNINSTALLER = /(^|\s)(uninstall|uninstaller|deinstall|удалить|удаление|деинсталл)/i

export function toInstalled(list: StartApp[]): InstalledApp[] {
  const seen = new Set<string>()
  const apps: InstalledApp[] = []
  for (const item of list) {
    const name = cleanDisplayName(item?.name ?? '')
    if (!name || !item.id || UNINSTALLER.test(name)) continue
    const key = `${name}\u0000${item.id}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    apps.push({ name, names: [name], id: item.id, kind: item.kind === 'shortcut' ? 'shortcut' : 'appx' })
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name))
}

export function toRunning(list: WinWindow[], ownPid: number): RunningApp[] {
  return list
    .filter((w) => w && w.id !== ownPid)
    .map((w) => {
      const display = cleanDisplayName(w.description ?? '') || cleanDisplayName(w.title ?? '') || w.name
      return {
        name: display,
        names: [...new Set([display, w.name, w.title].filter((n): n is string => Boolean(n && n.trim())))],
        pid: w.id,
        path: w.path || undefined,
        title: w.title || undefined
      }
    })
}

function expandEnv(text: string): string {
  return text.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m)
}

export function createWinBackend(): AppBackend {
  let cache: { at: number; apps: Promise<InstalledApp[]> } | null = null

  async function startProcess(target: string, signal?: AbortSignal): Promise<void> {
    await runPowerShell(PS_START_PROCESS, `Starting ${target}`, { args: { target }, signal, timeoutMs: 20_000 })
  }

  return {
    installed(force = false) {
      if (!cache || force || Date.now() - cache.at > CACHE_MS) {
        const apps = runPowerShell<StartApp[] | StartApp | null>(PS_START_APPS, 'Listing installed apps', { timeoutMs: 40_000 }).then(
          (raw) => toInstalled(asArray(raw))
        )
        cache = { at: Date.now(), apps }
        apps.catch(() => {
          cache = null
        })
      }
      return cache.apps
    },

    async running(signal) {
      const raw = await runPowerShell<WinWindow[] | WinWindow | null>(PS_LIST_WINDOWS, 'Listing running apps', { signal })
      return toRunning(asArray(raw), process.pid)
    },

    async launch(app) {
      if (app.kind === 'shortcut') {
        const error = await shell.openPath(app.id)
        if (error) throw new ToolError(`Cannot open ${app.name}: ${error}`)
        return
      }
      await launchDetached('explorer.exe', [`shell:AppsFolder\\${app.id}`])
    },

    async launchByName(name, signal) {
      try {
        await startProcess(name, signal)
        return true
      } catch (err) {
        if (signal?.aborted) throw err
        return false
      }
    },

    async launchFallback(target, signal) {
      if (/^[a-z][a-z0-9.-]*:/i.test(target)) {
        await shell.openExternal(target)
        return
      }
      await startProcess(target, signal)
    },

    async close(apps, force, signal): Promise<CloseOutcome> {
      const result = await runPowerShell<{ requested: number; alive: number[] | number | null }>(PS_CLOSE, 'Closing the app', {
        args: { ids: apps.map((a) => a.pid), force },
        signal,
        timeoutMs: 20_000
      })
      const alive = new Set(asArray(result?.alive))
      return {
        closed: apps.filter((a) => !alive.has(a.pid)).map((a) => a.name),
        stillRunning: apps.filter((a) => alive.has(a.pid)).map((a) => a.name)
      }
    },

    async focus(app, signal) {
      const result = await runPowerShell<{ ok: boolean }>(PS_FOCUS, 'Switching to the app', { args: { id: app.pid }, signal })
      return result?.ok === true
    },

    async openDefaultBrowser(signal) {
      const info = await runPowerShell<{ exe: string | null }>(PS_DEFAULT_BROWSER, 'Finding the default browser', { signal }).catch(
        () => null
      )
      const exe = info?.exe ? expandEnv(info.exe) : ''
      if (exe && existsSync(exe)) {
        await launchDetached(exe, [])
        return win32.basename(exe).replace(/\.exe$/i, '')
      }
      await shell.openExternal('https://www.google.com')
      return 'the default browser'
    }
  }
}
