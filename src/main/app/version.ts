// App version: packaged builds know it; unpackaged runs launched as `electron out/main/index.js` would
// report Electron's own version, so read it from the project's package.json instead.
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const APP_NAME = 'Jarvis'
const PACKAGE_NAME = 'jarvis-assistant'

export function resolveAppVersion(): string {
  if (app.isPackaged) return app.getVersion()
  for (const dir of [app.getAppPath(), join(__dirname, '..', '..'), process.cwd()]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version
    } catch {
      // try the next candidate
    }
  }
  return app.getVersion()
}
