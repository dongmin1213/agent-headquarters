// Codex JSONL / historical stream-json following (execution.md §14): activity log with masking, checkpointed offsets, Bash run records for §10.
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { CodexEvents } from '../codex.ts'
import { atomicJson, readJson } from './fsx.ts'

export interface Activity { at: string; kind: 'message' | 'tool' | 'error' | 'usage'; text: string }
export interface StreamSignals { sessionId?: string; rateLimit?: Record<string, unknown>; result?: Record<string, unknown> }

const MASKS: RegExp[] = [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, /sk-(?:proj-|ant-)?[A-Za-z0-9_-]+/g, /ghp_[A-Za-z0-9]*/g, /AKIA[0-9A-Z]{16}/g, /xox[bp]-[A-Za-z0-9-]*/g]

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

/** Scan arbitrarily long logs without truncating their final verdict or allocating the whole file.
 * A single line remains bounded; malformed giant lines are discarded through their next newline.
 */
function* streamLines(path: string, end = Infinity): Generator<string> {
  let fd: number
  try { fd = openSync(path, 'r') } catch { return }
  try {
    if (!fstatSync(fd).isFile()) return
    const chunk = Buffer.alloc(256 * 1024)
    let pending = Buffer.alloc(0), dropping = false, offset = 0
    for (;;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, Math.max(0, end - offset)), null)
      offset += n
      if (!n) break
      let start = 0
      for (let i = 0; i < n; i++) if (chunk[i] === 10) {
        if (!dropping && pending.length + i - start <= MAX_CHUNK)
          yield Buffer.concat([pending, chunk.subarray(start, i)]).toString('utf8')
        pending = Buffer.alloc(0); dropping = false; start = i + 1
      }
      if (!dropping) {
        if (pending.length + n - start > MAX_CHUNK) { pending = Buffer.alloc(0); dropping = true }
        else pending = Buffer.concat([pending, chunk.subarray(start, n)])
      }
    }
    if (!dropping && pending.length) yield pending.toString('utf8')
  } finally { closeSync(fd) }
}

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
  toolCount = 0
  gamePlayCount = 0
  private gamePlayTool: string | undefined
  result: Record<string, unknown> | null = null
  private lastError = ''
  private codex = new CodexEvents()

  constructor(hqDir: string, gamePlayTool?: string) {
    this.dir = hqDir
    this.gamePlayTool = gamePlayTool
    const t = readJson<{ offset: number; lastError?: string; sameErrorCount?: number; rejectedSeen?: boolean; lastActivity?: string | null }>(join(hqDir, 'tail.json'))
    const saved = readJson<{ codexSession?: string; codexText?: string; toolCount?: number; gamePlayCount?: number; gamePlayTool?: string }>(join(hqDir, 'tail.json'))
    this.codex.sessionId = saved?.codexSession ?? ''; this.codex.text = saved?.codexText ?? ''; this.toolCount = saved?.toolCount ?? 0
    if (t) { this.offset = t.offset; this.lastError = t.lastError ?? ''; this.sameErrorCount = t.sameErrorCount ?? 0; this.rejectedSeen = !!t.rejectedSeen; this.lastActivity = t.lastActivity ?? null }
    if (saved?.gamePlayTool === gamePlayTool) this.gamePlayCount = saved?.gamePlayCount ?? 0
    else if (gamePlayTool) for (const raw of streamLines(join(hqDir, 'stream.jsonl'), this.offset)) {
      try { if (this.isGamePlay(JSON.parse(raw))) this.gamePlayCount++ } catch { /* malformed line */ }
    }

  }

  private isGamePlay(line: Record<string, any>): boolean {
    if (!this.gamePlayTool || line.type !== 'item.started' || line.item?.type !== 'command_execution') return false
    const normalized = new CodexEvents().consume(line)
    const input = contentOf(normalized[0] ?? {})[0]?.input as { command?: string } | undefined
    const command = input?.command ?? ''
    if (/[;|&`$<>\n\r]/.test(command)) return false
    const prefixes = [this.gamePlayTool, `'${this.gamePlayTool}'`, `"${this.gamePlayTool}"`].map(p => `python3 ${p} `)
    const prefix = prefixes.find(p => command.startsWith(p))
    return !!prefix && /^(?:start|step|stop)(?: |$)/.test(command.slice(prefix.length))
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
      if (line.type === 'item.started' && !['agent_message', 'reasoning'].includes(String((line.item as any)?.type))) { this.toolCount++; if (this.isGamePlay(line)) this.gamePlayCount++ }
      for (const normalized of this.codex.consume(line)) {
      line = normalized
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
    }
    if (acts.length) {
      appendFileSync(join(this.dir, 'activity.jsonl'), acts.map((a) => JSON.stringify(a)).join('\n') + '\n')
      this.lastActivity = acts[acts.length - 1].text
    }
    atomicJson(join(this.dir, 'tail.json'), { offset: this.offset, lastError: this.lastError, sameErrorCount: this.sameErrorCount, rejectedSeen: this.rejectedSeen, lastActivity: this.lastActivity, codexSession: this.codex.sessionId, codexText: this.codex.text, toolCount: this.toolCount, gamePlayCount: this.gamePlayCount, gamePlayTool: this.gamePlayTool })
  }

  /** The final result line, scanning the whole stream if it was consumed before a restart. */
  finalResult(): Record<string, unknown> | null {
    if (this.result) return this.result
    const lines = streamLines(join(this.dir, 'stream.jsonl'))
    const decoder = new CodexEvents()
    let result: Record<string, unknown> | null = null
    for (const raw of lines) {
      try { for (const line of decoder.consume(JSON.parse(raw))) if (line.type === 'result') result = line } catch { /* skip malformed lines */ }
    }
    if (result) return (this.result = result)
    return null
  }
}

export interface BashRun { command: string; exitCode: number | null }

/**
 * Bash commands the session really ran (§10). Exit code: `is_error=false` → 0, a result starting with "Exit code N" → N,
 * anything else (interrupted, backgrounded, other errors) → null = unknown.
 */
export function extractBashRuns(streamPath: string): BashRun[] {
  const pending = new Map<string, { command: string; background: boolean }>()
  const runs: BashRun[] = []
  const decoder = new CodexEvents()
  for (const raw of streamLines(streamPath)) {
    if (!raw.trim()) continue
    let line: Record<string, unknown>
    try { line = JSON.parse(raw) } catch { continue }
    for (const normalized of decoder.consume(line)) {
    line = normalized
    if (line?.type === 'assistant') {
      for (const c of contentOf(line)) if (c.type === 'tool_use' && c.name === 'Bash' && typeof c.id === 'string') {
        const input = (c.input ?? {}) as Record<string, unknown>
        pending.set(c.id, { command: String(input.command ?? ''), background: input.run_in_background === true })
      }
    } else if (line?.type === 'user') {
      const tur = (line.tool_use_result ?? {}) as Record<string, unknown>
      for (const c of contentOf(line)) {
        if (c.type !== 'tool_result' || typeof c.tool_use_id !== 'string' || !pending.has(c.tool_use_id)) continue
        const call = pending.get(c.tool_use_id)!
        pending.delete(c.tool_use_id)
        let exitCode: number | null
        if (call.background || tur.interrupted === true) exitCode = null
        else if (c.is_error !== true) exitCode = 0
        else { const m = /^Exit code (\d+)/.exec(resultText(c).trimStart()); exitCode = m ? Number(m[1]) : null }
        runs.push({ command: call.command, exitCode })
      }
    }
    }
  }
  return runs
}

export function lastActivityOf(hqDir: string): string | null {
  const t = readJson<{ lastActivity?: string | null }>(join(hqDir, 'tail.json'))
  return t?.lastActivity ?? null
}
