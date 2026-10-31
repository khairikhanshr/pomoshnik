// Lenient argument readers: models sometimes send numbers as strings or booleans as "true".
import { ToolError } from './errors'

export type Args = Record<string, unknown>

interface StringOptions {
  max?: number
  /** Keep surrounding whitespace (text to type, file content). */
  raw?: boolean
}

export function optString(args: Args, key: string, opts: StringOptions = {}): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  let text: string
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
  else throw new ToolError(`Invalid argument "${key}": expected a string`)
  if (!opts.raw) text = text.trim()
  if (!text) return undefined
  if (opts.max !== undefined && text.length > opts.max) {
    throw new ToolError(`Invalid argument "${key}": longer than ${opts.max} characters`)
  }
  return text
}

export function reqString(args: Args, key: string, opts: StringOptions = {}): string {
  const text = optString(args, key, opts)
  if (text === undefined) throw new ToolError(`Missing required argument "${key}"`)
  return text
}

interface NumberOptions {
  min?: number
  max?: number
  integer?: boolean
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value.trim().replace(',', '.'))
  return Number.NaN
}

export function optNumber(args: Args, key: string, opts: NumberOptions = {}): number | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  let n = toNumber(value)
  if (!Number.isFinite(n)) throw new ToolError(`Invalid argument "${key}": expected a number`)
  if (opts.integer) n = Math.round(n)
  if (opts.min !== undefined && n < opts.min) throw new ToolError(`Invalid argument "${key}": must be >= ${opts.min}`)
  if (opts.max !== undefined && n > opts.max) throw new ToolError(`Invalid argument "${key}": must be <= ${opts.max}`)
  return n
}

export function reqNumber(args: Args, key: string, opts: NumberOptions = {}): number {
  const n = optNumber(args, key, opts)
  if (n === undefined) throw new ToolError(`Missing required argument "${key}"`)
  return n
}

export function optBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 'true' || value === '1' || value === 'yes') return true
  if (value === 0 || value === 'false' || value === '0' || value === 'no') return false
  throw new ToolError(`Invalid argument "${key}": expected true or false`)
}

export function optEnum<T extends string>(args: Args, key: string, values: readonly T[]): T | undefined {
  const text = optString(args, key)
  if (text === undefined) return undefined
  const lower = text.toLowerCase()
  const found = values.find((v) => v === lower)
  if (!found) throw new ToolError(`Invalid argument "${key}": expected one of ${values.join(', ')}`)
  return found
}

export function reqEnum<T extends string>(args: Args, key: string, values: readonly T[]): T {
  const value = optEnum(args, key, values)
  if (value === undefined) throw new ToolError(`Missing required argument "${key}" (one of ${values.join(', ')})`)
  return value
}

export function optObject(args: Args, key: string): Args | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Args
    } catch {
      // fall through to the type error below
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new ToolError(`Invalid argument "${key}": expected an object`)
  return value as Args
}

/** Shortens text for titles and summaries. */
export function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}
