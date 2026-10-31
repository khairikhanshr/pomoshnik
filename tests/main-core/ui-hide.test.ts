import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hideAndWait, hideForCapture, hideTiming, type HideableWindow } from '../../src/main/app/ui-hide'

/** BrowserWindow stand-in; `hideEventDelayMs` mimics macOS reporting 'hide' after the window server. */
class FakeWindow extends EventEmitter implements HideableWindow {
  visible = true
  focused = false
  destroyed = false
  readonly log: string[] = []
  constructor(
    readonly name: string,
    private readonly hideEventDelayMs: number | null = 50
  ) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  isFocused(): boolean {
    return this.focused
  }
  hide(): void {
    this.log.push('hide')
    this.visible = false
    this.focused = false
    if (this.hideEventDelayMs !== null) setTimeout(() => this.emit('hide'), this.hideEventDelayMs)
  }
  showInactive(): void {
    this.log.push('showInactive')
    this.visible = true
  }
  focus(): void {
    this.log.push('focus')
    this.focused = true
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('hideAndWait', () => {
  it('resolves on the hide event, not before', async () => {
    const win = new FakeWindow('main', 120)
    let done = false
    void hideAndWait(win, 1000).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(30)
    expect(done).toBe(true)
    expect(win.listenerCount('hide')).toBe(0)
  })

  it('falls back to the timeout when no hide event arrives (e.g. an occluded window)', async () => {
    const win = new FakeWindow('main', null)
    let done = false
    void hideAndWait(win, 500).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(win.listenerCount('hide')).toBe(0)
  })

  it('does nothing for hidden or destroyed windows', async () => {
    const hidden = new FakeWindow('a')
    hidden.visible = false
    const destroyed = new FakeWindow('b')
    destroyed.destroyed = true
    await hideAndWait(hidden, 500)
    await hideAndWait(destroyed, 500)
    expect(hidden.log).toEqual([])
    expect(destroyed.log).toEqual([])
  })
})

describe('hideForCapture', () => {
  it('runs the capture only after every window reported hide plus the compositor delay', async () => {
    const main = new FakeWindow('main', 40)
    const overlay = new FakeWindow('overlay', 90)
    let ready = false
    void hideForCapture({ restorable: [main], hideOnly: [overlay] }, { hideTimeoutMs: 500, settleMs: 100 }).then(
      () => (ready = true)
    )
    await vi.advanceTimersByTimeAsync(90 + 99)
    expect(ready).toBe(false)
    expect(main.visible || overlay.visible).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(ready).toBe(true)
  })

  it('restores without stealing focus: showInactive, then focus only for the window that had it', async () => {
    const main = new FakeWindow('main')
    main.focused = true
    const voice = new FakeWindow('voice')
    const overlay = new FakeWindow('overlay')
    const pending = hideForCapture({ restorable: [main, voice, null], hideOnly: [overlay] }, hideTiming('darwin'))
    await vi.advanceTimersByTimeAsync(1000)
    const hidden = await pending
    hidden.restore()
    expect(main.log).toEqual(['hide', 'showInactive', 'focus'])
    expect(voice.log).toEqual(['hide', 'showInactive'])
    // The overlay HUD has its own show logic (overlay controller).
    expect(overlay.log).toEqual(['hide'])
  })

  it('skips windows that were not visible and does not wait when nothing is shown', async () => {
    const main = new FakeWindow('main')
    main.visible = false
    let ready = false
    void hideForCapture({ restorable: [main] }, { hideTimeoutMs: 500, settleMs: 100 }).then(() => (ready = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).toBe(true)
    expect(main.log).toEqual([])
  })

  it('waits longer on Windows (DWM fade-out after the synchronous hide event)', () => {
    expect(hideTiming('win32').settleMs).toBeGreaterThan(hideTiming('darwin').settleMs)
  })
})
