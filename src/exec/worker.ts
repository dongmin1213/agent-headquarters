// Spawning and supervising detached `claude -p` processes (docs/design/execution.md §5 §10 §12 §13).
// The process outlives the daemon: stdin is the prompt file, stdout/stderr go straight to evidence files,
// and hq follows stream.jsonl by offset, so a restart can pick up where it left off.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { HqConfig } from '../config.ts'
import { atomicJson, atomicWrite, readJson, readText } from './fsx.ts'

export const WORK_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch']
export const REVIEW_TOOLS = ['Bash', 'Read', 'Glob', 'Grep']

export interface ProcessInfo { pid: number; startedAt: string; sessionId: string; lstart: string | null }

/** Tool lists are passed one argv item per entry: patterns like `Bash(git push:*)` contain spaces. */
export function workArgs(cfg: HqConfig, o: { model: string; sessionId: string; resume: boolean; role: 'implement' | 'collect'; dir: string }): string[] {
  const tools = o.role === 'collect' ? ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', `Write(${o.dir}/**)`] : WORK_TOOLS
  return ['-p', '--output-format', 'stream-json', '--verbose', '--model', cfg.models[o.model as keyof HqConfig['models']] ?? o.model,
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
    '--permission-mode', 'acceptEdits', '--allowedTools', ...tools, '--disallowedTools', ...cfg.workerDisallowedTools,
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--add-dir', o.dir, '--max-turns', String(cfg.maxTurns)]
}

export function reviewArgs(cfg: HqConfig, o: { model: string; sessionId: string; schema: object }): string[] {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--model', cfg.models[o.model as keyof HqConfig['models']] ?? o.model,
    '--session-id', o.sessionId, '--json-schema', JSON.stringify(o.schema), '--permission-mode', 'acceptEdits',
    '--allowedTools', ...REVIEW_TOOLS, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', ...cfg.workerDisallowedTools,
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--max-turns', String(cfg.maxTurns)]
}

export function psLstart(pid: number): Promise<string | null> {
  return new Promise((resolve) => execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } },
    (err, out) => resolve(err ? null : String(out).trim() || null)))
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Alive and the same process we started (pid reuse is ruled out by the start time). */
export async function sameProcessAlive(p: ProcessInfo): Promise<boolean> {
  if (!pidAlive(p.pid)) return false
  const now = await psLstart(p.pid)
  if (!now) return false
  if (p.lstart) return now === p.lstart
  return Math.abs(Date.parse(now) - Date.parse(p.startedAt)) <= 2_000
}

export function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch { /* gone */ } }
}

export interface Launched { info: ProcessInfo; child: ChildProcess }

/**
 * Writes prompt.md/spec.json, spawns the CLI detached (own process group) and records process.json atomically.
 * Throws when the executable cannot be started.
 */
export async function launch(o: { claudeBin: string; argv: string[]; cwd: string; dir: string; prompt: string; sessionId: string; spec: object; env?: NodeJS.ProcessEnv }): Promise<Launched> {
  mkdirSync(o.dir, { recursive: true })
  atomicWrite(join(o.dir, 'prompt.md'), o.prompt)
  atomicJson(join(o.dir, 'spec.json'), { argv: [o.claudeBin, ...o.argv.map((a) => (a.length > 2000 ? a.slice(0, 2000) + '…' : a))], cwd: o.cwd, ...o.spec })
  const env = { ...process.env, ...o.env, HQ_ATTEMPT_DIR: o.dir }
  delete env.CLAUDECODE
  const fin = openSync(join(o.dir, 'prompt.md'), 'r')
  const fout = openSync(join(o.dir, 'stream.jsonl'), 'a')
  const ferr = openSync(join(o.dir, 'stderr.log'), 'a')
  let child: ChildProcess
  try {
    child = spawn(o.claudeBin, o.argv, { cwd: o.cwd, env, detached: true, stdio: [fin, fout, ferr] })
  } finally { closeSync(fin); closeSync(fout); closeSync(ferr) }
  const pid = await new Promise<number>((resolve, reject) => {
    if (child.pid) { child.once('error', () => {}); return resolve(child.pid) }
    child.once('error', reject)
  })
  child.unref()
  const info: ProcessInfo = { pid, startedAt: new Date().toISOString(), sessionId: o.sessionId, lstart: await psLstart(pid) }
  atomicJson(join(o.dir, 'process.json'), info)
  return { info, child }
}

export const readProcessInfo = (dir: string) => readJson<ProcessInfo>(join(dir, 'process.json'))

// ----- stream.jsonl → activity.jsonl (§13) -----

export interface Activity { at: string; kind: 'message' | 'tool' | 'error' | 'usage'; text: string }
export interface StreamSignals {
  sessionId?: string
  rateLimit?: Record<string, unknown>
  result?: Record<string, unknown>
}

const clip = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

function toolTarget(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return clip(input.command, 120)
  for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'query']) if (typeof input[k] === 'string') return clip(input[k], 120)
  return ''
}

/** Converts one stream-json line into activity entries. */
export function toActivities(line: Record<string, unknown>, at = new Date().toISOString()): Activity[] {
  const out: Activity[] = []
  const content = ((line.message as Record<string, unknown> | undefined)?.content ?? []) as Record<string, unknown>[]
  if (line.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text' && String(c.text ?? '').trim()) out.push({ at, kind: 'message', text: clip(c.text, 200) })
      else if (c.type === 'tool_use') { const name = String(c.name ?? '?'); const t = toolTarget(name, (c.input ?? {}) as Record<string, unknown>); out.push({ at, kind: 'tool', text: t ? `${name} ${t}` : name }) }
    }
  } else if (line.type === 'user' && Array.isArray(content)) {
    for (const c of content) if (c.type === 'tool_result' && c.is_error === true) {
      const body = Array.isArray(c.content) ? (c.content as Record<string, unknown>[]).map((x) => x.text ?? '').join(' ') : c.content
      out.push({ at, kind: 'error', text: clip(body, 200) })
    }
  } else if (line.type === 'result') {
    const u = (line.usage ?? {}) as Record<string, unknown>
    const cost = typeof line.total_cost_usd === 'number' ? ` · $${line.total_cost_usd.toFixed(4)}` : ''
    out.push({ at, kind: 'usage', text: `입력 ${Number(u.input_tokens ?? 0)} · 출력 ${Number(u.output_tokens ?? 0)} 토큰${cost}${line.is_error ? ' (오류)' : ''}` })
  }
  return out
}

/** Whether a user line carries a successful tool_result (resets the repeated-error counter). */
function hasOkToolResult(line: Record<string, unknown>): boolean {
  const content = ((line.message as Record<string, unknown> | undefined)?.content ?? []) as Record<string, unknown>[]
  return line.type === 'user' && Array.isArray(content) && content.some((c) => c.type === 'tool_result' && c.is_error !== true)
}

/**
 * Follows stream.jsonl from a persisted byte offset (tail.json), appends activity.jsonl,
 * and tracks the signals the runner needs (session id, rate limits, final result, repeated errors).
 */
export class StreamTail {
  readonly dir: string
  offset = 0
  lastActivity: string | null = null
  sameErrorCount = 0
  private lastError = ''
  rejectedSeen = false
  result: Record<string, unknown> | null = null

  constructor(dir: string) {
    this.dir = dir
    const t = readJson<{ offset: number; lastError?: string; sameErrorCount?: number; rejectedSeen?: boolean }>(join(dir, 'tail.json'))
    if (t) { this.offset = t.offset; this.lastError = t.lastError ?? ''; this.sameErrorCount = t.sameErrorCount ?? 0; this.rejectedSeen = !!t.rejectedSeen }
  }

  /** Reads everything new; calls onLine for each complete JSON line. */
  poll(onLine: (line: Record<string, unknown>, s: StreamSignals) => void = () => {}): void {
    let fd: number
    try { fd = openSync(join(this.dir, 'stream.jsonl'), 'r') } catch { return }
    let chunk = ''
    try {
      const size = fstatSync(fd).size
      if (size <= this.offset) return
      const buf = Buffer.alloc(Math.min(size - this.offset, 8 * 1024 * 1024))
      const n = readSync(fd, buf, 0, buf.length, this.offset)
      chunk = buf.subarray(0, n).toString('utf8')
      // Only advance past complete lines, so a half-written line is re-read next time.
      const cut = chunk.lastIndexOf('\n')
      if (cut < 0) { if (n === buf.length && n >= 8 * 1024 * 1024) this.offset += n; return } // skip a pathological giant line
      this.offset += Buffer.byteLength(chunk.slice(0, cut + 1))
      chunk = chunk.slice(0, cut + 1)
    } finally { closeSync(fd) }
    const acts: Activity[] = []
    for (const raw of chunk.split('\n')) {
      if (!raw.trim()) continue
      let line: Record<string, unknown>
      try { line = JSON.parse(raw) } catch { continue }
      const s: StreamSignals = {}
      if (typeof line.session_id === 'string') s.sessionId = line.session_id
      if (line.type === 'rate_limit_event') {
        s.rateLimit = line
        if ((line.rate_limit_info as Record<string, unknown> | undefined)?.status === 'rejected') this.rejectedSeen = true
      }
      if (line.type === 'result') { this.result = line; s.result = line }
      for (const a of toActivities(line)) {
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
    atomicJson(join(this.dir, 'tail.json'), { offset: this.offset, lastError: this.lastError, sameErrorCount: this.sameErrorCount, rejectedSeen: this.rejectedSeen })
  }

  /** The final result line, scanning the whole stream if it was consumed before a restart. */
  finalResult(): Record<string, unknown> | null {
    if (this.result) return this.result
    const text = readText(join(this.dir, 'stream.jsonl'), 64 * 1024 * 1024) ?? ''
    for (const raw of text.split('\n').reverse()) {
      if (!raw.includes('"result"')) continue
      try { const l = JSON.parse(raw); if (l.type === 'result') return (this.result = l) } catch { /* skip */ }
    }
    return null
  }
}
