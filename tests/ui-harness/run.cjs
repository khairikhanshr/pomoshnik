// Visual harness: renders the built main window and overlay with a mocked window.jarvis and saves screenshots.
// Usage (from the repo root):
//   env -u ELECTRON_RUN_AS_NODE npx electron tests/ui-harness/run.cjs <outDir> <shotsDir> [scenarioFilter]
// <outDir> is an electron-vite build output (with renderer/index.html and renderer/overlay.html).
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const outDir = resolve(process.argv[2] || 'out')
const shotsDir = resolve(process.argv[3] || 'shots')
const filter = process.argv[4] || ''
const preload = join(__dirname, 'mock-preload.cjs')

const MAIN_SIZES = [
  { tag: '1180', width: 1180, height: 760 },
  { tag: 'min', width: 860, height: 560 }
]

const MAIN_SCENARIOS = [
  'empty',
  'onboarding',
  'conversation',
  'settings-ai',
  'settings-voice',
  'settings-voice-eleven',
  'settings-activation',
  'settings-computer',
  'settings-general',
  'settings-about'
]

const OVERLAY_SCENARIOS = ['overlay-listening', 'overlay-thinking', 'overlay-acting', 'overlay-speaking', 'overlay-error']

// Approximate window chrome so title-bar insets can be judged on the screenshots.
const CHROME = {
  darwin: `(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:18px;top:20px;display:flex;gap:8px;z-index:99999;pointer-events:none';
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const i = document.createElement('i'); i.style.cssText = 'width:12px;height:12px;border-radius:50%;background:' + c; d.appendChild(i) }
    document.body.appendChild(d) })()`,
  win32: `(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;right:0;top:0;width:138px;height:40px;display:flex;z-index:99999;pointer-events:none;color:#9fe9ff;font:14px sans-serif';
    for (const c of ['—', '☐', '✕']) { const i = document.createElement('span'); i.textContent = c; i.style.cssText = 'flex:1;display:grid;place-items:center'; d.appendChild(i) }
    document.body.appendChild(d) })()`
}

const WALLPAPER = `html:root { background: radial-gradient(900px 500px at 20% 0%, #3d5a99 0%, transparent 60%), linear-gradient(135deg, #1f2b4d, #4a3d6b 55%, #7a5c7d) !important; }`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Windows are created and destroyed one by one: keep the app alive in between.
app.on('window-all-closed', () => undefined)

/** Shown without focus (hidden windows may not repaint), parked in the corner of the screen. */
function makeWindow(opts) {
  return new BrowserWindow({ x: 0, y: 0, show: false, useContentSize: true, focusable: false, ...opts })
}

async function waitFor(win, expr, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await win.webContents.executeJavaScript(expr).catch(() => false)) return true
    await sleep(100)
  }
  return false
}

async function capture(win, file) {
  const image = await win.webContents.capturePage()
  writeFileSync(file, image.toPNG())
  const size = image.getSize()
  console.log(`saved ${file} (${size.width}x${size.height})`)
}

async function shootMain(scenario, size, platform) {
  const win = makeWindow({
    width: size.width,
    height: size.height,
    backgroundColor: '#05080d',
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  const errors = []
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') errors.push(`[${e.level}] ${e.message}`)
  })
  await win.loadFile(join(outDir, 'renderer', 'index.html'), { query: { scenario, platform } })
  win.showInactive()
  await waitFor(win, `!!document.querySelector('.app')`)
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  await sleep(scenario === 'conversation' ? 1600 : 900)
  if (scenario === 'conversation') {
    // Scroll the transcript so the screenshot, the tool chips and the streaming reply are all visible.
    await win.webContents.executeJavaScript(`document.querySelector('.messages')?.scrollTo({ top: 1e6 })`)
    await sleep(200)
  }
  await win.webContents.executeJavaScript(CHROME[platform] || 'void 0')
  await sleep(100)
  await capture(win, join(shotsDir, `${scenario}-${size.tag}-${platform}.png`))
  if (errors.length) console.log(`  console (${scenario}):\n   ${errors.slice(0, 8).join('\n   ')}`)
  win.destroy()
}

async function shootExtra(name, size, platform, scenario, js) {
  const win = makeWindow({ width: size.width, height: size.height, backgroundColor: '#05080d', webPreferences: { preload, sandbox: true } })
  await win.loadFile(join(outDir, 'renderer', 'index.html'), { query: { scenario, platform } })
  win.showInactive()
  await waitFor(win, `!!document.querySelector('.app')`)
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  await sleep(1400)
  await win.webContents.executeJavaScript(js)
  await sleep(500)
  await capture(win, join(shotsDir, `${name}-${size.tag}-${platform}.png`))
  win.destroy()
}

async function shootOverlay(scenario, wallpaper) {
  const win = makeWindow({
    width: 380,
    height: 320,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload, contextIsolation: true, sandbox: true }
  })
  await win.loadFile(join(outDir, 'renderer', 'overlay.html'), { query: { scenario, platform: 'darwin' } })
  win.showInactive()
  await waitFor(win, `!!document.querySelector('.ov-panel')`)
  if (wallpaper) await win.webContents.insertCSS(WALLPAPER)
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  await sleep(1200)
  await capture(win, join(shotsDir, `${scenario}${wallpaper ? '' : '-alpha'}.png`))
  win.destroy()
}

app.whenReady().then(async () => {
  mkdirSync(shotsDir, { recursive: true })
  try {
    for (const scenario of MAIN_SCENARIOS) {
      if (filter && !scenario.includes(filter)) continue
      for (const size of MAIN_SIZES) await shootMain(scenario, size, 'darwin')
    }
    if (!filter || filter === 'win') {
      for (const scenario of ['conversation', 'settings-ai']) await shootMain(scenario, MAIN_SIZES[1], 'win32')
    }
    if (!filter || filter === 'extra') {
      await shootExtra('conversation-top', MAIN_SIZES[0], 'darwin', 'conversation', `document.querySelector('.messages')?.scrollTo({ top: 0 })`)
      await shootExtra('conversation-code', MAIN_SIZES[0], 'darwin', 'conversation', `document.querySelectorAll('.msg--assistant')[1]?.scrollIntoView()`)
      await shootExtra('lightbox', MAIN_SIZES[0], 'darwin', 'conversation', `document.querySelector('.img-thumb')?.click()`)
      await shootExtra('tooltip-tier', MAIN_SIZES[0], 'darwin', 'conversation', `document.querySelector('.tier-seg--sol')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`)
      await shootExtra('tool-open', MAIN_SIZES[0], 'darwin', 'conversation', `document.querySelectorAll('.tool-chip-head')[1]?.click(); document.querySelector('.messages')?.scrollBy(0, -260)`)
      await shootExtra('confirm', MAIN_SIZES[1], 'darwin', 'conversation', `document.querySelector('.sb-item .icon-btn--danger')?.click()`)
      await shootExtra('search', MAIN_SIZES[1], 'darwin', 'empty', `(() => { const i = document.getElementById('chat-search'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'план'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    }
    for (const scenario of OVERLAY_SCENARIOS) {
      if (filter && !scenario.includes(filter) && filter !== 'overlay') continue
      await shootOverlay(scenario, true)
    }
    if (!filter || filter === 'overlay') await shootOverlay('overlay-speaking', false)
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
  app.quit()
})
