#!/usr/bin/env node
// End-to-end suite: launches the built app (out/) with playwright-core's _electron against the mock
// OpenAI / ElevenLabs server (tests/e2e/mock-openai.mjs). Every scenario gets a fresh userData dir.
//
//   npm run test:e2e                       build (--build), then run every scenario
//   node tests/e2e/run.mjs --only S1,S3    run some scenarios against the existing out/
//   options: --artifacts <dir> (screenshots, logs; default <tmp>/jarvis-e2e), --keep (keep userData dirs)
//
// Safety: JARVIS_E2E=1 (no OS prompts / Keychain / login items), JARVIS_AUTO_CONFIRM=deny, a fake
// microphone (Chromium fake capture device fed from a WAV file, never the real mic), --mute-audio.
// The mock model only ever calls get_datetime.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { makeFakeMicWav } from './make-fake-mic.mjs'
import { startMockServer } from './mock-openai.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(ROOT, 'package.json'))
const { _electron } = require('playwright-core')
/** From plain Node, require('electron') is the path of the Electron binary. */
const ELECTRON = require('electron')
const MAIN_JS = join(ROOT, 'out/main/index.js')

const argv = process.argv.slice(2)
const option = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const ONLY = (option('--only') ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)
const KEEP = argv.includes('--keep')
const ARTIFACTS = resolve(option('--artifacts') ?? join(tmpdir(), 'jarvis-e2e'))
mkdirSync(ARTIFACTS, { recursive: true })

const KEY = 'sk-e2e-0123456789abcd'
const TITLE_PREFIX = 'You name chat conversations'
const VOICE_PHRASE = 'Джарвис, сколько сейчас времени?'

// ---------------------------------------------------------------------------------------------------
// helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (line) => process.stdout.write(`${line}\n`)
const short = (value, max = 160) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text && text.length > max ? `${text.slice(0, max - 1)}…` : (text ?? '')
}

async function until(fn, { timeout = 15_000, interval = 100, what = 'condition' } = {}) {
  const started = Date.now()
  let last
  for (;;) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    if (Date.now() - started > timeout) {
      const why = last instanceof Error ? `: ${last.message.split('\n')[0]}` : ''
      throw new Error(`timed out after ${timeout} ms waiting for ${what}${why}`)
    }
    await sleep(interval)
  }
}

class Scenario {
  constructor(id, title) {
    this.id = id
    this.title = title
    this.checks = []
    this.facts = []
    this.error = null
    this.started = Date.now()
  }
  check(name, ok, detail = '') {
    this.checks.push({ name, ok: !!ok, detail })
    log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${short(detail, 400)}` : ''}`)
    return !!ok
  }
  fact(text) {
    this.facts.push(text)
    log(`  · ${text}`)
  }
  get ok() {
    return !this.error && this.checks.length > 0 && this.checks.every((c) => c.ok)
  }
}

/** 48 kHz mono PCM16 silence for the fake microphone of scenarios that do not speak. */
function silentWav(file, seconds = 3, rate = 48_000) {
  if (existsSync(file)) return file
  const n = seconds * rate
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  writeFileSync(file, buf)
  return file
}

/** A small RGB PNG (cyan) for attachment tests. */
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([0x3a, 0xd8, 0xff], y * (width * 3 + 1) + 1 + x * 3)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const userDirs = []
function freshUserData(name) {
  const dir = mkdtempSync(join(tmpdir(), `jarvis-e2e-${name}-`))
  userDirs.push(dir)
  return dir
}

function mainLog(userData) {
  try {
    return readFileSync(join(userData, 'logs', 'main.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Requests of the mock (optionally only since index `from`). */
function reqs(mock, filter, from = 0) {
  return mock.requests.slice(from).filter(filter)
}
const isTitleBody = (json) =>
  String(json?.instructions ?? json?.messages?.[0]?.content ?? '').startsWith(TITLE_PREFIX)
const responsesTurns = (mock, from = 0) =>
  reqs(mock, (r) => r.method === 'POST' && r.path === '/v1/responses' && r.json && !isTitleBody(r.json), from)
const chatTurns = (mock, from = 0) =>
  reqs(mock, (r) => r.method === 'POST' && r.path === '/v1/chat/completions' && r.json && !isTitleBody(r.json), from)
const titleRequests = (mock, from = 0) =>
  reqs(mock, (r) => r.method === 'POST' && (r.path === '/v1/responses' || r.path === '/v1/chat/completions') && isTitleBody(r.json), from)

function lastUserText(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it?.role !== 'user') continue
    if (typeof it.content === 'string') return it.content
    if (Array.isArray(it.content)) return it.content.map((p) => p.text ?? '').join(' ')
  }
  return ''
}

/** Launches the app; the fake microphone plays `micWav` (silence by default). */
async function launch({ name, mock, userData = freshUserData(name), apiKey = KEY, micWav, env = {} }) {
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(childEnv)) if (key.startsWith('JARVIS_')) delete childEnv[key]
  Object.assign(childEnv, {
    JARVIS_USER_DATA: userData,
    JARVIS_E2E: '1',
    JARVIS_AUTO_CONFIRM: 'deny',
    JARVIS_DEBUG: '1',
    JARVIS_OPENAI_BASE_URL: `${mock.url}/v1`,
    JARVIS_ELEVENLABS_BASE_URL: mock.url,
    ...env
  })
  if (apiKey) childEnv.JARVIS_API_KEY = apiKey
  const wav = micWav ?? silentWav(join(ARTIFACTS, 'silence.wav'))
  const args = [
    MAIN_JS,
    '--mute-audio',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--disable-features=AudioServiceSandbox',
    // A covered window (or a locked screen) must not throttle the pages under test.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ]
  const app = await _electron.launch({ executablePath: ELECTRON, args, env: childEnv, cwd: ROOT, timeout: 60_000 })
  const output = []
  app.process().stdout?.on('data', (d) => output.push(String(d)))
  app.process().stderr?.on('data', (d) => output.push(String(d)))
  const exited = new Promise((r) => app.process().once('exit', (code, signal) => r({ code, signal })))
  const page = (part) =>
    until(() => app.windows().find((p) => p.url().includes(part)), { timeout: 30_000, what: `the ${part} window` })
  const main = await page('index.html')
  await main.waitForSelector('.app', { timeout: 30_000 })
  await recorders(main)
  const ctx = {
    app,
    main,
    userData,
    output,
    exited,
    page,
    async close() {
      const quit = app.close().catch(() => undefined)
      const result = await Promise.race([exited, sleep(20_000).then(() => null)])
      if (!result) {
        app.process().kill('SIGKILL')
        await quit
        return { code: null, signal: 'SIGKILL (did not quit within 20 s)' }
      }
      await quit
      return result
    }
  }
  return ctx
}

/** Records chat events and assistant states in a renderer page. */
async function recorders(page) {
  await page.evaluate(() => {
    if (window.__e2e) return
    const rec = (window.__e2e = { chat: [], states: [] })
    window.jarvis.chats.onEvent((e) => rec.chat.push(e))
    window.jarvis.assistant.onState((s) =>
      rec.states.push({
        phase: s.phase,
        toolTitle: s.toolTitle,
        transcript: s.transcript,
        response: (s.response ?? '').slice(0, 300),
        error: s.error,
        engineError: s.engineError,
        wakeActive: s.wakeActive,
        turnId: s.turnId,
        at: Date.now()
      })
    )
  })
}

const recorded = (page) => page.evaluate(() => structuredClone(window.__e2e))

/** Collapses consecutive duplicates: ['a','a','b'] -> ['a','b']. */
const collapse = (list) => list.filter((v, i) => i === 0 || v !== list[i - 1])

function isSubsequence(list, wanted) {
  let at = 0
  for (const item of list) if (item === wanted[at]) at++
  return at === wanted.length
}

async function windowsInfo(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      kind: new URL(w.webContents.getURL() || 'about:blank').searchParams.get('window') ?? '?',
      visible: w.isVisible(),
      focused: w.isFocused(),
      bounds: w.getBounds()
    }))
  )
}

/** Health check of the main log: no crashes, no uncaught errors (`allow` exempts expected lines). */
function healthCheck(sc, ctx, allow = null) {
  const text = mainLog(ctx.userData)
  const bad = text
    .split('\n')
    .filter((l) => /uncaught exception|unhandled rejection|renderer gone|preload .* failed|failed to load|startup failed/i.test(l))
    .filter((l) => !allow || !allow.test(l))
  sc.check('main log has no crashes / uncaught errors', bad.length === 0, bad.slice(0, 3).join(' | '))
  const errors = text.split('\n').filter((l) => / ERROR /.test(l))
  if (errors.length) sc.fact(`main.log ERROR lines: ${errors.length} (first: ${short(errors[0], 200)})`)
  return text
}

async function shot(page, file) {
  const path = join(ARTIFACTS, file)
  await page.screenshot({ path })
  return path
}

/** Sends a text through the composer like a user (fill + Enter). */
async function typeAndSend(main, text) {
  const input = main.locator('.composer-input')
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

/** Waits until the main page saw `count` turn-end / turn-error events. */
async function waitTurns(main, count, timeout = 30_000) {
  return until(
    async () => {
      const rec = await recorded(main)
      const ends = rec.chat.filter((e) => e.type === 'turn-end' || e.type === 'turn-error')
      return ends.length >= count ? rec : null
    },
    { timeout, what: `${count} finished turn(s)` }
  )
}

async function waitResolved(main, terra = 'gpt-6.1-terra') {
  return until(
    async () => {
      const s = await main.evaluate(() => window.jarvis.settings.get())
      return s.resolvedModels.terra === terra ? s : null
    },
    { timeout: 20_000, what: `terra to resolve to ${terra}` }
  )
}

/** Turn-event bookkeeping for one turn: exactly one start / end, deltas add up to the final text. */
function checkTurnEvents(sc, rec, turnId, label) {
  const evs = rec.chat.filter((e) => e.turnId === turnId)
  const count = (type) => evs.filter((e) => e.type === type).length
  const end = evs.find((e) => e.type === 'turn-end')
  const deltas = evs.filter((e) => e.type === 'delta').map((e) => e.text).join('')
  sc.check(
    `${label}: one turn-start, one turn-end, deltas add up to the final text`,
    count('turn-start') === 1 && count('turn-end') === 1 && count('turn-error') === 0 && end && deltas === end.message.text,
    `start=${count('turn-start')} end=${count('turn-end')} deltas=${count('delta')} tool-start=${count('tool-start')} tool-end=${count('tool-end')}`
  )
  // chat-updated comes from the ChatStore only (deduplicated); the assistant never emits it.
  const updates = rec.chat.filter((e) => e.type === 'chat-updated').map((e) => JSON.stringify(e.chat))
  const dupes = updates.filter((u, i) => i > 0 && u === updates[i - 1]).length
  sc.check(`${label}: no duplicate chat-updated events`, dupes === 0, `${updates.length} chat-updated, ${dupes} duplicates`)
  return end
}

// ---------------------------------------------------------------------------------------------------
// S1 — text chat through the composer (Responses API)

async function s1(sc) {
  const mock = await startMockServer()
  const ctx = await launch({ name: 's1', mock })
  try {
    const { main, app } = ctx
    const settings = await waitResolved(main)
    sc.check(
      'auto tiers resolve to the newest models of GET /models',
      settings.resolvedModels.luna === 'gpt-6-luna' && settings.resolvedModels.terra === 'gpt-6.1-terra' && settings.resolvedModels.sol === 'gpt-6.1-sol',
      JSON.stringify(settings.resolvedModels)
    )
    const windowButtons = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=main'))
      return process.platform === 'darwin' ? win?.getWindowButtonPosition?.() ?? null : 'n/a'
    })
    if (process.platform === 'darwin') {
      sc.check('macOS traffic lights at { x: 18, y: 20 }', windowButtons?.x === 18 && windowButtons?.y === 20, JSON.stringify(windowButtons))
    }

    const from = mock.requests.length
    await typeAndSend(main, 'Сколько сейчас времени?')
    await main.locator('.msg--user .msg-bubble', { hasText: 'Сколько сейчас времени?' }).waitFor({ timeout: 10_000 })
    await main.locator('.msg--assistant .tool-chip--ok').first().waitFor({ timeout: 20_000 })
    const done = main.locator('.msg--assistant:not(.is-streaming)', { hasText: 'Сейчас' }).first()
    await done.waitFor({ timeout: 20_000 })
    const chipTitle = (await main.locator('.msg--assistant .tool-chip-title').first().textContent())?.trim()
    const chipSummary = (await main.locator('.msg--assistant .tool-chip-summary').first().textContent())?.trim()
    sc.check('tool chip "Смотрю дату и время" ✓ with a Russian summary', chipTitle === 'Смотрю дату и время' && /\d/.test(chipSummary ?? ''), `${chipTitle} · ${chipSummary}`)
    const answer = (await done.locator('.md').textContent())?.trim() ?? ''
    sc.check('final answer rendered with the tool output', /^Сейчас Local time: \d{4}-\d{2}-\d{2}T/.test(answer), answer)

    const turns = responsesTurns(mock, from)
    const [step1, step2] = turns.map((r) => r.json)
    sc.check('two model steps (tool call, answer)', turns.length === 2, `${turns.length} turn requests`)
    if (step1) {
      const fnTools = (step1.tools ?? []).filter((t) => t.type === 'function').map((t) => t.name)
      sc.check('step 1: store:false, stream:true', step1.store === false && step1.stream === true)
      sc.check('step 1: include reasoning.encrypted_content', JSON.stringify(step1.include) === '["reasoning.encrypted_content"]', JSON.stringify(step1.include))
      sc.check('step 1: function tools incl. get_datetime (strict:false)', fnTools.includes('get_datetime') && step1.tools.every((t) => t.type !== 'function' || t.strict === false), `${fnTools.length} functions`)
      sc.check('step 1: built-in web_search tool present', step1.tools.some((t) => t.type === 'web_search'))
      sc.check('step 1: browser search exposed as open_web_search', fnTools.includes('open_web_search') && !fnTools.includes('web_search'))
      sc.check('step 1: default tier model gpt-6.1-terra, effort low', step1.model === 'gpt-6.1-terra' && step1.reasoning?.effort === 'low', `${step1.model} ${JSON.stringify(step1.reasoning)}`)
      sc.check('step 1: Russian persona instructions + user text', /J\.A\.R\.V\.I\.S\./.test(step1.instructions) && lastUserText(step1.input) === 'Сколько сейчас времени?')
      sc.fact(`step 1: model=${step1.model}, ${fnTools.length} function tools, tool_choice=${step1.tool_choice}`)
    }
    if (step2) {
      const reasoning = step2.input.find((i) => i.type === 'reasoning')
      const call = step2.input.find((i) => i.type === 'function_call')
      const output = step2.input.find((i) => i.type === 'function_call_output')
      sc.check('step 2: reasoning item replayed verbatim (encrypted_content)', reasoning?.id === `rs_${turnIndex(mock, step1)}` && reasoning?.encrypted_content?.startsWith('enc_'), JSON.stringify(reasoning))
      sc.check('step 2: function_call replayed + function_call_output for its call_id', call?.name === 'get_datetime' && output?.call_id === call?.call_id && /^Local time:/.test(output?.output ?? ''), short(output))
    }

    const rec = await waitTurns(main, 1)
    const start = rec.chat.find((e) => e.type === 'turn-start')
    const end = checkTurnEvents(sc, rec, start?.turnId, 'S1 turn')
    sc.check('tool-start / tool-end carry the registry name and title', rec.chat.filter((e) => e.type === 'tool-end').every((e) => e.call.name === 'get_datetime' && e.call.status === 'ok'))
    sc.check('assistant message persisted with model + tier', end?.message.model === 'gpt-6.1-terra' && end?.message.tier === 'terra' && end?.message.status === 'done')
    const phases = collapse(rec.states.filter((s) => s.turnId === start?.turnId).map((s) => s.phase))
    sc.check('assistant phases thinking → acting → thinking → idle', isSubsequence(phases, ['thinking', 'acting', 'thinking', 'idle']) && phases.at(-1) === 'idle', phases.join(' → '))

    // Title from the Luna tier ("Проверка связи" from the mock).
    await main.locator('.sb-item-title', { hasText: 'Проверка связи' }).first().waitFor({ timeout: 10_000 })
    const title = titleRequests(mock, from)[0]?.json
    sc.check('chat titled by Luna without tools', title?.model === 'gpt-6-luna' && !title?.tools, `${title?.model}`)
    sc.fact(`main window screenshot: ${await shot(main, 's1-main.png')}`)
    await traffic(sc, main)

    // Image pasted into the composer → MediaStore → jarvis-media thumbnail → input_image for the model.
    await main.locator('.composer-input').click()
    await main.evaluate((bytes) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(bytes)], 'test.png', { type: 'image/png' }))
      document.querySelector('.composer-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, [...makePng(64, 40)])
    await main.locator('.composer-attachments .att img').waitFor({ timeout: 10_000 })
    const fromImage = mock.requests.length
    await typeAndSend(main, 'Что на картинке?')
    const thumb = main.locator('.msg--user .img-thumb img').first()
    await thumb.waitFor({ timeout: 10_000 })
    await until(() => thumb.evaluate((img) => img.complete && img.naturalWidth === 64), { timeout: 5000, what: 'thumbnail loaded' })
    await waitTurns(main, 2)
    const imageBody = responsesTurns(mock, fromImage)[0]?.json
    const lastUser = imageBody?.input.at(-1)
    const part = lastUser?.content?.find((p) => p.type === 'input_image')
    sc.check('pasted image: thumbnail via jarvis-media:// + input_image (data URL, detail high)', part?.image_url?.startsWith('data:image/png;base64,') && part.detail === 'high' && lastUser.content.some((p) => p.type === 'input_text' && p.text === 'Что на картинке?'), short(part?.image_url, 40))
    const history = imageBody?.input ?? []
    sc.check('history: earlier tool call summarized as text, never replayed as items', !history.some((i) => i.type === 'function_call' || i.type === 'reasoning') && history.some((i) => i.role === 'assistant' && /^\[Действия: Смотрю дату и время/.test(i.content)), short(history.find((i) => i.role === 'assistant')?.content, 80))

    // withUiHidden: the callback runs only once every visible Jarvis window is gone; focus comes back.
    const hidden = await app.evaluate(async ({ BrowserWindow }) => {
      const hook = globalThis.__jarvisE2E
      const kind = (w) => new URL(w.webContents.getURL()).searchParams.get('window')
      const snapshot = () => BrowserWindow.getAllWindows().map((w) => ({ kind: kind(w), visible: w.isVisible(), focused: w.isFocused() }))
      hook.windows.showOverlay()
      await new Promise((r) => setTimeout(r, 600))
      const before = snapshot()
      const events = []
      const t0 = Date.now()
      for (const w of BrowserWindow.getAllWindows()) w.once('hide', () => events.push({ kind: kind(w), at: Date.now() - t0 }))
      let during = null
      await hook.windows.withUiHidden(async () => {
        during = { at: Date.now() - t0, windows: snapshot(), events: [...events] }
      })
      await new Promise((r) => setTimeout(r, 400))
      return { before, during, after: snapshot() }
    })
    const shownBefore = hidden.before.filter((w) => w.visible).map((w) => w.kind)
    sc.check('withUiHidden: main + overlay visible before', shownBefore.includes('main') && shownBefore.includes('overlay'), JSON.stringify(hidden.before))
    // macOS reports 'hide' once the window server took the window off screen (occlusion change). On a
    // sleeping / locked display no such event comes and the 500 ms timeout applies instead.
    const allEvents = shownBefore.every((k) => hidden.during.events.some((e) => e.kind === k))
    sc.check(
      'withUiHidden: callback runs after every window reported hide (+ compositor delay)',
      hidden.during.windows.every((w) => !w.visible) &&
        (allEvents ? hidden.during.events.every((e) => e.at <= hidden.during.at) && hidden.during.at >= Math.max(...hidden.during.events.map((e) => e.at)) + 80 : hidden.during.at >= 500),
      `capture at ${hidden.during.at} ms, hide events ${JSON.stringify(hidden.during.events)}${allEvents ? '' : ' (no occlusion events: timeout path)'}`
    )
    const mainBefore = hidden.before.find((w) => w.kind === 'main')
    const mainAfter = hidden.after.find((w) => w.kind === 'main')
    sc.check('withUiHidden: main window restored with its focus state', mainAfter?.visible && mainAfter.focused === mainBefore?.focused, JSON.stringify(mainAfter))
    sc.check('withUiHidden: idle overlay is not brought back', !hidden.after.find((w) => w.kind === 'overlay')?.visible)

    // Settings → ИИ through a navigation request (tab ids shared with main).
    await main.evaluate(() => window.jarvis.app.showMain({ view: 'settings', settingsTab: 'ai' }))
    await main.locator('#set-tab-ai[aria-selected="true"]').waitFor({ timeout: 10_000 })
    const resolvedLabels = await main.locator('.tier-row-resolved').allTextContents()
    sc.check('Settings → ИИ shows the resolved models', resolvedLabels.join(',') === 'gpt-6-luna,gpt-6.1-terra,gpt-6.1-sol', resolvedLabels.join(', '))
    await main.locator('.tier-row select').first().waitFor()
    await sleep(300)
    sc.fact(`settings screenshot: ${await shot(main, 'settings-ai.png')}`)
    await main.evaluate(() => window.jarvis.app.showMain({ view: 'settings', settingsTab: 'activation' }))
    await main.locator('#set-tab-activation[aria-selected="true"]').waitFor({ timeout: 10_000 })
    sc.check('navigate settingsTab "activation" opens that tab', true)
    healthCheck(sc, ctx)
  } finally {
    const exit = await ctx.close()
    sc.check('app quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

/** The mock numbers its /responses calls; the reasoning id of a step is rs_<n>. */
function turnIndex(mock, body) {
  const all = mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1/responses')
  return all.findIndex((r) => r.json === body) + 1
}

/**
 * The native traffic lights are not part of the page capture (and the real screen must not be
 * captured), so their configured frames are drawn into the page before a header screenshot.
 */
async function traffic(sc, main) {
  if (process.platform !== 'darwin') return
  const path = join(ARTIFACTS, 's1-header-traffic-lights.png')
  await main.evaluate(() => {
    const layer = document.createElement('div')
    layer.id = 'e2e-traffic'
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:99999;pointer-events:none'
    // Window button frames for trafficLightPosition {x:18,y:20}: 14 px buttons, 20 px apart.
    for (const [i, color] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
      const b = document.createElement('div')
      b.style.cssText = `position:absolute;left:${18 + 1 + i * 20}px;top:${20 + 1}px;width:12px;height:12px;border-radius:50%;background:${color};box-shadow:0 0 0 0.5px rgba(0,0,0,.4)`
      layer.appendChild(b)
    }
    document.body.appendChild(layer)
  })
  await main.screenshot({ path, clip: { x: 0, y: 0, width: 720, height: 64 } })
  const geometry = await main.evaluate(() => {
    document.getElementById('e2e-traffic')?.remove()
    const header = document.querySelector('.chat-header')?.getBoundingClientRect()
    const brand = document.querySelector('.sb-head')?.getBoundingClientRect()
    const firstContent = document.querySelector('.sb-brand')?.getBoundingClientRect()
    return { headerH: header?.height, sbHeadH: brand?.height, brandLeft: firstContent?.left }
  })
  // Buttons span y 20..34 → centre 27 vs a 52 px header centre 26; the last button ends at x≈72 < 74.
  sc.check('header geometry fits the traffic lights (52 px header, content starts ≥ 74 px)', geometry.headerH === 52 && geometry.sbHeadH === 52 && geometry.brandLeft >= 74, JSON.stringify(geometry))
  sc.fact(`header + traffic-light frames: ${path}`)
}

// ---------------------------------------------------------------------------------------------------
// S2 — tier switch in the chat header

async function s2(sc) {
  const mock = await startMockServer()
  const ctx = await launch({ name: 's2', mock })
  try {
    const { main } = ctx
    await waitResolved(main)
    // Draft chat: pick Sol in the header, then send.
    await main.locator('.chat-header .tier-seg--sol').click()
    await main.locator('.chat-header .tier-seg--sol[aria-checked="true"]').waitFor({ timeout: 5000 })
    let from = mock.requests.length
    await typeAndSend(main, 'Расскажи анекдот')
    await waitTurns(main, 1)
    const sol = responsesTurns(mock, from)[0]?.json
    sc.check('Sol → request model gpt-6.1-sol (effort medium)', sol?.model === 'gpt-6.1-sol' && sol?.reasoning?.effort === 'medium', `${sol?.model} ${JSON.stringify(sol?.reasoning)}`)
    const rec1 = await recorded(main)
    const chatId = rec1.chat.find((e) => e.type === 'turn-start')?.chatId
    let summary = (await main.evaluate(() => window.jarvis.chats.list())).find((c) => c.id === chatId)
    sc.check('new chat created with tier sol', summary?.tier === 'sol', summary?.tier)

    // Existing chat: switch to Luna in the header, send again.
    await main.locator('.chat-header .tier-seg--luna').click()
    await main.locator('.chat-header .tier-seg--luna[aria-checked="true"]').waitFor({ timeout: 5000 })
    await until(async () => (await main.evaluate((id) => window.jarvis.chats.get(id), chatId))?.tier === 'luna', { what: 'chat tier luna' })
    from = mock.requests.length
    await typeAndSend(main, 'А ещё один?')
    await waitTurns(main, 2)
    const luna = responsesTurns(mock, from)[0]?.json
    sc.check('Luna → request model gpt-6-luna (effort low)', luna?.model === 'gpt-6-luna' && luna?.reasoning?.effort === 'low', `${luna?.model} ${JSON.stringify(luna?.reasoning)}`)
    sc.check('second turn went to the same chat with history', luna && luna.input.filter((i) => i.role === 'user').length === 2 && luna.input.some((i) => i.role === 'assistant'), `${luna?.input.length} input items`)
    const chat = await main.evaluate((id) => window.jarvis.chats.get(id), chatId)
    sc.check('assistant messages keep their model per turn', chat.messages.filter((m) => m.role === 'assistant').map((m) => m.model).join(',') === 'gpt-6.1-sol,gpt-6-luna', chat.messages.map((m) => m.model ?? '-').join(','))
    // Title: "Проверка связи" from the mock (or the 48-char truncation fallback).
    summary = await until(async () => (await main.evaluate(() => window.jarvis.chats.list())).find((c) => c.id === chatId && c.title !== 'Новый чат'), { what: 'chat title' })
    sc.check('chat title generated', summary.title === 'Проверка связи' || summary.title === 'Расскажи анекдот', summary.title)
    sc.check('title generated once', titleRequests(mock).length === 1, `${titleRequests(mock).length} title requests`)
    const shown = (await main.locator('.chat-header .chat-title-text').textContent())?.trim()
    sc.check('header shows the new title', shown === summary.title, shown)

    // Composer dictation: main-window mic (fake device) → MediaRecorder → speech.transcribe → composer text.
    mock.config.transcript = 'Привет из диктовки'
    await main.getByRole('button', { name: 'Диктовка' }).click()
    await main.locator('.dictation-actions .btn--primary:not([disabled])').waitFor({ timeout: 10_000 })
    await sleep(1200)
    await main.locator('.dictation-actions .btn--primary').click()
    await until(async () => (await main.locator('.composer-input').inputValue()) === 'Привет из диктовки', { what: 'dictated text in the composer' })
    const dictated = mock.requests.filter((r) => r.path === '/v1/audio/transcriptions').at(-1)
    sc.check('dictation: recorded audio transcribed into the composer', dictated?.fields?.file?.filename === 'audio.webm' && dictated.fields.file.bytes > 200 && dictated.fields.model === 'gpt-4o-mini-transcribe', JSON.stringify(dictated?.fields?.file))
    await main.locator('.composer-input').fill('')

    // Stop button while the reply streams.
    mock.config.sseDelayMs = 300
    await typeAndSend(main, 'Расскажи длинную историю про Тони Старка')
    await main.locator('.msg--assistant.is-streaming .md').first().waitFor({ timeout: 15_000 })
    await main.locator('.send-btn--stop').click()
    const recCancel = await waitTurns(main, 3)
    mock.config.sseDelayMs = 0
    const cancelled = recCancel.chat.filter((e) => e.type === 'turn-end').at(-1)
    sc.check('stop button cancels the turn, partial text kept', cancelled?.message.status === 'cancelled' && cancelled.message.text.length > 0 && !cancelled.message.text.includes('Старка'), short(cancelled?.message.text, 60))
    await main.locator('.msg-note', { hasText: 'Ответ остановлен' }).waitFor({ timeout: 5000 })
    const afterCancel = await until(async () => ((await recorded(main)).states.at(-1)?.phase === 'idle' ? true : null), { timeout: 5000, what: 'idle after cancel' })
    sc.check('UI shows "Ответ остановлен", assistant idle again', afterCancel)
    const stored = await main.evaluate((id) => window.jarvis.chats.get(id), chatId)
    sc.check('cancelled message persisted', stored.messages.at(-1).status === 'cancelled')
    await until(async () => !(await windowsInfo(ctx.app)).find((w) => w.kind === 'overlay')?.visible, { timeout: 12_000, what: 'overlay hidden after the cancel' })
    sc.check('overlay hides after the cancelled turn', true)
    healthCheck(sc, ctx)
  } finally {
    const exit = await ctx.close()
    sc.check('app quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

// ---------------------------------------------------------------------------------------------------
// S3 — voice: fake microphone → local Whisper wake word → cloud STT → assistant → TTS

async function s3(sc) {
  const wav = join(ARTIFACTS, 'mic-time.wav')
  if (!existsSync(wav)) makeFakeMicWav(wav, VOICE_PHRASE, 'Milena', 2, 45)
  const mock = await startMockServer()
  const ctx = await launch({ name: 's3', mock, micWav: wav })
  try {
    const { main, app } = ctx
    const overlay = await ctx.page('overlay.html')
    await recorders(overlay)
    await waitResolved(main)

    // Wake engine up (Whisper loaded in the voice window, fake mic live).
    const ready = await until(async () => (await main.evaluate(() => window.jarvis.assistant.getState())).wakeActive, { timeout: 30_000, what: 'wakeActive' })
    sc.check('wake engine active (local Whisper + fake mic)', ready)

    const stt = await until(() => mock.requests.find((r) => r.path === '/v1/audio/transcriptions'), { timeout: 40_000, what: 'POST /v1/audio/transcriptions' })
    sc.check('wake word detected locally → command sent to /v1/audio/transcriptions', stt.fields?.file?.bytes > 20_000 && stt.fields?.model === 'gpt-4o-mini-transcribe', `model=${stt.fields?.model} file=${stt.fields?.file?.filename} ${stt.fields?.file?.bytes} B, prompt=${short(stt.fields?.prompt, 60)}`)
    const turn = await until(() => responsesTurns(mock).find((r) => lastUserText(r.json.input) === 'сколько сейчас времени?'), { timeout: 15_000, what: 'the voice command at /v1/responses' })
    sc.check('/v1/responses got the transcribed command without the wake word', !!turn, lastUserText(turn.json.input))
    sc.check('voice turn uses the spoken-reply persona and voiceTier model', /spoken/i.test(turn.json.instructions) && turn.json.model === 'gpt-6.1-terra', turn.json.model)

    // Overlay while the reply is on screen.
    await until(async () => {
      const s = (await recorded(overlay)).states.at(-1)
      return s && s.response && /Сейчас/.test(s.response)
    }, { timeout: 20_000, what: 'the reply in the overlay' })
    const overlayWin = (await windowsInfo(app)).find((w) => w.kind === 'overlay')
    sc.check('overlay visible during the voice turn', overlayWin?.visible, JSON.stringify(overlayWin?.bounds))
    await sleep(250)
    sc.fact(`overlay screenshot: ${await shot(overlay, 's3-overlay.png')}`)

    const speech = await until(() => mock.requests.find((r) => r.path === '/v1/audio/speech'), { timeout: 15_000, what: 'POST /v1/audio/speech' })
    sc.check('reply synthesized via /v1/audio/speech (onyx, gpt-4o-mini-tts, style instructions)', speech.json?.model === 'gpt-4o-mini-tts' && speech.json?.voice === 'onyx' && /British/.test(speech.json?.instructions ?? '') && /^Сейчас/.test(speech.json?.input ?? ''), short(speech.json?.input, 80))

    // Follow-up window after the reply: the HUD is still up; clicking it opens the voice chat.
    await until(async () => (await recorded(main)).states.at(-1)?.phase === 'listening', { timeout: 20_000, what: 'follow-up listening' })
    await main.locator('.sb-new').click()
    await main.locator('.msg--user').first().waitFor({ state: 'detached', timeout: 5000 })
    await overlay.locator('.ov-panel').click()
    await main.locator('.msg--user .msg-bubble', { hasText: 'сколько сейчас времени?' }).waitFor({ timeout: 10_000 })
    sc.check('clicking the overlay opens the voice chat in the main window', true)

    // Speech finished → follow-up window → idle.
    const rec = await until(async () => {
      const r = await recorded(main)
      const phases = collapse(r.states.map((s) => s.phase))
      const spoke = phases.lastIndexOf('speaking')
      return spoke >= 0 && phases.at(-1) === 'idle' && spoke < phases.length - 1 ? r : null
    }, { timeout: 30_000, what: 'speaking → idle' })
    const phases = collapse(rec.states.map((s) => s.phase))
    sc.check(
      'phases: transcribing → thinking → acting → thinking/speaking → … → idle',
      isSubsequence(phases, ['transcribing', 'thinking', 'acting', 'speaking', 'idle']) && !phases.includes('error'),
      phases.join(' → ')
    )
    const acting = rec.states.find((s) => s.phase === 'acting')
    sc.check('acting state shows the tool title', acting?.toolTitle === 'Смотрю дату и время', acting?.toolTitle)
    const voiceLog = mainLog(ctx.userData)
    sc.check('voice engine logged the wake word and the submitted command', /Wake word "[^"]+" heard/.test(voiceLog) && /Voice command sent/.test(voiceLog))

    const chats = await main.evaluate(() => window.jarvis.chats.list())
    const voiceChat = chats.find((c) => c.source === 'voice')
    const chat = voiceChat ? await main.evaluate((id) => window.jarvis.chats.get(id), voiceChat.id) : null
    const [user, reply] = chat?.messages ?? []
    sc.check('voice chat (source voice) with both messages', user?.text === 'сколько сейчас времени?' && user?.source === 'voice' && reply?.status === 'done' && /^Сейчас/.test(reply?.text ?? ''), `${voiceChat?.title}: ${short(user?.text, 40)} / ${short(reply?.text, 60)}`)
    const end = rec.chat.find((e) => e.type === 'turn-end')
    checkTurnEvents(sc, rec, end?.turnId, 'S3 turn')
    sc.check('main window followed the voice chat', (await main.locator('.msg--user .msg-bubble', { hasText: 'сколько сейчас времени?' }).count()) === 1)

    // The HUD hides by itself ~5 s after idle (never stuck).
    await until(async () => !(await windowsInfo(app)).find((w) => w.kind === 'overlay')?.visible, { timeout: 15_000, what: 'overlay auto-hide' })
    sc.check('overlay auto-hides after idle', true)
    sc.check('exactly one voice turn', responsesTurns(mock).filter((r) => lastUserText(r.json.input) === 'сколько сейчас времени?' && !r.json.input.some((i) => i.type === 'function_call_output')).length === 1)

    // Wake pill in the sidebar: off (mic released) and back on (remembered engine).
    await main.locator('.wake-pill').click()
    await until(async () => {
      const st = await main.evaluate(() => window.jarvis.assistant.getState())
      const s = await main.evaluate(() => window.jarvis.settings.get())
      return s.wakeEngine === 'off' && !st.wakeActive
    }, { timeout: 10_000, what: 'wake engine off' })
    await until(() => /Microphone off/.test(mainLog(ctx.userData)), { timeout: 10_000, what: 'microphone released' })
    sc.check('wake pill: off → engine stopped, microphone released', true)
    await main.locator('.wake-pill').click()
    const back = await until(async () => {
      const st = await main.evaluate(() => window.jarvis.assistant.getState())
      const s = await main.evaluate(() => window.jarvis.settings.get())
      return s.wakeEngine === 'local' && st.wakeActive ? s : null
    }, { timeout: 20_000, what: 'wake engine back on' })
    sc.check('wake pill: on → local engine listening again', back.wakeEngine === 'local')
    healthCheck(sc, ctx)
  } finally {
    const exit = await ctx.close()
    sc.check('app quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

// ---------------------------------------------------------------------------------------------------
// S4 — ElevenLabs voice provider

async function s4(sc) {
  const mock = await startMockServer()
  const ctx = await launch({ name: 's4', mock })
  try {
    const { main } = ctx
    const noKey = await main.evaluate(() => window.jarvis.speech.listElevenLabsVoices())
    sc.check('without a key: Russian error, no request', noKey.voices.length === 0 && /ElevenLabs/.test(noKey.error ?? '') && !mock.requests.some((r) => r.path === '/v1/voices'), noKey.error)
    let s = await main.evaluate(() => window.jarvis.settings.setElevenLabsKey('xi-e2e-key-778899'))
    sc.check('key stored, only a masked hint reaches the renderer', s.hasElevenLabsKey && s.elevenLabsKeyHint && !JSON.stringify(s).includes('xi-e2e-key-778899'), s.elevenLabsKeyHint)
    s = await main.evaluate(() =>
      window.jarvis.settings.update({ ttsProvider: 'elevenlabs', elevenVoiceId: 'voice123', elevenModel: 'eleven_flash_v2_5', elevenStability: 0.4, elevenSimilarity: 0.8, ttsSpeed: 1.5 })
    )
    sc.check('settings switched to ElevenLabs', s.ttsProvider === 'elevenlabs' && s.elevenVoiceId === 'voice123')

    const voices = await main.evaluate(() => window.jarvis.speech.listElevenLabsVoices())
    const v = voices.voices[0]
    sc.check('listElevenLabsVoices() → Test Butler', voices.voices.length === 1 && v.id === 'voice123' && v.name === 'Test Butler' && /male/.test(v.description ?? ''), JSON.stringify(voices))
    const list = mock.requests.find((r) => r.path === '/v1/voices')
    sc.check('GET /v1/voices with xi-api-key', list?.headers['xi-api-key'] === 'xi-e2e-key-778899' && !list?.headers.authorization)

    const out = await main.evaluate(async () => {
      const r = await window.jarvis.speech.synthesize('Добрый вечер, сэр.')
      return { bytes: r.audio.byteLength, mime: r.mime }
    })
    const tts = mock.requests.find((r) => r.path === '/v1/text-to-speech/voice123')
    sc.check('synthesize() → POST /v1/text-to-speech/voice123?output_format=mp3_44100_128', tts?.method === 'POST' && tts.search === '?output_format=mp3_44100_128', `${tts?.path}${tts?.search}`)
    sc.check('ElevenLabs request: xi-api-key, no OpenAI bearer', tts?.headers['xi-api-key'] === 'xi-e2e-key-778899' && !tts?.headers.authorization)
    sc.check(
      'ElevenLabs body: text, model_id, voice_settings (speed clamped to 1.2)',
      tts?.json?.text === 'Добрый вечер, сэр.' && tts.json.model_id === 'eleven_flash_v2_5' && tts.json.voice_settings?.stability === 0.4 && tts.json.voice_settings?.similarity_boost === 0.8 && tts.json.voice_settings?.speed === 1.2 && tts.json.voice_settings?.use_speaker_boost === true,
      JSON.stringify(tts?.json)
    )
    sc.check('audio returned to the renderer', out.bytes > 1000 && /^audio\//.test(out.mime), JSON.stringify(out))
    sc.check('nothing sent to OpenAI /audio/speech', !mock.requests.some((r) => r.path === '/v1/audio/speech'))

    // Replay through the voice window (speech.speak) also goes to ElevenLabs.
    const before = mock.requests.filter((r) => r.path.startsWith('/v1/text-to-speech/')).length
    await main.evaluate(() => window.jarvis.speech.speak('Проверка голоса Джарвиса.'))
    await until(() => mock.requests.filter((r) => r.path.startsWith('/v1/text-to-speech/')).length > before, { timeout: 10_000, what: 'voice window ElevenLabs request' })
    const rec = await until(async () => {
      const r = await recorded(main)
      const phases = collapse(r.states.map((x) => x.phase))
      return phases.includes('speaking') && phases.at(-1) === 'idle' ? r : null
    }, { timeout: 15_000, what: 'replay speaking → idle' })
    sc.check('speech.speak(): voice window played it (speaking → idle)', true, collapse(rec.states.map((x) => x.phase)).join(' → '))
    const speakingState = rec.states.find((x) => x.phase === 'speaking')
    sc.check('HUD shows the replayed text while speaking', speakingState?.response === 'Проверка голоса Джарвиса.', speakingState?.response)
    healthCheck(sc, ctx)
  } finally {
    const exit = await ctx.close()
    sc.check('app quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

// ---------------------------------------------------------------------------------------------------
// S5 — Chat Completions mode

async function s5(sc) {
  const mock = await startMockServer()
  const ctx = await launch({ name: 's5', mock })
  try {
    const { main } = ctx
    await waitResolved(main)
    const s = await main.evaluate(() => window.jarvis.settings.update({ apiMode: 'chat' }))
    sc.check('apiMode switched to chat', s.apiMode === 'chat')
    const from = mock.requests.length
    await typeAndSend(main, 'Сколько сейчас времени?')
    const done = main.locator('.msg--assistant:not(.is-streaming)', { hasText: 'Сейчас' }).first()
    await done.waitFor({ timeout: 20_000 })
    const turns = chatTurns(mock, from).map((r) => r.json)
    const [step1, step2] = turns
    sc.check('two /v1/chat/completions steps, no /v1/responses', turns.length === 2 && responsesTurns(mock, from).length === 0, `${turns.length} chat steps`)
    const fnNames = (step1?.tools ?? []).map((t) => t.function?.name)
    sc.check('step 1: system persona, function tools incl. get_datetime, stream', step1?.messages[0].role === 'system' && fnNames.includes('get_datetime') && step1.stream === true && !(step1.tools ?? []).some((t) => t.type === 'web_search'), `${fnNames.length} tools`)
    sc.check('step 1: model gpt-6.1-terra, reasoning_effort low', step1?.model === 'gpt-6.1-terra' && step1.reasoning_effort === 'low', `${step1?.model} ${step1?.reasoning_effort}`)
    sc.check('step 1: browser search keeps its name web_search (no built-in search here)', fnNames.includes('web_search') && !fnNames.includes('open_web_search'))
    const call = step2?.messages.find((m) => m.role === 'assistant' && m.tool_calls)
    const tool = step2?.messages.find((m) => m.role === 'tool')
    sc.check('step 2: assistant tool_calls + tool message with the output', call?.tool_calls[0].function.name === 'get_datetime' && tool?.tool_call_id === call?.tool_calls[0].id && /^Local time:/.test(tool?.content ?? ''), short(tool))
    const chipTitle = (await main.locator('.msg--assistant .tool-chip-title').first().textContent())?.trim()
    sc.check('tool chip + answer in the UI', chipTitle === 'Смотрю дату и время' && /^Сейчас Local time/.test((await done.locator('.md').textContent())?.trim() ?? ''), chipTitle)
    const rec = await waitTurns(main, 1)
    checkTurnEvents(sc, rec, rec.chat.find((e) => e.type === 'turn-start')?.turnId, 'S5 turn')
    const title = titleRequests(mock, from)[0]
    sc.check('title request also through /chat/completions', title?.path === '/v1/chat/completions' && title.json.model === 'gpt-6-luna', title?.path)

    // Computer control off: only the harmless tools are offered (reminders stay manageable).
    await main.evaluate(() => window.jarvis.settings.update({ computerControl: false }))
    const from2 = mock.requests.length
    const chatId = rec.chat.find((e) => e.type === 'turn-start').chatId
    await main.evaluate((id) => window.jarvis.chats.send({ chatId: id, text: 'Какие у меня напоминания?' }), chatId)
    await waitTurns(main, 2)
    const offBody = chatTurns(mock, from2)[0]?.json
    const offTools = (offBody?.tools ?? []).map((t) => t.function?.name)
    sc.check('computer control off → only harmless tools', offTools.join(',') === 'get_system_info,get_datetime,set_reminder,list_reminders,cancel_reminder', offTools.join(','))
    sc.check('persona says computer control is off', /Computer control is turned off/.test(offBody?.messages[0].content ?? ''))
    healthCheck(sc, ctx)
  } finally {
    const exit = await ctx.close()
    sc.check('app quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

// ---------------------------------------------------------------------------------------------------
// S6 — persistence across restarts (key entered in the UI, no env key)

async function s6(sc) {
  const mock = await startMockServer()
  const userData = freshUserData('s6')
  const key = 'sk-e2e-persist-AbCd1234'
  let ctx = await launch({ name: 's6', mock, userData, apiKey: null })
  let chatIds = []
  try {
    const { main, app } = ctx
    let s = await main.evaluate(() => window.jarvis.settings.get())
    sc.check('first run without a key: onboarding card', !s.hasApiKey && (await main.locator('.onboard').count()) === 1)
    // App menu "Настройки…" without a key opens Settings → ИИ.
    if (process.platform === 'darwin') {
      await app.evaluate(({ Menu }) => {
        const find = (items) => {
          for (const item of items) {
            if (item.label === 'Настройки…') return item
            const sub = item.submenu && find(item.submenu.items)
            if (sub) return sub
          }
          return null
        }
        find(Menu.getApplicationMenu().items)?.click()
      })
      await main.locator('#set-tab-ai[aria-selected="true"]').waitFor({ timeout: 10_000 })
      sc.check('app menu "Настройки…" without a key → Settings → ИИ', true)
      await main.keyboard.press('Escape')
      await main.locator('.onboard').waitFor({ timeout: 5000 })
    }
    // A request without a key (e.g. a voice command) fails; the HUD click leads to Settings → ИИ.
    const overlay = await ctx.page('overlay.html')
    const failed = await main.evaluate(() => window.jarvis.chats.send({ text: 'Привет без ключа' }))
    const noKeyState = await until(async () => {
      const st = await main.evaluate(() => window.jarvis.assistant.getState())
      return st.phase === 'error' ? st : null
    }, { timeout: 10_000, what: 'no-key error state' })
    sc.check('no key → Russian error state', noKeyState.error === 'Не задан API-ключ OpenAI. Откройте Настройки → ИИ.', noKeyState.error)
    await overlay.locator('.ov-panel.ov-panel--error').waitFor({ timeout: 5000 })
    await overlay.locator('.ov-panel').click()
    await main.locator('#set-tab-ai[aria-selected="true"]').waitFor({ timeout: 10_000 })
    sc.check('clicking the error HUD without a key opens Settings → ИИ', true)
    await main.evaluate((id) => window.jarvis.chats.remove(id), failed.chatId)
    await main.keyboard.press('Escape')
    await main.locator('.onboard').waitFor({ timeout: 5000 })

    await main.locator('.onboard-form input').fill(key)
    await main.locator('.onboard-form button[type="submit"]').click()
    s = await until(async () => {
      const x = await main.evaluate(() => window.jarvis.settings.get())
      return x.hasApiKey && x.resolvedModels.terra === 'gpt-6.1-terra' ? x : null
    }, { what: 'key saved + models refreshed' })
    sc.check('key saved from the onboarding form, models refreshed with it', s.apiKeyHint.endsWith('1234') && mock.requests.some((r) => r.path === '/v1/models' && r.headers.authorization === `Bearer ${key}`), s.apiKeyHint)

    await typeAndSend(main, 'Привет, Джарвис')
    await main.locator('.msg--assistant:not(.is-streaming)', { hasText: 'Тестовый ответ Джарвиса: Привет, Джарвис' }).waitFor({ timeout: 20_000 })
    const second = await main.evaluate(() => window.jarvis.chats.send({ text: 'Сколько сейчас времени?' }))
    await waitTurns(main, 2)
    const first = (await recorded(main)).chat.find((e) => e.type === 'turn-start' && e.userMessage.text === 'Привет, Джарвис').chatId
    chatIds = [first, second.chatId]
    await until(async () => (await main.evaluate(() => window.jarvis.chats.list())).every((c) => c.title !== 'Новый чат'), { what: 'titles' })
    // Rename through the header title editor (the first chat is the one on screen).
    await main.locator('.chat-header .chat-title-btn').click()
    await main.locator('.chat-header .chat-title-input').fill('Мой первый чат')
    await main.locator('.chat-header .chat-title-input').press('Enter')
    await until(async () => (await main.evaluate((id) => window.jarvis.chats.get(id), first))?.title === 'Мой первый чат', { what: 'rename via the header' })
    s = await main.evaluate(() => window.jarvis.settings.update({ defaultTier: 'sol', ttsVoice: 'ash', userTitle: 'босс', webSearch: false, followUpSeconds: 4 }))
    sc.check('settings changed', s.defaultTier === 'sol' && s.userTitle === 'босс')
    const exit = await ctx.close()
    sc.check('first run quits cleanly', exit.code === 0, JSON.stringify(exit))

    const stored = readFileSync(join(userData, 'settings.json'), 'utf8')
    const secrets = readFileSync(join(userData, 'secrets.json'), 'utf8')
    // E2E mode never touches the Keychain: the key is stored with the documented "plain:" prefix.
    sc.check('settings.json has no secret; secrets.json holds it (plain: in E2E mode)', !stored.includes(key) && JSON.parse(secrets).openaiApiKey === `plain:${key}`, short(secrets, 80))
    sc.check('the key never appears in main.log', !mainLog(userData).includes(key))
  } catch (err) {
    await ctx.close().catch(() => undefined)
    throw err
  }

  // Second launch, same userData, still no env key.
  ctx = await launch({ name: 's6', mock, userData, apiKey: null })
  try {
    const { main } = ctx
    const s = await main.evaluate(() => window.jarvis.settings.get())
    sc.check('key survived (hasApiKey + hint)', s.hasApiKey && s.apiKeyHint.endsWith('1234'), s.apiKeyHint)
    sc.check('settings survived', s.defaultTier === 'sol' && s.ttsVoice === 'ash' && s.userTitle === 'босс' && s.webSearch === false && s.followUpSeconds === 4, JSON.stringify({ defaultTier: s.defaultTier, ttsVoice: s.ttsVoice, userTitle: s.userTitle, webSearch: s.webSearch, followUpSeconds: s.followUpSeconds }))
    const list = await main.evaluate(() => window.jarvis.chats.list())
    sc.check('both chats survived', list.length === 2 && chatIds.every((id) => list.some((c) => c.id === id)), list.map((c) => c.title).join(' | '))
    sc.check('renamed title survived', list.find((c) => c.id === chatIds[0])?.title === 'Мой первый чат')
    const chats = await Promise.all(chatIds.map((id) => main.evaluate((x) => window.jarvis.chats.get(x), id)))
    sc.check(
      'messages survived (user + done assistant in each chat)',
      chats.every((c) => c.messages.length === 2 && c.messages[1].status === 'done' && c.messages[1].text.length > 0),
      chats.map((c) => c.messages.map((m) => `${m.role}:${m.status ?? ''}`).join('/')).join(' ; ')
    )
    sc.check('restored chat with tool call keeps its chip', chats[1].messages[1].toolCalls?.[0]?.name === 'get_datetime')
    await main.locator('.sb-item-title', { hasText: 'Мой первый чат' }).waitFor({ timeout: 10_000 })
    sc.check('sidebar lists the restored chats', (await main.locator('.sb-item').count()) === 2)
    // Sidebar search over restored titles and message text.
    await main.locator('#chat-search').fill('Local time')
    await until(async () => (await main.locator('.sb-item').count()) === 1, { timeout: 5000, what: 'search results' })
    sc.check('sidebar search finds the chat by message text', (await main.locator('.sb-item-title').first().textContent()) === 'Проверка связи')
    await main.locator('#chat-search').fill('')
    // The stored key is used after the restart; changed settings take effect.
    const from = mock.requests.length
    await main.evaluate((id) => window.jarvis.chats.send({ chatId: id, text: 'Ещё вопрос' }), chatIds[0])
    await waitTurns(main, 1)
    const body = responsesTurns(mock, from)[0]
    sc.check('stored key used after restart', body?.headers.authorization === `Bearer ${key}`)
    sc.check('restored settings take effect (no web_search, history replayed)', body && !body.json.tools.some((t) => t.type === 'web_search') && body.json.input.length === 3, `${body?.json.input.length} input items`)
    healthCheck(sc, ctx)
  } finally {
    const exit = await ctx.close()
    sc.check('second run quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

// ---------------------------------------------------------------------------------------------------
// S7 — wrong key: Russian error card, app stays healthy and recovers

async function s7(sc) {
  const mock = await startMockServer()
  const bad = 'sk-e2e-wrong-key-0000'
  mock.config.badKeys.push(bad)
  const ctx = await launch({ name: 's7', mock, apiKey: bad })
  try {
    const { main } = ctx
    await until(() => mock.requests.some((r) => r.path === '/v1/models'), { what: 'GET /v1/models' })
    const s = await main.evaluate(() => window.jarvis.settings.get())
    sc.check('models fall back when /models is 401', s.resolvedModels.terra === 'gpt-5.6-terra', JSON.stringify(s.resolvedModels))
    const from = mock.requests.length
    await typeAndSend(main, 'Привет')
    const card = main.locator('.msg-error')
    await card.waitFor({ timeout: 20_000 })
    const text = (await card.locator('.msg-error-text').textContent())?.trim()
    sc.check('Russian error card (401)', text === 'API-ключ OpenAI недействителен или отозван (401). Проверьте ключ в Настройках → ИИ.', text)
    sc.check('error card title + retry button', (await card.locator('.msg-error-title').textContent()) === 'Не удалось получить ответ' && (await card.getByRole('button', { name: 'Повторить' }).count()) === 1)
    sc.check('401 is not retried', responsesTurns(mock, from).length === 1, `${responsesTurns(mock, from).length} requests`)
    const rec = await recorded(main)
    const errorEv = rec.chat.find((e) => e.type === 'turn-error')
    sc.check('turn-error event with the message', errorEv?.error === text)
    const state = await until(async () => {
      const st = (await recorded(main)).states
      return st.some((x) => x.phase === 'error') && st.at(-1)?.phase === 'idle' ? st : null
    }, { timeout: 15_000, what: 'error → idle' })
    const errorAt = state.find((x) => x.phase === 'error').at
    const idleAt = state.findLast((x) => x.phase === 'idle').at
    // The error stays on the HUD until the assistant's reset (8 s), whatever the voice engine reports meanwhile.
    sc.check('assistant state error → idle after the error reset (~8 s)', idleAt - errorAt >= 7500, `${collapse(state.map((x) => x.phase)).join(' → ')}, error shown ${idleAt - errorAt} ms`)
    const test = await main.evaluate(() => window.jarvis.models.test())
    sc.check('Проверить подключение: Russian 401 message', !test.ok && /401/.test(test.message), test.message)
    const chat = await main.evaluate((id) => window.jarvis.chats.get(id), errorEv.chatId)
    sc.check('error persisted on the message; fallback title from the text', chat.messages[1].status === 'error' && chat.messages[1].error === text && chat.title === 'Привет', `${chat.title}`)

    // Recovery: fix the key, press "Повторить".
    await main.evaluate(() => window.jarvis.settings.setApiKey('sk-e2e-good-key-1111'))
    await card.getByRole('button', { name: 'Повторить' }).click()
    await main.locator('.msg--assistant:not(.is-streaming)', { hasText: 'Тестовый ответ Джарвиса: Привет' }).waitFor({ timeout: 20_000 })
    const retry = responsesTurns(mock, from).at(-1)
    sc.check('retry succeeds with the new key', retry?.headers.authorization === 'Bearer sk-e2e-good-key-1111')
    const composerEnabled = await main.locator('.composer-input').isEditable()
    sc.check('composer usable after the error', composerEnabled)
    healthCheck(sc, ctx)
  } finally {
    const exit = await ctx.close()
    sc.check('app quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

// ---------------------------------------------------------------------------------------------------
// S8 — push-to-talk with the wake engine off (the mic opens only for the conversation)

async function s8(sc) {
  const wav = join(ARTIFACTS, 'mic-time.wav')
  if (!existsSync(wav)) makeFakeMicWav(wav, VOICE_PHRASE, 'Milena', 2, 45)
  const mock = await startMockServer()
  mock.config.transcript = 'Который сейчас час? Скажи время.'
  const userData = freshUserData('s8')
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ version: 1, wakeEngine: 'off', followUpSeconds: 0 }))
  const ctx = await launch({ name: 's8', mock, userData, micWav: wav })
  try {
    const { main, app } = ctx
    const overlay = await ctx.page('overlay.html')
    await waitResolved(main)
    await until(() => /INFO \[voice\] Voice engine started/.test(mainLog(userData)), { timeout: 20_000, what: 'voice engine start' })
    await sleep(1500)
    const idle = await main.evaluate(() => window.jarvis.assistant.getState())
    sc.check('wake engine off: not listening, microphone closed', !idle.wakeActive && !/Microphone: /.test(mainLog(userData)), JSON.stringify({ phase: idle.phase, wakeActive: idle.wakeActive }))
    await sleep(3000)
    sc.check('no audio sent while the wake engine is off', !mock.requests.some((r) => r.path === '/v1/audio/transcriptions'))

    // Push-to-talk (hotkey / tray "Слушать" / UI): overlay + listening right away.
    await main.evaluate(() => window.jarvis.assistant.listen())
    await until(async () => (await windowsInfo(app)).find((w) => w.kind === 'overlay')?.visible, { timeout: 5000, what: 'overlay on listen' })
    await until(async () => (await recorded(main)).states.some((x) => x.phase === 'listening'), { timeout: 10_000, what: 'listening' })
    sc.check('listen(): overlay shown, phase listening', true)
    const stt = await until(() => mock.requests.find((r) => r.path === '/v1/audio/transcriptions'), { timeout: 20_000, what: 'command transcription' })
    sc.check('command recorded without a wake word and transcribed', stt.fields?.file?.bytes > 20_000, `${stt.fields?.file?.bytes} B`)
    const turn = await until(() => responsesTurns(mock).find((r) => lastUserText(r.json.input) === 'Который сейчас час? Скажи время.'), { timeout: 15_000, what: 'the push-to-talk command' })
    sc.check('push-to-talk command reached the model', !!turn)
    await until(() => mock.requests.some((r) => r.path === '/v1/audio/speech'), { timeout: 15_000, what: 'spoken reply' })
    const rec = await until(async () => {
      const r = await recorded(main)
      const phases = collapse(r.states.map((x) => x.phase))
      return phases.includes('speaking') && phases.at(-1) === 'idle' ? r : null
    }, { timeout: 20_000, what: 'speaking → idle' })
    const phases = collapse(rec.states.map((x) => x.phase))
    sc.check('phases listening → transcribing → thinking → acting → speaking → idle (no follow-up)', isSubsequence(phases, ['listening', 'transcribing', 'thinking', 'acting', 'speaking', 'idle']) && !phases.slice(phases.lastIndexOf('speaking')).includes('listening'), phases.join(' → '))
    await until(() => /Microphone off/.test(mainLog(userData)), { timeout: 10_000, what: 'microphone closed after the conversation' })
    sc.check('microphone closed again after the conversation', true)
    const chats = await main.evaluate(() => window.jarvis.chats.list())
    sc.check('voice chat created', chats.some((c) => c.source === 'voice' && c.messageCount === 2), chats.map((c) => `${c.source}:${c.messageCount}`).join(','))

    // The voice engine renderer crashes: main recreates it and push-to-talk works again.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=voice'))?.webContents.forcefullyCrashRenderer()
    })
    // Count the engine's own INFO lines (with JARVIS_DEBUG the renderer console copy is logged too).
    await until(() => (mainLog(userData).match(/INFO \[voice\] Voice engine started/g) ?? []).length >= 2, { timeout: 20_000, what: 'voice engine restart' })
    sc.check('voice engine restarted after a renderer crash', /voice engine renderer gone/.test(mainLog(userData)))
    await sleep(1000)
    const before = mock.requests.filter((r) => r.path === '/v1/audio/transcriptions').length
    mock.config.transcript = 'Сколько времени? Это второй раз.'
    await main.evaluate(() => window.jarvis.assistant.listen())
    await until(() => responsesTurns(mock).some((r) => lastUserText(r.json.input) === 'Сколько времени? Это второй раз.'), { timeout: 25_000, what: 'push-to-talk after the restart' })
    sc.check('push-to-talk works after the restart', mock.requests.filter((r) => r.path === '/v1/audio/transcriptions').length === before + 1)
    await until(async () => {
      const r = await recorded(main)
      const end = r.chat.filter((e) => e.type === 'turn-end').length
      return end >= 2 && r.states.at(-1)?.phase === 'idle'
    }, { timeout: 20_000, what: 'second voice turn done' })
    healthCheck(sc, ctx, /voice engine renderer gone: (crashed|killed)/)
  } finally {
    const exit = await ctx.close()
    sc.check('app quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

// ---------------------------------------------------------------------------------------------------
// S9 — every settings tab renders (no page errors); screenshots for review

async function s9(sc) {
  const mock = await startMockServer()
  const ctx = await launch({ name: 's9', mock })
  try {
    const { main } = ctx
    const pageErrors = []
    main.on('pageerror', (err) => pageErrors.push(err.message))
    main.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text())
    })
    await waitResolved(main)
    await main.evaluate(() => window.jarvis.settings.setElevenLabsKey('xi-e2e-key-778899'))
    await main.evaluate(() => window.jarvis.app.showMain({ view: 'settings', settingsTab: 'ai' }))
    for (const tab of ['ai', 'voice', 'activation', 'computer', 'general', 'about']) {
      await main.locator(`#set-tab-${tab}`).click()
      await main.locator(`#set-tab-${tab}[aria-selected="true"]`).waitFor({ timeout: 5000 })
      await main.locator('#set-panel').waitFor()
      await sleep(400)
      const text = (await main.locator('#set-panel').innerText()).trim()
      sc.check(`settings tab "${tab}" renders`, text.length > 40, `${text.length} chars`)
      await shot(main, `settings-${tab}.png`)
    }
    // Voice tab with ElevenLabs: the voice list comes from the account (mock).
    await main.evaluate(() => window.jarvis.settings.update({ ttsProvider: 'elevenlabs' }))
    await main.locator('#set-tab-voice').click()
    await until(async () => /Test Butler/.test(await main.locator('#set-panel').innerText()), { timeout: 10_000, what: 'ElevenLabs voices in the Voice tab' })
    sc.check('Voice tab lists the ElevenLabs voices of the account', true)
    await shot(main, 'settings-voice-elevenlabs.png')
    sc.check('no page errors while browsing settings', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

    // Closing the main window only hides it (Jarvis keeps running); the Dock click brings it back.
    const closing = await ctx.app.evaluate(async ({ app, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('window=main'))
      win.close()
      await new Promise((r) => setTimeout(r, 400))
      const hidden = !win.isDestroyed() && !win.isVisible()
      app.emit('activate')
      await new Promise((r) => setTimeout(r, 600))
      return { hidden, shownAgain: !win.isDestroyed() && win.isVisible(), windows: BrowserWindow.getAllWindows().length }
    })
    sc.check('closing the main window hides it; activate shows it again', closing.hidden && closing.shownAgain && closing.windows === 3, JSON.stringify(closing))
    sc.fact(`settings screenshots: ${join(ARTIFACTS, 'settings-<tab>.png')}`)
    healthCheck(sc, ctx)
  } finally {
    const exit = await ctx.close()
    sc.check('app quits cleanly', exit.code === 0, JSON.stringify(exit))
    await mock.close()
  }
}

// ---------------------------------------------------------------------------------------------------

const SCENARIOS = [
  ['S1', 'Text chat (Responses API) + window integration', s1],
  ['S2', 'Tier switch in the chat header', s2],
  ['S3', 'Voice: fake mic → wake word → STT → reply → TTS', s3, { macOnly: 'the fake-mic phrase is made with macOS say' }],
  ['S4', 'ElevenLabs voices + synthesis', s4],
  ['S5', 'Chat Completions mode with a tool call', s5],
  ['S6', 'Persistence across restarts', s6],
  ['S7', 'Wrong API key → Russian error, recovery', s7],
  ['S8', 'Push-to-talk with the wake engine off', s8, { macOnly: 'the fake-mic phrase is made with macOS say' }],
  ['S9', 'Settings tabs render', s9]
]

/** electron-vite build with ELECTRON_RUN_AS_NODE removed (VS Code terminals export it). */
function build() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  log('Building (electron-vite build)…')
  const res = spawnSync(process.execPath, [join(ROOT, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] })
  if (res.status !== 0) {
    process.stdout.write(res.stdout ?? '')
    log(`build failed (exit ${res.status})`)
    process.exit(2)
  }
  log('Build OK\n')
}

async function main() {
  if (argv.includes('--build')) build()
  if (!existsSync(MAIN_JS)) {
    log(`out/main/index.js not found — build first (npm run test:e2e builds automatically).`)
    process.exit(2)
  }
  log(`Jarvis E2E — Electron ${ELECTRON}\nartifacts: ${ARTIFACTS}\n`)
  const results = []
  for (const [id, title, fn, opts] of SCENARIOS) {
    if (ONLY.length && !ONLY.includes(id)) continue
    if (opts?.macOnly && process.platform !== 'darwin') {
      log(`SKIP ${id} ${title} (${opts.macOnly})\n`)
      continue
    }
    const sc = new Scenario(id, title)
    log(`▶ ${id} ${title}`)
    try {
      await fn(sc)
    } catch (err) {
      sc.error = err
      log(`  FAIL ${id} aborted: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    }
    const secs = ((Date.now() - sc.started) / 1000).toFixed(1)
    log(`${sc.ok ? 'PASS' : 'FAIL'} ${id} (${sc.checks.filter((c) => c.ok).length}/${sc.checks.length} checks, ${secs} s)\n`)
    results.push(sc)
  }
  if (!KEEP) for (const dir of userDirs) rmSync(dir, { recursive: true, force: true })
  else log(`kept userData dirs:\n  ${userDirs.join('\n  ')}`)
  log('Summary')
  for (const sc of results) {
    const failed = sc.checks.filter((c) => !c.ok).map((c) => c.name)
    log(`  ${sc.ok ? 'PASS' : 'FAIL'} ${sc.id} ${sc.title}${failed.length ? ` — failed: ${failed.join('; ')}` : ''}${sc.error ? ` — ${String(sc.error.message ?? sc.error).split('\n')[0]}` : ''}`)
  }
  const ok = results.length > 0 && results.every((r) => r.ok)
  log(ok ? `\nALL ${results.length} SCENARIOS PASSED` : `\n${results.filter((r) => !r.ok).length} of ${results.length} SCENARIOS FAILED`)
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  log(`E2E runner crashed: ${err?.stack ?? err}`)
  process.exit(1)
})
