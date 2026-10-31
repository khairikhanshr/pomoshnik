import { homedir } from 'node:os'
import { app } from 'electron'
import type { PathContext, SpecialDir } from './paths'

export function hostPathContext(platform: NodeJS.Platform): PathContext {
  const safe = (name: SpecialDir): string | undefined => {
    try {
      return app.getPath(name)
    } catch {
      return undefined
    }
  }
  return { platform, home: safe('home') ?? homedir(), specialDir: safe, env: process.env }
}
