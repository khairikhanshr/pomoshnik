import { systemPreferences } from 'electron'
import { reqEnum } from './args'
import { denied, ok, type ToolDef, type ToolEnv } from './define'
import { launchDetached, runChecked } from './exec'
import { toMacKey } from './keys'
import { runOsa } from './mac/osa'
import { AS_POWER, JXA_KEYS } from './mac/scripts'
import { launchPowerShell, runPowerShell } from './win/ps'
import { PS_DISPLAY_OFF, PS_SLEEP } from './win/scripts'

export type PowerAction = 'lock' | 'sleep' | 'display_off' | 'restart' | 'shutdown' | 'logout'
const POWER_ACTIONS: readonly PowerAction[] = ['lock', 'sleep', 'display_off', 'restart', 'shutdown', 'logout']

const TEXT: Record<PowerAction, { title: string; summary: string; confirm?: string; output: string }> = {
  lock: { title: 'Блокирую компьютер', summary: 'Экран заблокирован', output: 'Locked the screen.' },
  sleep: { title: 'Перевожу компьютер в сон', summary: 'Спящий режим', output: 'Putting the computer to sleep.' },
  display_off: { title: 'Выключаю экран', summary: 'Экран выключен', output: 'Turned the display off.' },
  restart: { title: 'Перезагружаю компьютер', summary: 'Перезагрузка', confirm: 'Перезагрузить компьютер?', output: 'Restarting the computer.' },
  shutdown: { title: 'Выключаю компьютер', summary: 'Выключение', confirm: 'Выключить компьютер?', output: 'Shutting the computer down.' },
  logout: { title: 'Выхожу из системы', summary: 'Выход из системы', confirm: 'Выйти из учётной записи?', output: 'Logging out.' }
}

/** Windows commands for actions that need no script. */
export const WIN_POWER_COMMANDS: Partial<Record<PowerAction, [string, string[]]>> = {
  lock: ['rundll32.exe', ['user32.dll,LockWorkStation']],
  restart: ['shutdown.exe', ['/r', '/t', '0']],
  shutdown: ['shutdown.exe', ['/s', '/t', '0']],
  logout: ['shutdown.exe', ['/l']]
}

async function macPower(action: PowerAction, signal: AbortSignal): Promise<string> {
  switch (action) {
    case 'lock':
      // Ctrl+Cmd+Q is the system "Lock Screen" shortcut; without Accessibility fall back to display sleep.
      if (systemPreferences.isTrustedAccessibilityClient(false)) {
        const combo = toMacKey({ modifiers: ['ctrl', 'cmd'], key: 'q' })
        await runOsa(JXA_KEYS, [JSON.stringify({ combos: [combo] })], 'Locking the screen', { signal })
        return TEXT.lock.output
      }
      await runChecked('/usr/bin/pmset', ['displaysleepnow'], 'Display sleep', { signal })
      return 'Turned the display off; the Mac locks if a password is required after the display sleeps (Accessibility permission would allow a real lock).'
    case 'sleep':
      await runChecked('/usr/bin/pmset', ['sleepnow'], 'Sleep', { signal })
      return TEXT.sleep.output
    case 'display_off':
      await runChecked('/usr/bin/pmset', ['displaysleepnow'], 'Display sleep', { signal })
      return TEXT.display_off.output
    default:
      await runOsa(AS_POWER, [action], TEXT[action].output, { signal, timeoutMs: 20_000 })
      return TEXT[action].output
  }
}

async function winPower(action: PowerAction, signal: AbortSignal): Promise<string> {
  if (action === 'sleep') {
    await launchPowerShell(PS_SLEEP)
    return TEXT.sleep.output
  }
  if (action === 'display_off') {
    await runPowerShell(PS_DISPLAY_OFF, 'Display off', { signal })
    return TEXT.display_off.output
  }
  const command = WIN_POWER_COMMANDS[action]
  if (!command) throw new Error(`Unsupported power action ${action}`)
  if (action === 'lock') await launchDetached(command[0], command[1], { hidden: true })
  else await runChecked(command[0], command[1], TEXT[action].output, { signal })
  return TEXT[action].output
}

export function powerTools(env: ToolEnv): ToolDef[] {
  const systemPower: ToolDef = {
    spec: {
      name: 'system_power',
      description:
        'Lock the screen, sleep, turn the display off, restart, shut down or log out. Restart / shutdown / logout ask the ' +
        'user to confirm; use them only when the user explicitly asked.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: [...POWER_ACTIONS] } },
        required: ['action'],
        additionalProperties: false
      }
    },
    title: (args) => TEXT[String(args.action ?? '') as PowerAction]?.title ?? 'Управляю питанием',
    run: async (args, ctx) => {
      const action = reqEnum(args, 'action', POWER_ACTIONS)
      const text = TEXT[action]
      if (text.confirm) {
        const allowed = await env.confirm(ctx, {
          message: text.confirm,
          detail: 'Несохранённые данные в открытых программах могут быть потеряны.'
        })
        if (!allowed) return denied(action)
      }
      const output = env.platform === 'darwin' ? await macPower(action, ctx.signal) : await winPower(action, ctx.signal)
      return ok(output, text.summary)
    }
  }
  return [systemPower]
}
