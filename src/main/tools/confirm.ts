// Confirmation dialogs for dangerous tool actions.
import { dialog, type MessageBoxOptions } from 'electron'
import type { Logger } from '../log'
import type { ConfirmFn, ConfirmRequest } from './define'
import type { ToolContext, ToolHost } from './types'

const DIALOG_TIMEOUT_MS = 120_000

/** JARVIS_AUTO_CONFIRM=allow|deny answers every confirmation (tests, e2e). */
export function autoConfirmOverride(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const value = env.JARVIS_AUTO_CONFIRM?.trim().toLowerCase()
  if (!value) return null
  if (['allow', 'yes', 'true', '1'].includes(value)) return true
  if (['deny', 'no', 'false', '0'].includes(value)) return false
  return null
}

export function spokenConfirmPrompt(ctx: ToolContext, req: ConfirmRequest): string {
  return req.spoken ?? `Требуется ваше подтверждение, ${ctx.settings.userTitle.trim() || 'сэр'}.`
}

export function createConfirm(host: ToolHost, log: Logger): ConfirmFn {
  let queue: Promise<unknown> = Promise.resolve()
  let counter = 0

  async function ask(ctx: ToolContext, req: ConfirmRequest): Promise<boolean> {
    if (ctx.signal.aborted) return false
    if (!ctx.settings.confirmDangerous) return true
    const auto = autoConfirmOverride()
    if (auto !== null) {
      log.info(`confirmation auto-${auto ? 'allowed' : 'denied'}: ${req.message}`)
      return auto
    }
    if (ctx.source === 'voice') {
      counter += 1
      host.bus.emit('speak', { turnId: `confirm-${ctx.turnId}-${counter}`, seq: 0, text: spokenConfirmPrompt(ctx, req), final: true })
    }
    const options: MessageBoxOptions = {
      type: 'warning',
      title: 'Джарвис — подтверждение',
      message: req.message,
      detail: req.detail,
      buttons: ['Разрешить', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(DIALOG_TIMEOUT_MS)])
    }
    // A sheet on the main window keeps the dialog asynchronous; a parentless macOS alert would block
    // the main process (and with it IPC and speech) until answered.
    const win = host.windows.getMainWindow()
    const usable = win && !win.isDestroyed() ? win : null
    const wasVisible = usable ? usable.isVisible() && !usable.isMinimized() : false
    try {
      if (usable && !wasVisible) host.windows.showMain()
      const { response } = usable ? await dialog.showMessageBox(usable, options) : await dialog.showMessageBox(options)
      return response === 0 && !ctx.signal.aborted
    } catch (err) {
      log.warn('confirmation dialog failed', err)
      return false
    } finally {
      if (usable && !wasVisible && !usable.isDestroyed()) host.windows.hideMain()
    }
  }

  // One dialog at a time.
  return (ctx, req) => {
    const task = queue.then(() => ask(ctx, req))
    queue = task.catch(() => undefined)
    return task
  }
}
