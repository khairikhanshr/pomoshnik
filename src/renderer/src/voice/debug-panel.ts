// Minimal status view for the (normally hidden) voice window, useful with JARVIS_SHOW_VOICE=1.
import type { VoicePhaseReport } from '@shared/types'

const MAX_LINES = 40

export class DebugPanel {
  private readonly lines: string[] = []
  private status = 'запуск…'

  constructor(private readonly root: HTMLElement | null) {
    this.render()
  }

  phase(report: VoicePhaseReport): void {
    const parts = [`фаза: ${report.phase}`, `активация: ${report.wakeActive ? 'слушаю' : 'выкл'}`]
    if (report.engineError) parts.push(`ошибка движка: ${report.engineError}`)
    if (report.error) parts.push(`ошибка: ${report.error}`)
    this.status = parts.join(' · ')
    this.render()
  }

  log(level: string, message: string): void {
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false })
    this.lines.push(`${time} ${level.padEnd(5)} ${message}`)
    if (this.lines.length > MAX_LINES) this.lines.shift()
    this.render()
  }

  private render(): void {
    if (this.root) this.root.textContent = `Jarvis — голосовой движок\n${this.status}\n\n${this.lines.join('\n')}`
  }
}
