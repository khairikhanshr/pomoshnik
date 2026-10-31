// Registry core: filters specs by settings and platform, Russian titles, and an execute()
// that never throws. Electron-free (tool definitions are injected).
import type { Settings } from '@shared/types'
import type { Logger } from '../log'
import { redact } from '../log'
import type { Args } from './args'
import { clip } from './args'
import { DESKTOP_PLATFORMS, type ToolDef } from './define'
import { errorMessage, isAbortError, ToolError } from './errors'
import type { ToolContext, ToolRegistry, ToolResult, ToolSpec } from './types'

type Availability = { ok: true } | { ok: false; reason: string }

export class ToolRegistryCore implements ToolRegistry {
  private readonly defs = new Map<string, ToolDef>()

  constructor(
    defs: readonly ToolDef[],
    private readonly platform: NodeJS.Platform,
    private readonly log: Logger
  ) {
    for (const def of defs) {
      if (this.defs.has(def.spec.name)) throw new Error(`Duplicate tool ${def.spec.name}`)
      this.defs.set(def.spec.name, def)
    }
  }

  names(): string[] {
    return [...this.defs.keys()]
  }

  private availability(def: ToolDef, settings: Settings): Availability {
    if (!(def.platforms ?? DESKTOP_PLATFORMS).includes(this.platform)) return { ok: false, reason: 'is not available on this operating system' }
    if (!settings.computerControl && !def.harmless) return { ok: false, reason: 'is disabled: computer control is turned off in Settings' }
    if (def.enabled && !def.enabled(settings)) return { ok: false, reason: 'is disabled in Settings' }
    return { ok: true }
  }

  specs(settings: Settings): ToolSpec[] {
    return [...this.defs.values()].filter((d) => this.availability(d, settings).ok).map((d) => d.spec)
  }

  describe(name: string, args: Record<string, unknown>): string {
    const def = this.defs.get(name)
    if (!def) return `Инструмент ${name}`
    try {
      return def.title(args && typeof args === 'object' ? args : {}) || name
    } catch {
      return name
    }
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const def = this.defs.get(name)
    if (!def) return { ok: false, output: `Error: unknown tool "${name}"`, summary: 'Неизвестный инструмент' }
    const available = this.availability(def, ctx.settings)
    if (!available.ok) return { ok: false, output: `Error: the tool ${name} ${available.reason}.`, summary: 'Инструмент отключён' }
    if (ctx.signal.aborted) return { ok: false, output: 'Error: cancelled by the user', summary: 'Отменено' }
    const safeArgs: Args = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    const started = Date.now()
    this.log.debug(`${name} ${redact(clip(JSON.stringify(safeArgs) ?? '{}', 300))}`)
    try {
      const result = await def.run(safeArgs, ctx)
      this.log.info(`${name}: ${result.ok ? 'ok' : 'failed'} in ${Date.now() - started} ms`)
      return result
    } catch (err) {
      if (isAbortError(err) || ctx.signal.aborted) {
        this.log.info(`${name}: cancelled`)
        return { ok: false, output: 'Error: cancelled by the user', summary: 'Отменено' }
      }
      const message = errorMessage(err)
      this.log.warn(`${name} failed in ${Date.now() - started} ms: ${message}`)
      const summary = err instanceof ToolError && err.summary ? err.summary : 'Не удалось выполнить'
      return { ok: false, output: `Error: ${message}`, summary }
    }
  }
}
