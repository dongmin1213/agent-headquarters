// Small filesystem helpers shared by the execution engine.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, basename } from 'node:path'

/** Writes via a temp file in the same folder, then rename (atomic on the same filesystem). */
export function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

export const atomicJson = (path: string, v: unknown) => atomicWrite(path, JSON.stringify(v, null, 2) + '\n')

export function readText(path: string, max = 5_000_000): string | null {
  if (!existsSync(path)) return null
  try {
    const fd = openSync(path, 'r')
    try {
      const size = Math.min(fstatSync(fd).size, max)
      const buf = Buffer.alloc(size)
      readSync(fd, buf, 0, size, 0)
      return buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return null }
}

export function readJson<T>(path: string): T | null {
  const t = readText(path)
  if (t === null) return null
  try { return JSON.parse(t) as T } catch { return null }
}

/** Last `bytes` of a file (for "last activity" lookups without reading whole logs). */
export function readTail(path: string, bytes = 8192): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - bytes)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export const readFileOr = (path: string, fallback: string) => { try { return readFileSync(path, 'utf8') } catch { return fallback } }
