// AppleScript / JXA sources. They are constants: user data arrives only through `argv`
// (`on run argv` / `function run(argv)`), never by string interpolation.

export interface OsaScript {
  language: 'AppleScript' | 'JavaScript'
  source: string
}

/** argv: [kind ('id' | 'name'), target]. Asks the app to quit without waiting for save dialogs. */
export const AS_QUIT_APP: OsaScript = {
  language: 'AppleScript',
  source: `on run argv
  set refKind to item 1 of argv
  set refTarget to item 2 of argv
  if refKind is "id" then
    set appRef to application id refTarget
  else
    set appRef to application refTarget
  end if
  if appRef is not running then return "not-running"
  ignoring application responses
    tell appRef to quit
  end ignoring
  repeat 12 times
    delay 0.25
    if appRef is not running then return "quit"
  end repeat
  return "still-running"
end run`
}

/** argv: [mode ('get' | 'set' | 'change'), amount, mute ('true' | 'false' | '')]. Standard Additions only. */
export const AS_VOLUME: OsaScript = {
  language: 'AppleScript',
  source: `on run argv
  set volMode to item 1 of argv
  set volAmount to (item 2 of argv) as integer
  set volMute to item 3 of argv
  set curLevel to output volume of (get volume settings)
  if volMode is "set" then
    set volume output volume volAmount
  else if volMode is "change" then
    if curLevel is missing value then error "The current output device has no software volume control."
    set newLevel to curLevel + volAmount
    if newLevel < 0 then set newLevel to 0
    if newLevel > 100 then set newLevel to 100
    set volume output volume newLevel
  end if
  if volMute is "true" then
    set volume output muted true
  else if volMute is "false" then
    set volume output muted false
  else if volMode is "set" or (volMode is "change" and volAmount > 0) then
    set volume output muted false
  end if
  set vs to get volume settings
  return ((output volume of vs) as text) & "|" & ((output muted of vs) as text)
end run`
}

/** argv: [action ('restart' | 'shutdown' | 'logout')]. Raw System Events codes, so no terminology lookup. */
export const AS_POWER: OsaScript = {
  language: 'AppleScript',
  source: `on run argv
  set powerAction to item 1 of argv
  tell application id "com.apple.systemevents"
    if powerAction is "restart" then
      «event fndrrest»
    else if powerAction is "shutdown" then
      «event fndrshut»
    else if powerAction is "logout" then
      «event fndrlogo»
    else
      error "Unknown power action"
    end if
  end tell
  return "ok"
end run`
}

/**
 * Regular (Dock) apps as JSON: name, bundleId, pid, path, active, hidden.
 * The bridge returns NSInteger properties as strings, hence Number().
 */
export const JXA_RUNNING_APPS: OsaScript = {
  language: 'JavaScript',
  source: `ObjC.import('AppKit')
function run() {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications
  const count = Number(apps.count)
  const out = []
  for (let i = 0; i < count; i++) {
    const app = apps.objectAtIndex(i)
    if (Number(app.activationPolicy) !== 0) continue
    out.push({
      name: ObjC.unwrap(app.localizedName) || '',
      bundleId: ObjC.unwrap(app.bundleIdentifier) || '',
      pid: Number(app.processIdentifier),
      path: app.bundleURL.isNil() ? '' : ObjC.unwrap(app.bundleURL.path) || '',
      active: app.active === true,
      hidden: app.hidden === true
    })
  }
  return JSON.stringify(out)
}`
}

/** argv: [pid]. Unhides and activates a running app. */
export const JXA_ACTIVATE: OsaScript = {
  language: 'JavaScript',
  source: `ObjC.import('AppKit')
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(parseInt(argv[0], 10))
  if (app.isNil()) return 'not-running'
  if (app.hidden) app.unhide
  return app.activateWithOptions(3) ? 'ok' : 'failed'
}`
}

/** Path of the default https handler. */
export const JXA_DEFAULT_BROWSER: OsaScript = {
  language: 'JavaScript',
  source: `ObjC.import('AppKit')
function run() {
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('https://www.example.com'))
  return url.isNil() ? '' : ObjC.unwrap(url.path) || ''
}`
}

/** argv: [JSON { action, x?, y?, dy? }] in global display points (Quartz coordinates). */
export const JXA_MOUSE: OsaScript = {
  language: 'JavaScript',
  source: `ObjC.import('CoreGraphics')
function run(argv) {
  const a = JSON.parse(argv[0])
  const hasPoint = typeof a.x === 'number' && typeof a.y === 'number'
  const point = hasPoint ? $.CGPointMake(a.x, a.y) : $.CGEventGetLocation($.CGEventCreate(null))
  const mouse = (type, button, clicks) => {
    const e = $.CGEventCreateMouseEvent(null, type, point, button)
    if (clicks > 0) $.CGEventSetIntegerValueField(e, 1, clicks)
    $.CGEventPost(0, e)
  }
  const click = (down, up, button, clicks) => {
    mouse(down, button, clicks)
    delay(0.02)
    mouse(up, button, clicks)
  }
  if (hasPoint) {
    mouse(5, 0, 0)
    delay(0.04)
  }
  if (a.action === 'click') click(1, 2, 0, 1)
  else if (a.action === 'double_click') {
    click(1, 2, 0, 1)
    delay(0.06)
    click(1, 2, 0, 2)
  } else if (a.action === 'right_click') click(3, 4, 1, 1)
  else if (a.action === 'scroll') {
    const steps = Math.min(Math.abs(a.dy || 0), 100)
    for (let i = 0; i < steps; i++) {
      $.CGEventPost(0, $.CGEventCreateScrollWheelEvent2(null, 1, 1, a.dy > 0 ? -1 : 1, 0, 0))
      delay(0.015)
    }
  } else if (a.action !== 'move') throw new Error('Unknown mouse action: ' + a.action)
  const now = $.CGEventGetLocation($.CGEventCreate(null))
  return JSON.stringify({ x: Number(now.x), y: Number(now.y) })
}`
}

/** argv: [JSON { combos: [{ code, flags }] }] — virtual key codes with CGEventFlags. */
export const JXA_KEYS: OsaScript = {
  language: 'JavaScript',
  source: `ObjC.import('CoreGraphics')
function run(argv) {
  const a = JSON.parse(argv[0])
  for (const combo of a.combos) {
    for (const isDown of [true, false]) {
      const e = $.CGEventCreateKeyboardEvent(null, combo.code, isDown)
      $.CGEventSetFlags(e, combo.flags)
      $.CGEventPost(0, e)
      delay(0.012)
    }
    delay(0.04)
  }
  return String(a.combos.length)
}`
}

/** argv: [NX key type] — system-defined media key event (play 16, next 17, previous 18). */
export const JXA_MEDIA_KEY: OsaScript = {
  language: 'JavaScript',
  source: `ObjC.import('Cocoa')
ObjC.import('CoreGraphics')
function run(argv) {
  const key = parseInt(argv[0], 10)
  for (const isDown of [true, false]) {
    const flags = isDown ? 0xa00 : 0xb00
    const ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
      14, $.NSMakePoint(0, 0), flags, 0, 0, null, 8, (key << 16) | flags, -1)
    $.CGEventPost(0, ev.CGEvent)
    delay(0.02)
  }
  return 'ok'
}`
}

/** Every script, for compile checks in tests. */
export const MAC_SCRIPTS: Readonly<Record<string, OsaScript>> = {
  quitApp: AS_QUIT_APP,
  volume: AS_VOLUME,
  power: AS_POWER,
  runningApps: JXA_RUNNING_APPS,
  activate: JXA_ACTIVATE,
  defaultBrowser: JXA_DEFAULT_BROWSER,
  mouse: JXA_MOUSE,
  keys: JXA_KEYS,
  mediaKey: JXA_MEDIA_KEY
}
