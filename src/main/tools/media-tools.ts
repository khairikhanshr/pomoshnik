import { optBoolean, optNumber, reqEnum } from './args'
import { ok, type ToolDef, type ToolEnv } from './define'
import { ToolError } from './errors'
import { ensureAccessibility } from './mac/permissions'
import { runOsa } from './mac/osa'
import { AS_VOLUME, JXA_MEDIA_KEY } from './mac/scripts'
import { runPowerShell } from './win/ps'
import { PS_MEDIA_KEY, PS_VOLUME } from './win/scripts'

type MediaAction = 'play_pause' | 'next' | 'previous'
const MEDIA_ACTIONS: readonly MediaAction[] = ['play_pause', 'next', 'previous']

/** NX_KEYTYPE_* (macOS) and VK_MEDIA_* (Windows). */
const MEDIA_KEYS: Record<MediaAction, { mac: number; win: number; title: string; summary: string }> = {
  play_pause: { mac: 16, win: 0xb3, title: 'Пауза / воспроизведение', summary: 'Пауза / воспроизведение' },
  next: { mac: 17, win: 0xb0, title: 'Следующий трек', summary: 'Следующий трек' },
  previous: { mac: 18, win: 0xb1, title: 'Предыдущий трек', summary: 'Предыдущий трек' }
}

export interface VolumeState {
  level: number | null
  muted: boolean | null
  exact: boolean
}

/** AppleScript result "50|false" (level is "missing value" for outputs without volume control). */
export function parseMacVolume(text: string): VolumeState {
  const [level, muted] = text.trim().split('|')
  const n = Number(level)
  return {
    level: Number.isFinite(n) ? Math.round(n) : null,
    muted: muted === 'true' ? true : muted === 'false' ? false : null,
    exact: true
  }
}

export function describeVolume(state: VolumeState): { output: string; summary: string } {
  if (!state.exact) {
    return { output: 'Volume changed with the volume keys (the exact level is not available on this device).', summary: 'Громкость изменена' }
  }
  const level = state.level === null ? 'unknown' : `${state.level}%`
  const output = `Volume is now ${level}${state.muted ? ', muted' : ''}.`
  if (state.muted) return { output, summary: 'Звук выключен' }
  return { output, summary: state.level === null ? 'Громкость изменена' : `Громкость: ${state.level}%` }
}

export function mediaTools(env: ToolEnv): ToolDef[] {
  const { platform } = env

  const setVolume: ToolDef = {
    spec: {
      name: 'set_volume',
      description:
        'Change the system output volume: level (0-100, absolute), change (relative, e.g. -10), and/or mute (true/false). ' +
        'Call with no arguments to read the current volume.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'number', minimum: 0, maximum: 100, description: 'Absolute volume in percent.' },
          change: { type: 'number', description: 'Relative change in percent points, e.g. 10 or -20.' },
          mute: { type: 'boolean', description: 'true = mute, false = unmute.' }
        },
        additionalProperties: false
      }
    },
    title: (args) => {
      if (args.mute === true || args.mute === 'true') return 'Выключаю звук'
      if (args.mute === false || args.mute === 'false') return 'Включаю звук'
      if (args.level !== undefined) return `Ставлю громкость ${String(args.level)}%`
      return args.change !== undefined ? 'Меняю громкость' : 'Смотрю громкость'
    },
    run: async (args, ctx) => {
      const level = optNumber(args, 'level', { min: 0, max: 100, integer: true })
      const change = optNumber(args, 'change', { min: -100, max: 100, integer: true })
      const mute = optBoolean(args, 'mute')
      let state: VolumeState
      if (platform === 'darwin') {
        const mode = level !== undefined ? 'set' : change !== undefined ? 'change' : 'get'
        const amount = level ?? change ?? 0
        const text = await runOsa(AS_VOLUME, [mode, String(amount), mute === undefined ? '' : String(mute)], 'Changing the volume', {
          signal: ctx.signal
        })
        state = parseMacVolume(text)
      } else {
        const result = await runPowerShell<VolumeState>(PS_VOLUME, 'Changing the volume', { args: { level, change, mute }, signal: ctx.signal })
        if (!result) throw new ToolError('No answer from the volume script')
        state = result
      }
      const { output, summary } = describeVolume(state)
      return ok(output, summary)
    }
  }

  const mediaControl: ToolDef = {
    spec: {
      name: 'media_control',
      description: 'Press a media key: play_pause, next or previous track (works with Music, Spotify, browsers, players).',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: [...MEDIA_ACTIONS] } },
        required: ['action'],
        additionalProperties: false
      }
    },
    title: (args) => MEDIA_KEYS[String(args.action ?? '') as MediaAction]?.title ?? 'Управляю воспроизведением',
    run: async (args, ctx) => {
      const action = reqEnum(args, 'action', MEDIA_ACTIONS)
      const key = MEDIA_KEYS[action]
      if (platform === 'darwin') {
        ensureAccessibility(platform)
        await runOsa(JXA_MEDIA_KEY, [String(key.mac)], 'Media key', { signal: ctx.signal })
      } else {
        await runPowerShell(PS_MEDIA_KEY, 'Media key', { args: { vk: key.win }, signal: ctx.signal })
      }
      return ok(`Sent the ${action.replace('_', '/')} media key.`, key.summary)
    }
  }

  return [setVolume, mediaControl]
}
