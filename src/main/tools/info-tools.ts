import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { app, screen } from 'electron'
import { ok, type ToolDef, type ToolEnv } from './define'
import { run } from './exec'
import { formatSize } from './file-tools'
import { runPowerShell } from './win/ps'
import { PS_SYSTEM_INFO } from './win/scripts'

export interface BatteryInfo {
  percent: number
  state: string
  remaining?: string
  source?: string
}

/** `pmset -g batt`: " -InternalBattery-0 (id=…)	76%; discharging; 7:02 remaining present: true". */
export function parsePmsetBattery(text: string): BatteryInfo | null {
  const line = text.split('\n').find((l) => /InternalBattery/i.test(l))
  if (!line) return null
  const percent = /(\d{1,3})%/.exec(line)
  if (!percent) return null
  const state = /%;\s*([^;]+);/.exec(line)?.[1]?.trim() ?? 'unknown'
  const remaining = /(\d+:\d{2}) remaining/.exec(line)?.[1]
  const source = /drawing from '([^']+)'/.exec(text)?.[1]
  return {
    percent: Number(percent[1]),
    state,
    remaining: remaining && remaining !== '0:00' ? remaining : undefined,
    source
  }
}

const WIN_BATTERY_STATUS: Record<number, string> = {
  1: 'discharging',
  2: 'on AC power',
  3: 'fully charged',
  4: 'low',
  5: 'critical',
  6: 'charging',
  7: 'charging',
  8: 'charging',
  9: 'charging',
  11: 'partially charged'
}

/** Win32_Battery: EstimatedRunTime 71582788 means "unknown / on AC". */
export function winBattery(raw: { percent: number; status: number; minutes: number } | null): BatteryInfo | null {
  if (!raw || !Number.isFinite(raw.percent)) return null
  const minutes = Number(raw.minutes)
  const remaining =
    Number.isFinite(minutes) && minutes > 0 && minutes < 71582788 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : undefined
  return { percent: raw.percent, state: WIN_BATTERY_STATUS[raw.status] ?? 'unknown', remaining }
}

/** macOS keeps "free" pages near zero (file cache); free + inactive + speculative + purgeable is what apps can get. */
export function parseVmStatAvailable(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null
  const pages = (label: string): number => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0)
  const available = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')
  return available > 0 ? available * pageSize : null
}

async function availableMemory(platform: NodeJS.Platform): Promise<{ bytes: number; label: string }> {
  if (platform === 'darwin') {
    const text = await run('/usr/bin/vm_stat', [], { timeoutMs: 5000 })
      .then((r) => r.stdout)
      .catch(() => '')
    const bytes = parseVmStatAvailable(text)
    if (bytes !== null) return { bytes, label: 'available' }
  }
  return { bytes: os.freemem(), label: 'free' }
}

export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days} d ${hours} h`
  if (hours > 0) return `${hours} h ${minutes % 60} min`
  return `${minutes} min`
}

function offsetString(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const abs = Math.abs(offset)
  return `${offset >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** "2026-10-29T19:45:12+05:00" */
export function isoLocal(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:` +
    `${p(date.getSeconds())}${offsetString(date)}`
  )
}

async function osDescription(platform: NodeJS.Platform): Promise<{ os: string; battery: BatteryInfo | null }> {
  if (platform === 'darwin') {
    const [version, build, batt] = await Promise.all([
      run('/usr/bin/sw_vers', ['-productVersion'], { timeoutMs: 5000 }).then((r) => r.stdout.trim()).catch(() => ''),
      run('/usr/bin/sw_vers', ['-buildVersion'], { timeoutMs: 5000 }).then((r) => r.stdout.trim()).catch(() => ''),
      run('/usr/bin/pmset', ['-g', 'batt'], { timeoutMs: 5000 }).then((r) => r.stdout).catch(() => '')
    ])
    const name = version ? `macOS ${version}${build ? ` (build ${build})` : ''}` : `macOS (Darwin ${os.release()})`
    return { os: name, battery: parsePmsetBattery(batt) }
  }
  if (platform === 'win32') {
    const info = await runPowerShell<{ caption: string; version: string; build: string; battery: { percent: number; status: number; minutes: number } | null }>(
      PS_SYSTEM_INFO,
      'System info',
      { timeoutMs: 20_000 }
    ).catch(() => null)
    const name = info?.caption ? `${info.caption.trim()} (${info.version || os.release()})` : `Windows ${os.release()}`
    return { os: name, battery: winBattery(info?.battery ?? null) }
  }
  return { os: `${os.type()} ${os.release()}`, battery: null }
}

export function infoTools(env: ToolEnv): ToolDef[] {
  const systemInfo: ToolDef = {
    spec: {
      name: 'get_system_info',
      description: 'Facts about this computer: OS and version, CPU, memory, free disk space, battery, uptime, displays, Jarvis version.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    harmless: true,
    platforms: ['darwin', 'win32', 'linux'],
    title: () => 'Смотрю сведения о системе',
    run: async () => {
      const [{ os: osName, battery }, memory] = await Promise.all([osDescription(env.platform), availableMemory(env.platform)])
      const cpus = os.cpus()
      const lines = [
        `OS: ${osName}, ${os.arch()}`,
        `Computer: ${os.hostname()}, user ${os.userInfo().username}`,
        `CPU: ${cpus[0]?.model?.trim() ?? 'unknown'}, ${cpus.length} cores`,
        `Memory: ${formatSize(os.totalmem())} total, ${formatSize(memory.bytes)} ${memory.label}`
      ]
      try {
        const fsInfo = await statfs(os.homedir())
        lines.push(`Disk (home volume): ${formatSize(fsInfo.bavail * fsInfo.bsize)} free of ${formatSize(fsInfo.blocks * fsInfo.bsize)}`)
      } catch {
        // statfs unsupported: skip the disk line
      }
      if (battery) {
        lines.push(`Battery: ${battery.percent}%, ${battery.state}${battery.remaining ? `, ${battery.remaining} remaining` : ''}`)
      } else lines.push('Battery: none (desktop or unknown)')
      lines.push(`Uptime: ${formatUptime(os.uptime())}`)
      try {
        const displays = screen.getAllDisplays()
        const primary = screen.getPrimaryDisplay().id
        const shown = displays.map((d) => `${d.bounds.width}×${d.bounds.height} pt @${d.scaleFactor}x${d.id === primary ? ' primary' : ''}`)
        lines.push(`Displays: ${displays.length} (${shown.join('; ')})`)
      } catch {
        // screen is unavailable before app ready
      }
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      lines.push(
        `Jarvis ${app.getVersion()} (Electron ${process.versions.electron ?? '?'}, Chrome ${process.versions.chrome ?? '?'}, Node ${process.versions.node}), ` +
          `locale ${app.getLocale()}, time zone ${zone}`
      )
      const summary = [osName.split(' (')[0], `ОЗУ ${formatSize(os.totalmem()).replace('GB', 'ГБ')}`, battery ? `батарея ${battery.percent}%` : '']
        .filter(Boolean)
        .join(' · ')
      return ok(lines.join('\n'), summary)
    }
  }

  const dateTime: ToolDef = {
    spec: {
      name: 'get_datetime',
      description: 'Current local date, time, weekday and time zone.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    harmless: true,
    platforms: ['darwin', 'win32', 'linux'],
    title: () => 'Смотрю дату и время',
    run: async () => {
      const now = new Date()
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(now)
      const ru = new Intl.DateTimeFormat('ru-RU', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(now)
      return ok(`Local time: ${isoLocal(now)} (${weekday}), time zone ${zone} (UTC${offsetString(now)}).`, ru)
    }
  }

  return [systemInfo, dateTime]
}
