// ENTRY POINT CONTRACT (owned by the tools module): keep these exported signatures.
import { homedir } from 'node:os'
import type { ImageRef } from '@shared/types'
import { createLogger } from '../log'
import { createMacBackend } from './apps/mac'
import { appTools } from './apps/tools'
import { createWinBackend } from './apps/win'
import { clipboardTools } from './clipboard-tools'
import { createConfirm } from './confirm'
import type { ToolEnv } from './define'
import { errorMessage, ToolError } from './errors'
import { killAllChildren } from './exec'
import { fileTools } from './file-tools'
import { infoTools } from './info-tools'
import { createInputDriver } from './input'
import { inputTools } from './input-tools'
import { mediaTools } from './media-tools'
import { powerTools } from './power-tools'
import { ToolRegistryCore } from './registry'
import { createReminderService } from './reminders/tools'
import { ScreenshotService } from './screenshot'
import { screenshotTools } from './screenshot-tools'
import { shellTools } from './shell-tools'
import type { ToolHost, ToolRegistry } from './types'
import { webTools } from './web-tools'

export type { ToolHost, ToolRegistry } from './types'

const log = createLogger('tools')
/** Shared per host, so composer screenshots and take_screenshot use the same geometry store. */
const screenshotServices = new WeakMap<ToolHost, ScreenshotService>()
const WARMUP_DELAY_MS = 8000

function screenshotsFor(host: ToolHost): ScreenshotService {
  let service = screenshotServices.get(host)
  if (!service) {
    service = new ScreenshotService(host, log)
    screenshotServices.set(host, service)
  }
  return service
}

export function createToolRegistry(host: ToolHost): ToolRegistry & { dispose(): void } {
  const platform = host.platform
  const env: ToolEnv = { host, platform, log, confirm: createConfirm(host, log) }
  const screenshots = screenshotsFor(host)
  const apps = platform === 'win32' ? createWinBackend() : createMacBackend(homedir())
  const reminders = createReminderService(env)
  const core = new ToolRegistryCore(
    [
      ...screenshotTools(screenshots),
      ...appTools(env, apps),
      ...webTools(),
      ...fileTools(env),
      ...inputTools(env, createInputDriver(platform), screenshots),
      ...mediaTools(env),
      ...powerTools(env),
      ...clipboardTools(),
      ...infoTools(env),
      ...reminders.tools,
      ...shellTools(env)
    ],
    platform,
    log
  )
  reminders.start()

  // Warm the installed-apps cache so the first "открой …" is quick (Get-StartApps takes a moment).
  const warmup = setTimeout(() => {
    if (!host.settings.get().computerControl || (platform !== 'darwin' && platform !== 'win32')) return
    apps.installed().catch((err) => log.warn('app scan failed', err))
  }, WARMUP_DELAY_MS)
  warmup.unref?.()

  let disposed = false
  return {
    specs: (settings) => core.specs(settings),
    describe: (name, args) => core.describe(name, args),
    execute: (name, args, ctx) => core.execute(name, args, ctx),
    dispose: () => {
      if (disposed) return
      disposed = true
      clearTimeout(warmup)
      reminders.dispose()
      killAllChildren()
    }
  }
}

/**
 * Screenshot of the display under the mouse cursor (Jarvis windows hidden while capturing),
 * stored in the MediaStore. Used by the composer's "attach screenshot" button.
 */
export async function captureScreen(host: ToolHost): Promise<ImageRef> {
  try {
    const shot = await screenshotsFor(host).capture({ display: 'cursor' })
    return shot.image
  } catch (err) {
    log.warn('captureScreen failed', err)
    if (err instanceof ToolError && err.summary === 'Нужно разрешение «Запись экрана»') {
      throw new Error(
        'Нет разрешения на запись экрана. Включите Jarvis в «Системные настройки → Конфиденциальность и безопасность → ' +
          'Запись экрана и системного звука», затем перезапустите приложение.'
      )
    }
    throw new Error(`Не удалось сделать снимок экрана: ${errorMessage(err)}`)
  }
}
