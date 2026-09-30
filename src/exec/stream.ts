// stream-json following (execution.md §14): activity log with masking, checkpointed offsets, Bash run records for §10.
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { atomicJson, readJson, readText } from './fsx.ts'

export interface Activity { at: string; kind: 'message' | 'tool' | 'error' | 'usage'; text: string }
export interface StreamSignals { sessionId?: string; rateLimit?: Record<string, unknown>; result?: Record<string, unknown> }

const MASKS: RegExp[] = [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, /sk-ant-[A-Za-z0-9_-]*/g, /ghp_[A-Za-z0-9]*/g, /AKIA[0-9A-Z]{16}/g, /xox[bp]-[A-Za-z0-9-]*/g]

/** Secret masking + control/bidi character removal + length cap, for anything shown to people. */
export function clean(s: unknown, n = 200): string {
  let t = String(s ?? '')
  for (const re of MASKS) t = t.replace(re, '[가림]')
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function toolTarget(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return clean(input.command, 120)
  for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'query']) if (typeof input[k] === 'string') return clean(input[k], 120)
  return ''
}

const contentOf = (line: Record<string, unknown>) => {
  const c = (line.message as Record<string, unknown> | undefined)?.content
  return Array.isArray(c) ? c as Record<string, unknown>[] : []
}

const resultText = (c: Record<string, unknown>) => Array.isArray(c.content) ? (c.content as Record<string, unknown>[]).map((x) => String(x.text ?? '')).join(' ') : String(c.content ?? '')

/** Converts one stream-json line into activity entries. */
export function toActivities(line: Record<string, unknown>, at = new Date().toISOString()): Activity[] {
  const out: Activity[] = []
  if (line.type === 'assistant') {
    for (const c of contentOf(line)) {
      if (c.type === 'text' && String(c.text ?? '').trim()) out.push({ at, kind: 'message', text: clean(c.text) })
      else if (c.type === 'tool_use') { const name = clean(c.name ?? '?', 40); const t = toolTarget(name, (c.input ?? {}) as Record<string, unknown>); out.push({ at, kind: 'tool', text: t ? `${name} ${t}` : name }) }
    }
  } else if (line.type === 'user') {
    for (const c of contentOf(line)) if (c.type === 'tool_result' && c.is_error === true) out.push({ at, kind: 'error', text: clean(resultText(c)) })
  } else if (line.type === 'result') {
    const u = (line.usage ?? {}) as Record<string, unknown>
    const cost = typeof line.total_cost_usd === 'number' ? ` · $${line.total_cost_usd.toFixed(4)}` : ''
    out.push({ at, kind: 'usage', text: `입력 ${Number(u.input_tokens ?? 0)} · 출력 ${Number(u.output_tokens ?? 0)} 토큰${cost}${line.is_error ? ' (오류)' : ''}` })
  }
  return out
}

const hasOkToolResult = (line: Record<string, unknown>) => line.type === 'user' && contentOf(line).some((c) => c.type === 'tool_result' && c.is_error !== true)

const MAX_CHUNK = 8 * 1024 * 1024

/**
 * Follows `<hqDir>/stream.jsonl` from a checkpointed byte offset (`tail.json`), appends `activity.jsonl`,
 * and keeps the signals the runner needs. Only complete lines are consumed, so a half-written line is re-read later.
 */
export class StreamTail {
  readonly dir: string
  offset = 0
  lastActivity: string | null = null
  sameErrorCount = 0
  rejectedSeen = false
  result: Record<string, unknown> | null = null
  private lastError = ''

  constructor(hqDir: string) {
    this.dir = hqDir
    const t = readJson<{ offset: number; lastError?: string; sameErrorCount?: number; rejectedSeen?: boolean; lastActivity?: string | null }>(join(hqDir, 'tail.json'))
    if (t) { this.offset = t.offset; this.lastError = t.lastError ?? ''; this.sameErrorCount = t.sameErrorCount ?? 0; this.rejectedSeen = !!t.rejectedSeen; this.lastActivity = t.lastActivity ?? null }
  }

  poll(onLine: (line: Record<string, unknown>, s: StreamSignals) => void = () => {}, now = new Date()): void {
    let fd: number
    try { fd = openSync(join(this.dir, 'stream.jsonl'), 'r') } catch { return }
    let chunk: string
    try {
      const size = fstatSync(fd).size
      if (size <= this.offset) return
      const buf = Buffer.alloc(Math.min(size - this.offset, MAX_CHUNK))
      const n = readSync(fd, buf, 0, buf.length, this.offset)
      const cut = buf.subarray(0, n).lastIndexOf(0x0a)
      if (cut < 0) { if (n >= MAX_CHUNK) this.offset += n; return } // a pathological giant line is skipped
      chunk = buf.subarray(0, cut + 1).toString('utf8')
      this.offset += cut + 1
    } finally { closeSync(fd) }
    const acts: Activity[] = []
    const at = now.toISOString()
    for (const raw of chunk.split('\n')) {
      if (!raw.trim()) continue
      let line: Record<string, unknown>
      try { line = JSON.parse(raw) } catch { continue }
      if (!line || typeof line !== 'object') continue
      const s: StreamSignals = {}
      if (typeof line.session_id === 'string') s.sessionId = line.session_id
      if (line.type === 'rate_limit_event') {
        s.rateLimit = line
        if ((line.rate_limit_info as Record<string, unknown> | undefined)?.status === 'rejected') this.rejectedSeen = true
      }
      if (line.type === 'result') { this.result = line; s.result = line }
      for (const a of toActivities(line, at)) {
        acts.push(a)
        if (a.kind === 'error') { if (a.text === this.lastError) this.sameErrorCount++; else { this.lastError = a.text; this.sameErrorCount = 1 } }
      }
      if (hasOkToolResult(line)) { this.lastError = ''; this.sameErrorCount = 0 }
      onLine(line, s)
    }
    if (acts.length) {
      appendFileSync(join(this.dir, 'activity.jsonl'), acts.map((a) => JSON.stringify(a)).join('\n') + '\n')
      this.lastActivity = acts[acts.length - 1].text
    }
    atomicJson(join(this.dir, 'tail.json'), { offset: this.offset, lastError: this.lastError, sameErrorCount: this.sameErrorCount, rejectedSeen: this.rejectedSeen, lastActivity: this.lastActivity })
  }

  /** The final result line, scanning the whole stream if it was consumed before a restart. */
  finalResult(): Record<string, unknown> | null {
    if (this.result) return this.result
    const lines = (readText(join(this.dir, 'stream.jsonl'), 64 * 1024 * 1024) ?? '').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"result"')) continue
      try { const l = JSON.parse(lines[i]); if (l?.type === 'result') return (this.result = l) } catch { /* skip */ }
    }
    return null
  }
}

/** Bash commands the session really ran, with exit codes from the matching tool_result (§10 tests_run check). */
export function extractBashRuns(streamPath: string): { command: string; exitCode: number }[] {
  const text = readText(streamPath, 64 * 1024 * 1024) ?? ''
  const pending = new Map<string, string>()
  const runs: { command: string; exitCode: number }[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let line: Record<string, unknown>
    try { line = JSON.parse(raw) } catch { continue }
    if (line?.type === 'assistant') {
      for (const c of contentOf(line)) if (c.type === 'tool_use' && c.name === 'Bash' && typeof c.id === 'string') pending.set(c.id, String(((c.input ?? {}) as Record<string, unknown>).command ?? ''))
    } else if (line?.type === 'user') {
      for (const c of contentOf(line)) {
        if (c.type !== 'tool_result' || typeof c.tool_use_id !== 'string' || !pending.has(c.tool_use_id)) continue
        const command = pending.get(c.tool_use_id)!
        pending.delete(c.tool_use_id)
        // Claude Code reports a non-zero exit as an error result starting "Exit code N".
        const m = /Exit code (\d+)/.exec(resultText(c))
        runs.push({ command, exitCode: c.is_error === true ? (m ? Number(m[1]) : 1) : 0 })
      }
    }
  }
  return runs
}

export function lastActivityOf(hqDir: string): string | null {
  const t = readJson<{ lastActivity?: string | null }>(join(hqDir, 'tail.json'))
  return t?.lastActivity ?? null
}
