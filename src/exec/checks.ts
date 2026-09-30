// Mechanical verification run by hq itself (docs/design/execution.md §7).
// Acceptance `check` commands were shown verbatim on the approved plan card, so they run as approved:
// `/bin/sh -c <check>` with cwd = task worktree, in their own process group so a timeout kills everything.
import { spawn } from 'node:child_process'
import type { CheckResult } from '../types.ts'
import { git } from './git.ts'

export interface CheckSpec { id: string; command: string }
export interface SecretHit { file: string; line: number; pattern: string }
export interface ChecksFile { checks: CheckResult[]; secrets: SecretHit[]; pass: boolean }

const KEEP = 200

/** Keeps the first and last 200 lines of a stream without buffering everything. */
class LineKeeper {
  head: string[] = []; tail: string[] = []; dropped = 0; partial = ''
  push(chunk: string): void {
    const parts = (this.partial + chunk).split('\n')
    this.partial = parts.pop() ?? ''
    if (this.partial.length > 10_000) { parts.push(this.partial); this.partial = '' }
    for (const l of parts) this.line(l.length > 2000 ? l.slice(0, 2000) + '…' : l)
  }
  private line(l: string): void {
    if (this.head.length < KEEP) { this.head.push(l); return }
    this.tail.push(l)
    if (this.tail.length > KEEP) { this.tail.shift(); this.dropped++ }
  }
  text(): string {
    if (this.partial) { this.line(this.partial); this.partial = '' }
    return [...this.head, ...(this.dropped ? [`… (${this.dropped}줄 생략) …`] : []), ...this.tail].join('\n')
  }
}

export function runCheck(c: CheckSpec, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const out = new LineKeeper()
    const e = { ...env }
    delete e.CLAUDECODE
    const child = spawn('/bin/sh', ['-c', c.command], { cwd, env: e, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig) } catch { /* already gone */ } }
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 5_000).unref() }, timeoutMs)
    child.stdout.on('data', (b: Buffer) => out.push(b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => out.push(b.toString('utf8')))
    child.on('error', (err) => out.push(`\n[hq] 실행 실패: ${err.message}\n`))
    child.on('close', (code) => {
      clearTimeout(timer)
      let tail = out.text()
      if (timedOut) tail += `\n[hq] 시간 초과 (${Math.round(timeoutMs / 1000)}초) — 프로세스 그룹 종료`
      resolve({ id: c.id, command: c.command, exitCode: timedOut ? null : code, durationMs: Date.now() - started, pass: !timedOut && code === 0, outputTail: tail })
    })
  })
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['private-key', /-----BEGIN .*PRIVATE KEY/],
  ['anthropic-key', /sk-ant-/],
  ['github-token', /ghp_/],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['slack-token', /xox[bp]-/],
]

/** Scans only the lines a diff adds. The matched value itself is never recorded. */
export function scanSecrets(diff: string): SecretHit[] {
  const hits: SecretHit[] = []
  let file = '', line = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
    if (h) { line = Number(h[1]); continue }
    if (l.startsWith('+')) {
      for (const [name, re] of SECRET_PATTERNS) if (re.test(l)) hits.push({ file, line, pattern: name })
      line++
    } else if (!l.startsWith('-')) line++
  }
  return hits
}

export async function runChecks(opts: { cwd: string; base: string; head: string; checks: CheckSpec[]; timeoutMs: number }): Promise<ChecksFile> {
  const results: CheckResult[] = []
  for (const c of opts.checks) results.push(await runCheck(c, opts.cwd, opts.timeoutMs))
  const d = await git(opts.cwd, ['diff', '--no-color', '--no-ext-diff', opts.base, opts.head])
  const secrets = d.code === 0 ? scanSecrets(d.stdout) : [{ file: '(diff 실패)', line: 0, pattern: 'diff-unavailable' }]
  return { checks: results, secrets, pass: results.every((r) => r.pass) && secrets.length === 0 }
}
