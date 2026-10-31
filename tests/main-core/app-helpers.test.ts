import { describe, expect, it } from 'vitest'
import { checkAccelerator } from '../../src/main/app/accelerator'
import { readEnv } from '../../src/main/app/env'
import { settingsEntryNav, settingsNav } from '../../src/main/app/navigation'
import { overlayBounds } from '../../src/main/app/overlay-position'
import { asNavigate } from '../../src/main/ipc/validate'
import { SETTINGS_TAB_IDS } from '../../src/shared/types'

describe('settings navigation', () => {
  it('uses the settings tab ids of the UI', () => {
    expect(SETTINGS_TAB_IDS).toEqual(['ai', 'voice', 'activation', 'computer', 'general', 'about'])
    for (const tab of SETTINGS_TAB_IDS) expect(asNavigate(settingsNav(tab))).toEqual({ view: 'settings', settingsTab: tab })
  })

  it('"Настройки…" opens the AI tab while there is no API key, else the last tab', () => {
    expect(settingsEntryNav(false)).toEqual({ view: 'settings', settingsTab: 'ai' })
    expect(settingsEntryNav(true)).toEqual({ view: 'settings' })
  })
})

describe('checkAccelerator', () => {
  it('accepts valid accelerators', () => {
    for (const acc of [
      'CommandOrControl+Shift+Space',
      'CommandOrControl+Shift+J',
      'Alt+F4',
      'Ctrl+Alt+Plus',
      'Super+1',
      'F13',
      'MediaPlayPause',
      'Cmd+Shift+/',
      'Option+num5'
    ]) {
      expect(checkAccelerator(acc), acc).toEqual({ valid: true })
    }
  })

  it('rejects invalid or dangerous accelerators', () => {
    for (const acc of ['', 'Ctrl++', 'Hyper+K', 'Ctrl+Ctrl+K', 'Ctrl+Shift', 'Ctrl+Банан', 'K', 'Space', 'Ctrl+F25']) {
      const res = checkAccelerator(acc)
      expect(res.valid, acc).toBe(false)
      expect(res.reason).toBeTruthy()
    }
  })
})

describe('overlayBounds', () => {
  const wa = { x: 0, y: 25, width: 1440, height: 875 }

  it('places the HUD in each corner of the work area', () => {
    expect(overlayBounds(wa, 'top-right')).toEqual({ x: 1440 - 380 - 16, y: 25 + 16, width: 380, height: 320 })
    expect(overlayBounds(wa, 'top-center')).toEqual({ x: 530, y: 41, width: 380, height: 320 })
    expect(overlayBounds(wa, 'bottom-center')).toEqual({ x: 530, y: 25 + 875 - 320 - 16, width: 380, height: 320 })
    expect(overlayBounds(wa, 'bottom-right')).toEqual({ x: 1044, y: 564, width: 380, height: 320 })
  })

  it('handles secondary displays with negative origins and tiny screens', () => {
    expect(overlayBounds({ x: -1920, y: 0, width: 1920, height: 1040 }, 'top-right')).toEqual({
      x: -380 - 16,
      y: 16,
      width: 380,
      height: 320
    })
    const tiny = overlayBounds({ x: 0, y: 0, width: 300, height: 200 }, 'top-right')
    expect(tiny.width).toBe(268)
    expect(tiny.height).toBe(168)
    expect(tiny.x).toBe(16)
  })
})

describe('readEnv', () => {
  it('parses overrides', () => {
    const env = readEnv(
      {
        JARVIS_USER_DATA: ' /tmp/x ',
        JARVIS_API_KEY: 'sk-test',
        JARVIS_E2E: '1',
        JARVIS_DEBUG: 'true',
        JARVIS_SHOW_VOICE: '0',
        ELECTRON_RENDERER_URL: 'http://localhost:5173/'
      },
      ['electron', '.', '--hidden'],
      false
    )
    expect(env).toMatchObject({
      userDataDir: '/tmp/x',
      apiKey: 'sk-test',
      e2e: true,
      debug: true,
      showVoice: false,
      rendererUrl: 'http://localhost:5173',
      hiddenArg: true
    })
    expect(env.elevenLabsKey).toBeUndefined()
  })

  it('ignores the dev server URL in packaged builds', () => {
    expect(readEnv({ ELECTRON_RENDERER_URL: 'http://localhost:5173' }, [], true).rendererUrl).toBeUndefined()
    expect(readEnv({}, [], false)).toMatchObject({ e2e: false, hiddenArg: false })
  })
})
