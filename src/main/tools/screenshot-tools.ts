import { optEnum, optObject, reqNumber } from './args'
import { ok, type ToolDef } from './define'
import type { ScreenshotService, DisplayChoice } from './screenshot'

const DISPLAYS: readonly DisplayChoice[] = ['cursor', 'primary', 'all']

export function screenshotTools(screenshots: ScreenshotService): ToolDef[] {
  const takeScreenshot: ToolDef = {
    spec: {
      name: 'take_screenshot',
      description:
        "Capture the screen (Jarvis' own windows are hidden) and look at it. display: cursor (default, the display under the " +
        'mouse), primary, or all. region {x, y, width, height} zooms into an area given in pixel coordinates of the previous ' +
        'screenshot — use it to read small text. The result states the image size; mouse coordinates refer to the latest image.',
      parameters: {
        type: 'object',
        properties: {
          display: { type: 'string', enum: [...DISPLAYS] },
          region: {
            type: 'object',
            description: 'Zoom area in pixels of the previous screenshot.',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' }
            },
            required: ['x', 'y', 'width', 'height']
          }
        },
        additionalProperties: false
      }
    },
    platforms: ['darwin', 'win32', 'linux'],
    title: (args) => (args.region ? 'Увеличиваю фрагмент экрана' : 'Делаю снимок экрана'),
    run: async (args, ctx) => {
      const display = optEnum(args, 'display', DISPLAYS) ?? 'cursor'
      const r = optObject(args, 'region')
      const region = r
        ? { x: reqNumber(r, 'x'), y: reqNumber(r, 'y'), width: reqNumber(r, 'width', { min: 1 }), height: reqNumber(r, 'height', { min: 1 }) }
        : undefined
      const shot = await screenshots.capture({ display, region, chatId: ctx.chatId })
      return ok(shot.description, `${region ? 'Фрагмент экрана' : 'Снимок экрана'} ${shot.summary}`, { images: [shot.image] })
    }
  }
  return [takeScreenshot]
}
