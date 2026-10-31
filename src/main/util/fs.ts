import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 20)
}

/** Reads and parses a JSON file; returns null when missing or corrupt. */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
