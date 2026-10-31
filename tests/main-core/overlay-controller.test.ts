import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOverlayController } from '../../src/main/app/overlay-controller'

function setup(enabled = true) {
  const state = { visible: false, enabled, suppressed: false, shows: 0, hides: 0 }
  const controller = createOverlayController({
    isEnabled: () => state.enabled,
    isSuppressed: () => state.suppressed,
    isVisible: () => state.visible,
    show: () => {
      state.visible = true
      state.shows++
    },
    hide: () => {
      state.visible = false
      state.hides++
    }
  })
  return { state, controller }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('overlay controller', () => {
  it('shows while active and hides ~5 s after idle', () => {
    const { state, controller } = setup()
    controller.onPhase('listening')
    expect(state.visible).toBe(true)
    controller.onPhase('thinking')
    controller.onPhase('speaking')
    expect(state.shows).toBe(1)
    controller.onPhase('idle')
    vi.advanceTimersByTime(4900)
    expect(state.visible).toBe(true)
    controller.onPhase('idle') // repeated idle updates do not extend the timer
    vi.advanceTimersByTime(100)
    expect(state.visible).toBe(false)
  })

  it('cancels the hide when activity resumes', () => {
    const { state, controller } = setup()
    controller.onPhase('thinking')
    controller.onPhase('idle')
    vi.advanceTimersByTime(3000)
    controller.onPhase('listening')
    vi.advanceTimersByTime(10_000)
    expect(state.visible).toBe(true)
  })

  it('keeps errors visible a bit longer', () => {
    const { state, controller } = setup()
    controller.onPhase('thinking')
    controller.onPhase('error')
    vi.advanceTimersByTime(5000)
    expect(state.visible).toBe(true)
    vi.advanceTimersByTime(3000)
    expect(state.visible).toBe(false)
  })

  it('respects the setting and the user dismissal', () => {
    const disabled = setup(false)
    disabled.controller.onPhase('listening')
    disabled.controller.showExplicit()
    expect(disabled.state.shows).toBe(0)

    const { state, controller } = setup()
    controller.onPhase('thinking')
    controller.dismiss()
    controller.onPhase('acting')
    expect(state.visible).toBe(false)
    controller.onPhase('idle')
    controller.onPhase('listening')
    expect(state.visible).toBe(true)

    controller.setEnabled(false)
    expect(state.visible).toBe(false)
  })

  it('does not show while UI is suppressed and resumes afterwards', () => {
    const { state, controller } = setup()
    state.suppressed = true
    controller.onPhase('acting')
    expect(state.visible).toBe(false)
    state.suppressed = false
    controller.resume()
    expect(state.visible).toBe(true)
  })

  it('auto-hides an explicit show when nothing happens', () => {
    const { state, controller } = setup()
    controller.showExplicit()
    expect(state.visible).toBe(true)
    vi.advanceTimersByTime(8000)
    expect(state.visible).toBe(false)
    controller.showExplicit()
    controller.onPhase('listening')
    vi.advanceTimersByTime(20_000)
    expect(state.visible).toBe(true)
  })
})
