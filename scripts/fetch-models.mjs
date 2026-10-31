#!/usr/bin/env node
// Fetches the voice engine's runtime assets into src/renderer/public (served from the app origin):
//   models/<org>/<repo>/…  Whisper ONNX model for local wake-word detection (transformers.js layout)
//   vad/                   @ricky0123/vad-web AudioWorklet bundle + Silero VAD v5 model
//   ort/                   onnxruntime-web WASM for vad-web (top-level onnxruntime-web)
//   ort-tf/                onnxruntime-web WASM matching the build bundled inside @huggingface/transformers
// Idempotent: files that are already present and verified are skipped.
//
// Usage: node scripts/fetch-models.mjs [options]
//   --model <org/repo>     Whisper repo (default: src/renderer/src/voice/whisper-model.json)
//   --revision <sha>       repo revision (default: from the config, or "main" with --model)
//   --dtype <dtype>        q8 | fp32 | fp16 | int8 | uint8 | q4 | bnb4, or per file:
//                          encoder_model=fp32,decoder_model_merged=q8
//   --out <dir>            public dir to fill (default: src/renderer/public)
//   --skip-model           only copy the VAD / onnxruntime files
//   --force                re-download / re-copy everything
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = join(ROOT, 'src/renderer/src/voice/whisper-model.json')
const HF = 'https://huggingface.co'
const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', bnb4: '_bnb4' }
const MODEL_JSON_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']
const SESSIONS = ['encoder_model', 'decoder_model_merged']

function parseArgs(argv) {
  const opts = { force: false, skipModel: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) fail(`Missing value for ${arg}`)
      return v
    }
    if (arg === '--model') opts.model = value()
    else if (arg === '--revision') opts.revision = value()
    else if (arg === '--dtype') opts.dtype = value()
    else if (arg === '--out') opts.out = resolve(value())
    else if (arg === '--skip-model') opts.skipModel = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0])
      process.exit(0)
    } else fail(`Unknown option: ${arg}`)
  }
  return opts
}

function fail(message) {
  console.error(`fetch-models: ${message}`)
  process.exit(1)
}

function parseDtype(spec) {
  if (!spec.includes('=')) return Object.fromEntries(SESSIONS.map((s) => [s, spec]))
  const out = {}
  for (const part of spec.split(',')) {
    const [session, dtype] = part.split('=').map((s) => s.trim())
    if (!SESSIONS.includes(session)) fail(`Unknown session "${session}" in --dtype`)
    out[session] = dtype
  }
  return out
}

function modelPlan(opts) {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const id = opts.model ?? config.id
  const revision = opts.revision ?? (opts.model ? 'main' : config.revision ?? 'main')
  const dtype = opts.dtype ? parseDtype(opts.dtype) : config.dtype
  const files = [...MODEL_JSON_FILES]
  for (const session of SESSIONS) {
    const d = dtype[session] ?? 'q8'
    if (!(d in DTYPE_SUFFIX)) fail(`Unsupported dtype "${d}" for ${session}`)
    files.push(`onnx/${session}${DTYPE_SUFFIX[d]}.onnx`)
  }
  return { id, revision, dtype, files }
}

function human(bytes) {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`
  return `${bytes} B`
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

async function fetchWithRetry(url, init = {}, attempts = 4) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) })
      if (res.ok) return res
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { fatal: true })
      lastError = new Error(`HTTP ${res.status} for ${url}`)
    } catch (err) {
      if (err.fatal) throw err
      lastError = err
    }
    const delay = 1000 * 2 ** i
    console.log(`  retry in ${delay / 1000}s (${lastError.message})`)
    await new Promise((r) => setTimeout(r, delay))
  }
  throw lastError
}

/** Expected size / sha256 per file from the Hub tree API (null when the API is unreachable). */
async function remoteManifest(id, revision) {
  try {
    const res = await fetchWithRetry(`${HF}/api/models/${id}/tree/${encodeURIComponent(revision)}?recursive=true`, {}, 2)
    const entries = await res.json()
    const map = new Map()
    for (const e of entries) {
      if (e.type === 'file') map.set(e.path, { size: e.size, sha256: e.lfs?.oid ?? null })
    }
    return map
  } catch (err) {
    console.log(`  (no file manifest from the Hub API: ${err.message}; verifying by size only)`)
    return null
  }
}

async function download(url, dest, expected) {
  const part = `${dest}.part`
  await mkdir(dirname(dest), { recursive: true })
  const res = await fetchWithRetry(url, { timeoutMs: 15 * 60_000 })
  const total = Number(res.headers.get('content-length')) || expected?.size || 0
  const hash = createHash('sha256')
  let received = 0
  let lastPrint = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    const now = Date.now()
    if (process.stdout.isTTY && now - lastPrint > 500) {
      lastPrint = now
      const pct = total ? ` ${((received / total) * 100).toFixed(0)}%` : ''
      process.stdout.write(`\r  … ${human(received)}${pct}   `)
    }
  })
  try {
    await pipeline(body, createWriteStream(part))
  } catch (err) {
    await rm(part, { force: true })
    throw err
  }
  if (process.stdout.isTTY) process.stdout.write('\r')
  if (expected?.size && received !== expected.size) {
    await rm(part, { force: true })
    throw new Error(`size mismatch for ${url}: got ${received}, expected ${expected.size}`)
  }
  const digest = hash.digest('hex')
  if (expected?.sha256 && digest !== expected.sha256) {
    await rm(part, { force: true })
    throw new Error(`sha256 mismatch for ${url}`)
  }
  await rename(part, dest)
  return received
}

async function fetchModel(plan, publicDir, force) {
  const modelDir = join(publicDir, 'models', ...plan.id.split('/'))
  console.log(`Whisper model ${plan.id}@${plan.revision.slice(0, 12)} (${JSON.stringify(plan.dtype)})`)
  console.log(`  -> ${relative(ROOT, modelDir) || modelDir}`)
  const manifest = await remoteManifest(plan.id, plan.revision)
  let downloaded = 0
  for (const file of plan.files) {
    const dest = join(modelDir, file)
    const expected = manifest?.get(file) ?? null
    if (manifest && !expected) fail(`${file} does not exist in ${plan.id}@${plan.revision}`)
    const size = await fileSize(dest)
    if (!force && size >= 0 && (!expected || size === expected.size)) {
      const verified = expected?.sha256 ? (await sha256File(dest)) === expected.sha256 : true
      if (verified) {
        console.log(`  ok        ${file} (${human(size)})`)
        continue
      }
      console.log(`  corrupt   ${file} (sha256 mismatch), downloading again`)
    }
    const url = `${HF}/${plan.id}/resolve/${encodeURIComponent(plan.revision)}/${file}`
    console.log(`  download  ${file}${expected ? ` (${human(expected.size)})` : ''}`)
    downloaded += await download(url, dest, expected)
  }
  console.log(`  model ready${downloaded ? `, downloaded ${human(downloaded)}` : ', nothing to download'}`)
}

async function copyVerified(src, dest, force) {
  if (!existsSync(src)) fail(`missing ${relative(ROOT, src)} (are node_modules installed?)`)
  const srcSize = await fileSize(src)
  if (!force && (await fileSize(dest)) === srcSize && (await sha256File(src)) === (await sha256File(dest))) {
    console.log(`  ok        ${relative(ROOT, dest)} (${human(srcSize)})`)
    return
  }
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, `${dest}.part`)
  await rename(`${dest}.part`, dest)
  console.log(`  copy      ${relative(ROOT, src)} -> ${relative(ROOT, dest)} (${human(srcSize)})`)
}

function packageVersion(require, name) {
  // Some packages do not export package.json, so walk up from an exported file instead.
  let dir = dirname(require.resolve(name))
  while (dir !== dirname(dir)) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, 'utf8'))
      if (json.name === name) return { dir, version: json.version }
    }
    dir = dirname(dir)
  }
  fail(`cannot locate package.json of ${name}`)
}

async function copyRuntime(publicDir, force) {
  const rootRequire = createRequire(join(ROOT, 'package.json'))

  const vad = packageVersion(rootRequire, '@ricky0123/vad-web')
  console.log(`VAD assets (@ricky0123/vad-web ${vad.version})`)
  for (const file of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']) {
    await copyVerified(join(vad.dir, 'dist', file), join(publicDir, 'vad', file), force)
  }

  // vad-web imports the top-level onnxruntime-web ("onnxruntime-web/wasm" build).
  const vadRequire = createRequire(join(vad.dir, 'package.json'))
  const ortVad = packageVersion(vadRequire, 'onnxruntime-web')
  console.log(`onnxruntime-web ${ortVad.version} for vad-web -> ort/`)
  for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    await copyVerified(join(ortVad.dir, 'dist', file), join(publicDir, 'ort', file), force)
  }

  // transformers.js bundles its own (possibly nested, dev) onnxruntime-web "webgpu" build whose
  // JS glue expects the asyncify WASM variant of exactly that version.
  const tf = packageVersion(rootRequire, '@huggingface/transformers')
  const tfRequire = createRequire(join(tf.dir, 'package.json'))
  const ortTf = packageVersion(tfRequire, 'onnxruntime-web')
  console.log(`onnxruntime-web ${ortTf.version} for @huggingface/transformers ${tf.version} -> ort-tf/`)
  for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
    await copyVerified(join(ortTf.dir, 'dist', file), join(publicDir, 'ort-tf', file), force)
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const publicDir = opts.out ?? join(ROOT, 'src/renderer/public')
  console.log(`Voice assets -> ${publicDir}`)
  await copyRuntime(publicDir, opts.force)
  if (!opts.skipModel) await fetchModel(modelPlan(opts), publicDir, opts.force)
  console.log('Done.')
}

main().catch((err) => fail(err?.stack ?? String(err)))
