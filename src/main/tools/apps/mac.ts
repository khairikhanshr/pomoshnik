// macOS apps: .app bundles from the standard folders (+ Spotlight display names), running apps
// via NSWorkspace (JXA, no Apple Events), launch with `open -a`, quit via AppleScript argv.
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { shell } from 'electron'
import { sleep, ToolError } from '../errors'
import { cleanDisplayName } from '../fuzzy'
import { run, runChecked } from '../exec'
import { runOsa } from '../mac/osa'
import { AS_QUIT_APP, JXA_ACTIVATE, JXA_DEFAULT_BROWSER, JXA_RUNNING_APPS } from '../mac/scripts'
import type { AppBackend, CloseOutcome, InstalledApp } from './types'

const CACHE_MS = 5 * 60_000

export function macAppDirs(home: string): string[] {
  return [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    join(home, 'Applications'),
    '/System/Library/CoreServices/Applications'
  ]
}

const EXTRA_APPS = ['/System/Library/CoreServices/Finder.app']

async function scanDir(dir: string, depth: number, out: Set<string>): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.name.endsWith('.app')) out.add(full)
    else if (depth > 0 && entry.isDirectory()) await scanDir(full, depth - 1, out)
  }
}

export function appFileName(path: string): string {
  return basename(path).replace(/\.app$/i, '')
}

/** Localized display names in one mdls call; values are NUL-separated in argument order. */
async function displayNames(paths: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (paths.length === 0) return names
  try {
    const result = await run('/usr/bin/mdls', ['-name', 'kMDItemDisplayName', '-raw', '-nullMarker', '', ...paths], {
      timeoutMs: 8000
    })
    const values = result.stdout.split('\0')
    if (values.length !== paths.length) return names
    values.forEach((value, i) => {
      const name = cleanDisplayName(value).replace(/\.app$/i, '')
      if (name) names.set(paths[i], name)
    })
  } catch {
    // Spotlight unavailable: file names are enough
  }
  return names
}

export async function scanMacApps(home: string): Promise<InstalledApp[]> {
  const found = new Set<string>()
  for (const dir of macAppDirs(home)) await scanDir(dir, 1, found)
  for (const extra of EXTRA_APPS) found.add(extra)
  const paths = [...found]
  const display = await displayNames(paths)
  return paths
    .map((path) => {
      const file = appFileName(path)
      const shown = display.get(path) ?? file
      return { name: shown, names: [...new Set([shown, file])], id: path, kind: 'bundle' as const }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function createMacBackend(home: string): AppBackend {
  let cache: { at: number; apps: Promise<InstalledApp[]> } | null = null

  async function open(target: string, signal?: AbortSignal): Promise<void> {
    await runChecked('/usr/bin/open', ['-a', target], 'open', { timeoutMs: 15_000, signal })
  }

  return {
    installed(force = false) {
      if (!cache || force || Date.now() - cache.at > CACHE_MS) {
        const apps = scanMacApps(home)
        cache = { at: Date.now(), apps }
        apps.catch(() => {
          cache = null
        })
      }
      return cache.apps
    },

    async running(signal) {
      const json = await runOsa(JXA_RUNNING_APPS, [], 'Listing running apps', { signal })
      const raw = JSON.parse(json || '[]') as Array<{ name: string; bundleId: string; pid: number | string; path: string; active: boolean }>
      const list = raw.map((a) => ({ ...a, pid: Number(a.pid) })).filter((a) => Number.isInteger(a.pid) && a.pid > 0)
      return list.filter((a) => a.pid !== process.pid).map((a) => ({
        name: cleanDisplayName(a.name) || appFileName(a.path),
        names: [...new Set([cleanDisplayName(a.name), a.path ? appFileName(a.path) : ''].filter(Boolean))],
        pid: a.pid,
        path: a.path || undefined,
        bundleId: a.bundleId || undefined,
        active: a.active
      }))
    },

    async launch(app) {
      await open(app.id)
    },

    async launchByName(name, signal) {
      if (name.startsWith('-')) return false
      const result = await run('/usr/bin/open', ['-a', name], { timeoutMs: 15_000, signal })
      return result.code === 0
    },

    async launchFallback() {
      throw new ToolError('No built-in fallback on macOS')
    },

    async close(apps, force, signal): Promise<CloseOutcome> {
      const closed: string[] = []
      const stillRunning: string[] = []
      for (const app of apps) {
        if (force) {
          try {
            process.kill(app.pid, 'SIGKILL')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw new ToolError(`Cannot stop ${app.name}: ${(err as Error).message}`)
          }
          for (let i = 0; i < 8 && isAlive(app.pid); i++) await sleep(250, signal)
          if (isAlive(app.pid)) stillRunning.push(app.name)
          else closed.push(app.name)
          continue
        }
        const args = app.bundleId ? ['id', app.bundleId] : ['name', app.name]
        const state = await runOsa(AS_QUIT_APP, args, `Quitting ${app.name}`, { signal, timeoutMs: 20_000 })
        if (state === 'still-running') stillRunning.push(app.name)
        else closed.push(app.name)
      }
      return { closed, stillRunning }
    },

    async focus(app, signal) {
      if (app.path) {
        await open(app.path, signal)
        return true
      }
      return (await runOsa(JXA_ACTIVATE, [String(app.pid)], 'Activating the app', { signal })) === 'ok'
    },

    async openDefaultBrowser(signal) {
      const path = await runOsa(JXA_DEFAULT_BROWSER, [], 'Finding the default browser', { signal }).catch(() => '')
      if (path) {
        await open(path, signal)
        return appFileName(path)
      }
      await shell.openExternal('https://www.google.com')
      return 'the default browser'
    }
  }
}
