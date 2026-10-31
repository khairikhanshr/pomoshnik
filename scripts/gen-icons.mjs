#!/usr/bin/env node
/**
 * Jarvis icon generator — original "arc reactor" artwork drawn in code (no third-party logos).
 *
 * Outputs
 *   build/icon.png                       1024 px master (macOS proportions: 824 px tile, 100 px margin, soft shadow)
 *   build/icon.icns                      macOS app icon (iconutil on macOS, built-in ICNS writer elsewhere)
 *   build/icon.ico                       Windows app icon, 16…256 px (fuller tile, simplified art at small sizes)
 *   resources/tray/trayTemplate.png      macOS menu bar, 16 px  — black glyph on transparent (template image)
 *   resources/tray/trayTemplate@2x.png   macOS menu bar, 32 px
 *   resources/tray/trayActiveTemplate.png / @2x.png   same, "listening" state (filled glyph)
 *   resources/tray/tray.png              Windows notification area, 32 px, coloured
 *   resources/tray/tray.ico              Windows notification area, 16…64 px, coloured
 *   resources/tray/tray-active.png / tray-active.ico  same, "listening" state (lit reactor)
 *   build/installerSidebar.bmp           Windows installer welcome/finish sidebar (164×314, 24-bit BMP)
 *   build/background.png / @2x.png       macOS DMG window background (macOS only: Russian captions need system fonts)
 * electron-builder picks up installerSidebar.bmp and background*.png from build/ automatically.
 *
 * Every size is rendered directly from vector art tuned for that size (no bitmap downscaling),
 * so small icons stay crisp.
 *
 * Usage:  node scripts/gen-icons.mjs [--preview <dir>]
 *   --preview <dir>  also writes contact sheets (enlarged, pixelated) for visual review.
 * Requires the devDependencies @resvg/resvg-js and png-to-ico; on macOS also /usr/bin/iconutil.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_DIR = join(ROOT, 'build')
const TRAY_DIR = join(ROOT, 'resources', 'tray')

// ---------------------------------------------------------------------------------------------
// Palette (matches the UI: navy #05080d / panels #0a121b, accent cyan #3ad8ff)
// ---------------------------------------------------------------------------------------------
const P = {
  tileCenter: '#0f2f4c',
  tileMid: '#081a2d',
  tileEdge: '#030912',
  plate: '#040b13',
  plateLight: '#0a1a29',
  cyan: '#3ad8ff',
  cyanBright: '#7feaff',
  cyanDeep: '#0e95d4',
  ice: '#d9faff',
  white: '#ffffff'
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------
const n2 = (v) => Number(v.toFixed(3))

/** Point on a circle; 0° = 12 o'clock, clockwise. */
function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

/**
 * Square tile with "continuous" (smoothed) corners like the macOS app-icon shape:
 * each corner is Bézier → circular arc → Bézier, with straight sides in between.
 * radius = corner radius, smoothing 0…1 (0 = plain rounded rect, Apple-like ≈ 0.6).
 */
function smoothTile(cx, cy, size, radius = size * 0.225, smoothing = 0.6) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const R = radius
  const p = Math.min((1 + smoothing) * R, size / 2)
  const arcMeasure = 90 * (1 - smoothing)
  const arc = Math.sin(toRad(arcMeasure / 2)) * R * Math.SQRT2
  const alpha = (90 - arcMeasure) / 2
  const p3p4 = R * Math.tan(toRad(alpha / 2))
  const beta = 45 * smoothing
  const c = p3p4 * Math.cos(toRad(beta))
  const d = c * Math.tan(toRad(beta))
  const b = (p - arc - c - d) / 3
  const a = 2 * b
  const x0 = cx - size / 2
  const y0 = cy - size / 2
  const w = size
  const v = (...nums) => nums.map(n2).join(' ')
  return (
    `M${v(x0 + w - p, y0)}` +
    `c${v(a, 0, a + b, 0, a + b + c, d)}a${v(R, R)} 0 0 1 ${v(arc, arc)}c${v(d, c, d, b + c, d, a + b + c)}` +
    `L${v(x0 + w, y0 + w - p)}` +
    `c${v(0, a, 0, a + b, -d, a + b + c)}a${v(R, R)} 0 0 1 ${v(-arc, arc)}c${v(-c, d, -(b + c), d, -(a + b + c), d)}` +
    `L${v(x0 + p, y0 + w)}` +
    `c${v(-a, 0, -(a + b), 0, -(a + b + c), -d)}a${v(R, R)} 0 0 1 ${v(-arc, -arc)}c${v(-d, -c, -d, -(b + c), -d, -(a + b + c))}` +
    `L${v(x0, y0 + p)}` +
    `c${v(0, -a, 0, -(a + b), d, -(a + b + c))}a${v(R, R)} 0 0 1 ${v(arc, -arc)}c${v(c, -d, b + c, -d, a + b + c, -d)}Z`
  )
}

/**
 * Ring of `count` segments between radii r0 < r1 separated by gaps of constant width `gap`
 * (parallel-sided gaps look machined, unlike wedge-shaped constant-angle gaps).
 */
function segmentedRing(cx, cy, r0, r1, count, gap, rotate = 0) {
  let d = ''
  const step = 360 / count
  for (let i = 0; i < count; i++) {
    const a0 = rotate + i * step
    const a1 = a0 + step
    const d1 = (Math.asin(Math.min(1, gap / 2 / r1)) * 180) / Math.PI
    const d0 = (Math.asin(Math.min(1, gap / 2 / r0)) * 180) / Math.PI
    const [x0, y0] = polar(cx, cy, r1, a0 + d1)
    const [x1, y1] = polar(cx, cy, r1, a1 - d1)
    const [x2, y2] = polar(cx, cy, r0, a1 - d0)
    const [x3, y3] = polar(cx, cy, r0, a0 + d0)
    const large1 = a1 - d1 - (a0 + d1) > 180 ? 1 : 0
    const large0 = a1 - d0 - (a0 + d0) > 180 ? 1 : 0
    d +=
      `M${n2(x0)} ${n2(y0)}A${n2(r1)} ${n2(r1)} 0 ${large1} 1 ${n2(x1)} ${n2(y1)}` +
      `L${n2(x2)} ${n2(y2)}A${n2(r0)} ${n2(r0)} 0 ${large0} 0 ${n2(x3)} ${n2(y3)}Z`
  }
  return d
}

/** Annulus (ring) as a single even-odd path; r0 = 0 gives a disc. */
function annulus(cx, cy, r0, r1) {
  const c = (r) =>
    `M${n2(cx - r)} ${n2(cy)}A${n2(r)} ${n2(r)} 0 1 0 ${n2(cx + r)} ${n2(cy)}A${n2(r)} ${n2(r)} 0 1 0 ${n2(cx - r)} ${n2(cy)}Z`
  return c(r1) + (r0 > 0 ? c(r0) : '')
}

/** Short radial tick marks. */
function ticks(cx, cy, r0, r1, count, width, rotate = 0) {
  let d = ''
  for (let i = 0; i < count; i++) {
    const a = rotate + (i * 360) / count
    const half = (Math.asin(width / 2 / r1) * 180) / Math.PI
    const half0 = (Math.asin(width / 2 / r0) * 180) / Math.PI
    const [x0, y0] = polar(cx, cy, r1, a - half)
    const [x1, y1] = polar(cx, cy, r1, a + half)
    const [x2, y2] = polar(cx, cy, r0, a + half0)
    const [x3, y3] = polar(cx, cy, r0, a - half0)
    d += `M${n2(x0)} ${n2(y0)}L${n2(x1)} ${n2(y1)}L${n2(x2)} ${n2(y2)}L${n2(x3)} ${n2(y3)}Z`
  }
  return d
}

const svgDoc = (size, body, viewBox = `0 0 ${size} ${size}`) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${body}</svg>`

// ---------------------------------------------------------------------------------------------
// App icon
// ---------------------------------------------------------------------------------------------

/** Level of detail for a rendered pixel size. */
function detailFor(px) {
  if (px >= 256) return 'L'
  if (px >= 64) return 'M'
  if (px >= 32) return 'S'
  return 'XS'
}

/**
 * Reactor artwork centred at (cx, cy); R = outer radius of the reactor housing.
 * `detail` drops/thickens features so the art survives small sizes.
 */
function reactor(cx, cy, R, detail, id) {
  const L = detail === 'L'
  const M = detail === 'M'
  const S = detail === 'S'
  const XS = detail === 'XS'

  // radial layout (fractions of R) per detail level
  const segCount = L || M ? 10 : S ? 8 : 0
  const segOuter = R * (XS ? 0.97 : 0.93)
  const segInner = R * (XS ? 0.64 : S ? 0.66 : 0.7)
  const segGap = R * (L ? 0.055 : M ? 0.075 : 0.11)
  const innerRingR = R * 0.6
  const innerRingW = R * (L ? 0.045 : M ? 0.065 : 0)
  const coreR = R * (L ? 0.3 : M ? 0.33 : S ? 0.4 : 0.42)
  const coreRingR = R * 0.41
  const coreRingW = L ? R * 0.022 : 0
  const blur = R * (L ? 0.04 : M ? 0.05 : S ? 0.06 : 0.05)

  const defs = `
    <radialGradient id="${id}amb" cx="${cx}" cy="${cy}" r="${n2(R * 1.35)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.cyan}" stop-opacity="${XS ? 0.2 : 0.4}"/>
      <stop offset="0.5" stop-color="${P.cyan}" stop-opacity="${XS ? 0.05 : 0.14}"/>
      <stop offset="1" stop-color="${P.cyan}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}plate" cx="${cx}" cy="${cy}" r="${n2(R)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.plateLight}"/>
      <stop offset="1" stop-color="${P.plate}"/>
    </radialGradient>
    <radialGradient id="${id}seg" cx="${cx}" cy="${cy}" r="${n2(segOuter)}" gradientUnits="userSpaceOnUse">
      <stop offset="${n2(segInner / segOuter)}" stop-color="${P.ice}"/>
      <stop offset="${n2(segInner / segOuter + (1 - segInner / segOuter) * 0.3)}" stop-color="${P.cyanBright}"/>
      <stop offset="1" stop-color="${P.cyanDeep}"/>
    </radialGradient>
    <radialGradient id="${id}core" cx="${cx}" cy="${n2(cy - coreR * 0.25)}" r="${n2(coreR * 1.2)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.white}"/>
      <stop offset="0.5" stop-color="${P.ice}"/>
      <stop offset="1" stop-color="${P.cyan}"/>
    </radialGradient>
    <radialGradient id="${id}halo" cx="${cx}" cy="${cy}" r="${n2(R * 0.6)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.white}" stop-opacity="0.9"/>
      <stop offset="0.5" stop-color="${P.cyanBright}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${P.cyan}" stop-opacity="0"/>
    </radialGradient>
    <filter id="${id}blur" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="${n2(blur)}"/>
    </filter>`

  const segPath =
    segCount > 0
      ? segmentedRing(cx, cy, segInner, segOuter, segCount, segGap, 360 / segCount / 2)
      : annulus(cx, cy, segInner, segOuter)
  const innerRing = (stroke) =>
    innerRingW
      ? `<circle cx="${cx}" cy="${cy}" r="${n2(innerRingR)}" fill="none" stroke="${stroke}" stroke-width="${n2(innerRingW)}"/>`
      : ''

  // ambient light on the tile, then the dark housing plate with a thin rim
  let art = `<circle cx="${cx}" cy="${cy}" r="${n2(R * 1.35)}" fill="url(#${id}amb)"/>`
  art += `<circle cx="${cx}" cy="${cy}" r="${n2(R)}" fill="url(#${id}plate)"/>`
  if (!XS) {
    art += `<circle cx="${cx}" cy="${cy}" r="${n2(R * 0.985)}" fill="none" stroke="${P.cyan}" stroke-opacity="0.5" stroke-width="${n2(R * (L ? 0.018 : M ? 0.03 : 0.045))}"/>`
  }
  // glow pass (blurred copy underneath), then crisp coils and inner ring on top
  art += `<g filter="url(#${id}blur)" opacity="${XS ? 0.45 : 0.85}"><path d="${segPath}" fill="${P.cyan}" fill-rule="evenodd"/>${innerRing(P.cyan)}</g>`
  art += `<path d="${segPath}" fill="url(#${id}seg)" fill-rule="evenodd"/>`
  art += innerRing(P.cyanBright)
  if (L) {
    art += `<path d="${ticks(cx, cy, R * 0.475, R * 0.515, 40, R * 0.013)}" fill="${P.cyan}" fill-opacity="0.6"/>`
  }
  // core: halo, fine ring, glowing disc, specular highlight
  art += `<circle cx="${cx}" cy="${cy}" r="${n2(R * 0.6)}" fill="url(#${id}halo)"/>`
  if (coreRingW) {
    art += `<circle cx="${cx}" cy="${cy}" r="${n2(coreRingR)}" fill="none" stroke="${P.ice}" stroke-opacity="0.85" stroke-width="${n2(coreRingW)}"/>`
  }
  art += `<circle cx="${cx}" cy="${cy}" r="${n2(coreR * 1.08)}" fill="${P.cyan}" filter="url(#${id}blur)" opacity="0.9"/>`
  art += `<circle cx="${cx}" cy="${cy}" r="${n2(coreR)}" fill="url(#${id}core)"/>`
  if (L || M) {
    const hx = n2(cx - coreR * 0.3)
    const hy = n2(cy - coreR * 0.36)
    art += `<ellipse cx="${hx}" cy="${hy}" rx="${n2(coreR * 0.4)}" ry="${n2(coreR * 0.24)}" fill="${P.white}" fill-opacity="0.5" transform="rotate(-32 ${hx} ${hy})"/>`
  }
  return { defs, art }
}

/**
 * Full app icon SVG at `px` pixels (drawn on a 1024 grid).
 * platform 'mac': 824 px tile + drop shadow inside the 1024 canvas (Apple icon grid).
 * platform 'win': the tile fills (almost) the whole canvas — Windows icons have no built-in margin.
 */
function appIconSvg(px, platform = 'mac', detail = detailFor(px)) {
  const S = 1024
  const mac = platform === 'mac'
  const tile = mac ? 824 : px <= 32 ? 1024 : px <= 64 ? 992 : 960
  const c = S / 2
  const tilePath = smoothTile(c, c, tile, tile * 0.225, 0.6)
  const R = tile * (detail === 'XS' ? 0.4 : detail === 'S' ? 0.39 : 0.37)
  const r = reactor(c, c, R, detail, 'r')

  const defs = `<defs>
    <radialGradient id="tile" cx="${c}" cy="${n2(c - tile * 0.06)}" r="${n2(tile * 0.66)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.tileCenter}"/>
      <stop offset="0.55" stop-color="${P.tileMid}"/>
      <stop offset="1" stop-color="${P.tileEdge}"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="${n2(c - tile / 2)}" x2="0" y2="${n2(c)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#bff3ff" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="clip"><path d="${tilePath}"/></clipPath>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.4"/>
    </filter>
    ${r.defs}
  </defs>`

  let body = defs
  body += `<path d="${tilePath}" fill="url(#tile)"${mac ? ' filter="url(#shadow)"' : ''}/>`
  body += `<g clip-path="url(#clip)">${r.art}<path d="${tilePath}" fill="url(#sheen)"/></g>`
  // hairline rim so the dark tile still reads on dark backgrounds (dark Dock / taskbar)
  const rimW = px <= 32 ? 18 : px <= 64 ? 10 : 6
  body += `<path d="${tilePath}" fill="none" stroke="${P.cyan}" stroke-opacity="${px <= 32 ? 0.4 : 0.3}" stroke-width="${rimW}" clip-path="url(#clip)"/>`
  return svgDoc(px, body, `0 0 ${S} ${S}`)
}

// ---------------------------------------------------------------------------------------------
// Tray icons
// ---------------------------------------------------------------------------------------------

/**
 * macOS menu-bar template glyph (black + alpha only; macOS tints it for light/dark menu bars).
 * Drawn on a 16 pt grid.
 *   idle   — reactor: thin outer rim + 8 coil segments + core (the 1x bitmap drops the rim to stay crisp)
 *   active — "powered" filled disc with a knocked-out ring around the core (clearly heavier at a glance)
 */
function trayTemplateSvg(px, active) {
  const c = 8
  const retina = px >= 32
  let d
  if (active) {
    d = annulus(c, c, retina ? 4.6 : 4.7, 7.8) + annulus(c, c, 0, retina ? 3.4 : 3.3)
  } else if (retina) {
    d = annulus(c, c, 6.9, 7.8) + segmentedRing(c, c, 3.9, 5.9, 8, 1.0, 22.5) + annulus(c, c, 0, 2.2)
  } else {
    d = segmentedRing(c, c, 5.3, 7.6, 8, 1.1, 22.5) + annulus(c, c, 0, 2.8)
  }
  return svgDoc(px, `<path d="${d}" fill="#000000" fill-rule="evenodd"/>`, '0 0 16 16')
}

/**
 * Windows notification-area icon: coloured reactor on a navy disc, so it reads on both the dark
 * and the light taskbar. Active (listening) = the reactor "lights up": bright cyan disc, white core.
 */
function trayColorSvg(px, active) {
  const c = 8
  const detailed = px >= 24
  const defs = `<defs>
    <radialGradient id="disc" cx="8" cy="7" r="9" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${active ? '#e4fcff' : '#12365a'}"/>
      <stop offset="${active ? 0.42 : 0.6}" stop-color="${active ? P.cyan : '#0a1d31'}"/>
      <stop offset="1" stop-color="${active ? P.cyanDeep : '#040b14'}"/>
    </radialGradient>
    <radialGradient id="coil" cx="8" cy="8" r="7" gradientUnits="userSpaceOnUse">
      <stop offset="0.55" stop-color="${P.ice}"/>
      <stop offset="1" stop-color="${P.cyan}"/>
    </radialGradient>
  </defs>`
  let body = defs + `<circle cx="8" cy="8" r="8" fill="url(#disc)"/>`
  if (!active) {
    const coils = detailed ? segmentedRing(c, c, 4.2, 6.7, 8, 0.85, 22.5) : annulus(c, c, 4.4, 6.7)
    body += `<path d="${coils}" fill="url(#coil)" fill-rule="evenodd"/>`
    body += `<circle cx="8" cy="8" r="${detailed ? 2.3 : 2.5}" fill="#ffffff"/>`
  } else {
    const ink = '#05213a'
    if (detailed) {
      // navy spokes between the (now glowing) coils
      for (let i = 0; i < 8; i++) {
        const a = 22.5 + i * 45
        const [x0, y0] = polar(c, c, 4.6, a)
        const [x1, y1] = polar(c, c, 8, a)
        body += `<line x1="${n2(x0)}" y1="${n2(y0)}" x2="${n2(x1)}" y2="${n2(y1)}" stroke="${ink}" stroke-opacity="0.75" stroke-width="0.8"/>`
      }
    }
    body += `<path d="${annulus(c, c, 3.4, 4.6)}" fill="${ink}" fill-opacity="0.9" fill-rule="evenodd"/>`
    body += `<circle cx="8" cy="8" r="2.9" fill="#ffffff"/>`
  }
  return svgDoc(px, body, '0 0 16 16')
}

// ---------------------------------------------------------------------------------------------
// Installer artwork
// ---------------------------------------------------------------------------------------------

/**
 * macOS DMG window background, 540×380 pt (electron-builder places the app at (130, 220) and the
 * Applications link at (410, 220), 80 pt icons). Light, so Finder's black icon labels stay readable.
 * Russian captions need system fonts → rendered on macOS only (DMGs are built on macOS anyway).
 */
function dmgBackgroundSvg() {
  const font = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`
  let rings = ''
  for (const [r, w, o, dash] of [
    [58, 1.5, 0.28, ''],
    [68, 1, 0.2, ' stroke-dasharray="2 5"'],
    [80, 1, 0.12, '']
  ]) {
    rings += `<circle cx="130" cy="220" r="${r}" fill="none" stroke="${P.cyan}" stroke-opacity="${o}" stroke-width="${w}"${dash}/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f8fbfd"/>
      <stop offset="1" stop-color="#e2ecf2"/>
    </linearGradient>
    <radialGradient id="halo" cx="130" cy="220" r="96" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.cyan}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${P.cyan}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="arrow" x1="205" y1="0" x2="330" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.cyan}" stop-opacity="0.25"/>
      <stop offset="1" stop-color="${P.cyanDeep}"/>
    </linearGradient>
  </defs>
  <rect width="540" height="380" fill="url(#bg)"/>
  <circle cx="130" cy="220" r="96" fill="url(#halo)"/>
  ${rings}
  <path d="M206 220H322" stroke="url(#arrow)" stroke-width="4" stroke-linecap="round"/>
  <path d="M310 208L326 220L310 232" fill="none" stroke="${P.cyanDeep}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="270" y="74" text-anchor="middle" ${font} font-size="21" font-weight="bold" fill="#0b2236">Перетащите Jarvis в «Программы»</text>
  <text x="270" y="100" text-anchor="middle" ${font} font-size="13" fill="#4a5d6e">Джарвис — голосовой ИИ-помощник для вашего Mac</text>
  <rect x="44" y="304" width="452" height="54" rx="12" fill="#ffffff" fill-opacity="0.75" stroke="${P.cyan}" stroke-opacity="0.45"/>
  <text x="270" y="326" text-anchor="middle" ${font} font-size="12.5" fill="#1d3346">Первый запуск: правый клик по Jarvis в «Программах» → «Открыть»</text>
  <text x="270" y="345" text-anchor="middle" ${font} font-size="11" fill="#55687a">macOS 15+: Конфиденциальность и безопасность → «Всё равно открыть»</text>
</svg>`
}

/** NSIS welcome/finish page sidebar, 164×314 px (assisted installer and uninstaller). */
function installerSidebarSvg() {
  const r = reactor(82, 132, 54, 'M', 's')
  let grid = ''
  for (let y = 14; y < 314; y += 20) grid += `M0 ${y}H164`
  for (let x = 2; x < 164; x += 20) grid += `M${x} 0V314`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0e2a44"/>
      <stop offset="0.5" stop-color="#081829"/>
      <stop offset="1" stop-color="#03080f"/>
    </linearGradient>
    ${r.defs}
  </defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <path d="${grid}" stroke="${P.cyan}" stroke-opacity="0.06" stroke-width="1"/>
  ${r.art}
  <path d="${annulus(82, 132, 70, 71)}" fill="${P.cyan}" fill-opacity="0.35" fill-rule="evenodd"/>
  <path d="M30 236H134" stroke="${P.cyan}" stroke-opacity="0.45" stroke-width="1"/>
  <path d="M52 244H112" stroke="${P.cyan}" stroke-opacity="0.25" stroke-width="1"/>
</svg>`
}

// ---------------------------------------------------------------------------------------------
// Rendering & file writers
// ---------------------------------------------------------------------------------------------
function render(svg, px) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: px }, font: { loadSystemFonts: false } }).render()
  if (png.width !== px || png.height !== px) throw new Error(`render size mismatch: ${png.width}x${png.height} != ${px}`)
  return png.asPng()
}

/** Renders a non-square artwork at `width` px (optionally with system fonts for text). */
function renderImage(svg, width, { fonts = false } = {}) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: fonts ? { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' } : { loadSystemFonts: false }
  }).render()
}

/** 24-bit bottom-up BMP (the format NSIS/MUI2 expects) from an opaque resvg image. */
function toBmp24(img) {
  const { width, height } = img
  const px = img.pixels
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const buf = Buffer.alloc(54 + rowSize * height)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(rowSize * height, 34)
  buf.writeInt32LE(2835, 38)
  buf.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      buf[row + x * 3] = px[i + 2]
      buf[row + x * 3 + 1] = px[i + 1]
      buf[row + x * 3 + 2] = px[i]
    }
  }
  return buf
}

/** Minimal ICNS writer (PNG payloads) used when macOS `iconutil` is unavailable. */
function writeIcnsFallback(file, pngBySize) {
  const types = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512]
  ]
  const chunks = types.map(([type, size]) => {
    const data = pngBySize.get(size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const total = chunks.reduce((n, b) => n + b.length, 8)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(total, 4)
  writeFileSync(file, Buffer.concat([head, ...chunks]))
}

const hasIconutil = () => process.platform === 'darwin' && existsSync('/usr/bin/iconutil')

async function main() {
  const args = process.argv.slice(2)
  const previewIdx = args.indexOf('--preview')
  const previewDir = previewIdx >= 0 ? resolve(args[previewIdx + 1] || join(ROOT, 'icon-preview')) : null

  mkdirSync(BUILD_DIR, { recursive: true })
  mkdirSync(TRAY_DIR, { recursive: true })
  const written = []
  const write = (file, data) => {
    writeFileSync(file, data)
    written.push(file)
  }

  // ---- macOS master + icns ------------------------------------------------------------------
  const macSizes = [16, 32, 64, 128, 256, 512, 1024]
  const mac = new Map(macSizes.map((s) => [s, render(appIconSvg(s, 'mac'), s)]))
  write(join(BUILD_DIR, 'icon.png'), mac.get(1024))

  const icnsFile = join(BUILD_DIR, 'icon.icns')
  if (hasIconutil()) {
    const tmp = mkdtempSync(join(tmpdir(), 'jarvis-icons-'))
    const set = join(tmp, 'icon.iconset')
    mkdirSync(set)
    for (const base of [16, 32, 128, 256, 512]) {
      writeFileSync(join(set, `icon_${base}x${base}.png`), mac.get(base))
      writeFileSync(join(set, `icon_${base}x${base}@2x.png`), mac.get(base * 2))
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', icnsFile, set])
    rmSync(tmp, { recursive: true, force: true })
    written.push(icnsFile)
  } else {
    writeIcnsFallback(icnsFile, mac)
    written.push(icnsFile)
  }

  // ---- Windows ico --------------------------------------------------------------------------
  const winSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const win = winSizes.map((s) => render(appIconSvg(s, 'win'), s))
  write(join(BUILD_DIR, 'icon.ico'), await pngToIco(win))

  // ---- tray ---------------------------------------------------------------------------------
  write(join(TRAY_DIR, 'trayTemplate.png'), render(trayTemplateSvg(16, false), 16))
  write(join(TRAY_DIR, 'trayTemplate@2x.png'), render(trayTemplateSvg(32, false), 32))
  write(join(TRAY_DIR, 'trayActiveTemplate.png'), render(trayTemplateSvg(16, true), 16))
  write(join(TRAY_DIR, 'trayActiveTemplate@2x.png'), render(trayTemplateSvg(32, true), 32))
  const traySizes = [16, 20, 24, 32, 40, 48, 64]
  for (const active of [false, true]) {
    const name = active ? 'tray-active' : 'tray'
    write(join(TRAY_DIR, `${name}.png`), render(trayColorSvg(32, active), 32))
    write(join(TRAY_DIR, `${name}.ico`), await pngToIco(traySizes.map((s) => render(trayColorSvg(s, active), s))))
  }
  const keep = join(TRAY_DIR, '.keep')
  if (existsSync(keep)) rmSync(keep)

  // ---- installer artwork --------------------------------------------------------------------
  // Windows installer sidebar (picked up automatically by electron-builder from build/).
  write(join(BUILD_DIR, 'installerSidebar.bmp'), toBmp24(renderImage(installerSidebarSvg(), 164)))
  // DMG background (+ @2x → HiDPI TIFF, picked up automatically by electron-builder from build/).
  if (process.platform === 'darwin') {
    const svg = dmgBackgroundSvg()
    write(join(BUILD_DIR, 'background.png'), renderImage(svg, 540, { fonts: true }).asPng())
    write(join(BUILD_DIR, 'background@2x.png'), renderImage(svg, 1080, { fonts: true }).asPng())
  } else {
    console.log('  · DMG background skipped (needs macOS system fonts); keeping build/background*.png')
  }

  if (previewDir) writePreviews(previewDir, { mac, win, winSizes, traySizes })

  for (const f of written) console.log('  ✓', f.slice(ROOT.length + 1), `(${readFileSync(f).length} bytes)`)
  console.log(`gen-icons: ${written.length} files written.`)
}

// ---------------------------------------------------------------------------------------------
// Contact sheets for visual review (enlarged with nearest-neighbour sampling)
// ---------------------------------------------------------------------------------------------
function writePreviews(dir, { mac, win, winSizes, traySizes }) {
  mkdirSync(dir, { recursive: true })
  const img = (png, x, y, w) =>
    `<image x="${x}" y="${y}" width="${w}" height="${w}" href="data:image/png;base64,${png.toString('base64')}"/>`
  const sheet = (name, items, bg, cell = 140) => {
    const width = items.length * cell + 20
    let body = `<rect width="100%" height="100%" fill="${bg}"/>`
    items.forEach(({ png, scale }, i) => {
      body += img(png, 20 + i * cell, 20, scale)
    })
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${cell + 40}">${body}</svg>`
    const out = new Resvg(svg, { imageRendering: 1, font: { loadSystemFonts: false } }).render().asPng()
    writeFileSync(join(dir, name), out)
  }
  const up = (size) => Math.min(128, size * Math.max(1, Math.floor(128 / size)))
  sheet('mac-sizes-dark.png', [16, 32, 64, 128, 256].map((s) => ({ png: mac.get(s), scale: up(s) })), '#1e1e1e')
  sheet('mac-sizes-light.png', [16, 32, 64, 128, 256].map((s) => ({ png: mac.get(s), scale: up(s) })), '#ececec')
  sheet('win-sizes.png', winSizes.map((s, i) => ({ png: win[i], scale: up(s) })), '#202020')
  const tt = [false, true].flatMap((a) => [16, 32].map((s) => ({ png: render(trayTemplateSvg(s, a), s), scale: 128 })))
  sheet('tray-template-light.png', tt, '#f2f2f2')
  // simulate the dark menu bar (template images are drawn white there)
  const ttWhite = [false, true].flatMap((a) =>
    [16, 32].map((s) => ({ png: render(trayTemplateSvg(s, a).replace(/#000000/g, '#ffffff'), s), scale: 128 }))
  )
  sheet('tray-template-dark.png', ttWhite, '#2a2a2e')
  const tc = [false, true].flatMap((a) => traySizes.slice(0, 4).map((s) => ({ png: render(trayColorSvg(s, a), s), scale: up(s) })))
  sheet('tray-win-dark.png', tc, '#1c1c1c')
  sheet('tray-win-light.png', tc, '#f3f3f3')
}

export { appIconSvg, trayTemplateSvg, trayColorSvg, render }

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error('gen-icons failed:', err)
    process.exit(1)
  })
}
