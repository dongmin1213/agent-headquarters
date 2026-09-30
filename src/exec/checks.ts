// Mechanical verification run by hq itself (execution.md §9).
// Acceptance `check` commands were shown verbatim on the approved plan card, so they run as approved —
// but inside the sandbox, with a minimal env, stdin /dev/null, in their own process group.
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import type { CheckResult } from '../types.ts'
import { atomicWrite } from './fsx.ts'
import { hqGit, removeMirrorWorktree, SAFE_DIFF, verifyWorktree, wtGit, wtStatus, type MirrorWorktree } from './repos.ts'
import { childEnv, sandboxProfile, wrap, type SandboxOpts } from './sandbox.ts'

/** `baseFailed`: a regression check that already failed on the base for an ordinary reason — still run; its failure alone does not fail the file. */
export interface CheckSpec { id: string; command: string; kind?: 'new' | 'regression'; baseFailed?: boolean }
export interface SecretHit { commit: string; file: string; line: number; pattern: string }
export type CheckOutcome = CheckResult & { kind?: string; baseFailed?: boolean }
/**
 * `warnings`: new-kind checks that already passed on the base (they do not prove the new behaviour).
 * `manual`: regression checks that failed on the base and failed again on the candidate — handed to the reviewer (§9).
 * `baseTails`: base output tail for each id in `manual`.
 */
export interface ChecksFile { checks: CheckOutcome[]; secrets: SecretHit[]; pass: boolean; error: string | null; warnings?: string[]; manual?: string[]; baseTails?: Record<string, string> }
/** One check's result on the base (§9 baseline). `setupFailed`: the project setup failed, so the check never ran. */
export interface BaseResult { pass: boolean; exitCode: number | null; timedOut: boolean; setupFailed?: boolean; tail: string }
/** The base run says nothing about the code: setup failed, timed out, or the command could not be found/executed. */
export const envFailure = (b: BaseResult): boolean => !!b.setupFailed || b.timedOut || b.exitCode === 126 || b.exitCode === 127
/** Called with each spawned check process so a restart can kill leftover groups (§9). */
export type OnSpawn = (pid: number) => void

const KEEP = 200

/** Keeps the first and last 200 lines of output without buffering everything. */
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

/** Runs one shell command in the sandbox; a timeout kills the whole process group (children included). */
export function runSandboxed(command: string, cwd: string, timeoutMs: number, profilePath: string, id = 'cmd', onSpawn?: OnSpawn): Promise<CheckResult & { timedOut: boolean }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const out = new LineKeeper()
    const argv = wrap(['/bin/sh', '-c', command], profilePath)
    const child = spawn(argv[0], argv.slice(1), { cwd, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid) onSpawn?.(child.pid)
    let timedOut = false
    const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig) } catch { /* gone */ } }
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3_000).unref() }, timeoutMs)
    child.stdout!.on('data', (b: Buffer) => out.push(b.toString('utf8')))
    child.stderr!.on('data', (b: Buffer) => out.push(b.toString('utf8')))
    child.on('error', (err) => out.push(`\n[hq] 실행 실패: ${err.message}\n`))
    child.on('close', (code) => {
      clearTimeout(timer)
      // The shell may exit while its children linger in the group; make sure nothing survives.
      killGroup('SIGKILL')
      let tail = out.text()
      if (timedOut) tail += `\n[hq] 시간 초과 (${Math.round(timeoutMs / 1000)}초) — 프로세스 그룹 종료`
      resolve({ id, command, exitCode: timedOut ? null : code, durationMs: Date.now() - started, pass: !timedOut && code === 0, outputTail: tail, timedOut })
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
const DENIED_NAMES: [string, RegExp][] = [['env-file', /^\.env/], ['pem', /\.pem$/], ['ssh-key', /^id_rsa/], ['p12', /\.p12$/], ['key-file', /\.key$/]]

/** Scans the lines added by every commit of `git log -p`. The matched value is never recorded. */
export function scanSecrets(log: string): SecretHit[] {
  const hits: SecretHit[] = []
  let commit = '', file = '', line = 0
  for (const l of log.split('\n')) {
    const c = /^commit:([0-9a-f]{40})$/.exec(l)
    if (c) { commit = c[1]; continue }
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue }
    if (l.startsWith('--- ')) continue
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
    if (h) { line = Number(h[1]); continue }
    if (l.startsWith('+')) {
      for (const [name, re] of SECRET_PATTERNS) if (re.test(l)) hits.push({ commit, file, line, pattern: name })
      line++
    } else if (l.startsWith(' ')) line++
  }
  return hits
}

export async function secretScan(mirror: string, base: string, head: string): Promise<SecretHit[]> {
  if (base === head) return []
  const log = await hqGit(mirror, null, ['log', '-p', '--no-color', ...SAFE_DIFF, '--format=commit:%H', `${base}..${head}`])
  if (log.code !== 0) return [{ commit: '', file: '(git log 실패)', line: 0, pattern: 'scan-unavailable' }]
  const hits = scanSecrets(log.stdout)
  const names = await hqGit(mirror, null, ['log', '--name-only', '--no-renames', '--diff-filter=AM', '--format=commit:%H', `${base}..${head}`])
  let commit = ''
  for (const l of names.stdout.split('\n')) {
    const c = /^commit:([0-9a-f]{40})$/.exec(l)
    if (c) { commit = c[1]; continue }
    if (!l.trim()) continue
    for (const [name, re] of DENIED_NAMES) if (re.test(basename(l))) hits.push({ commit, file: l, line: 0, pattern: name })
  }
  return hits
}

export interface RunChecksOpts {
  /** Fresh mirror worktree at `head` (§9); hq inspects it only through the mirror admin dir. */
  wt: MirrorWorktree
  base: string
  head: string
  checks: CheckSpec[]
  timeoutMs: number
  sandbox: SandboxOpts
  /** Where to write the sandbox profile (hq-owned folder). */
  profilePath: string
  /** check id → passed on the base (from the baseline run). */
  basePassed?: Record<string, boolean>
  onSpawn?: OnSpawn
}

/** Runs checks in the sandbox. No baseline exemption (v3): every automatic check must pass. */
export async function runChecks(o: RunChecksOpts): Promise<ChecksFile> {
  const headOf = async () => { const r = await wtGit(o.wt, ['rev-parse', 'HEAD']); return r.code === 0 ? r.stdout.trim() : null }
  const head = await headOf()
  if (head !== o.head) return { checks: [], secrets: [], pass: false, error: `검증 worktree HEAD(${head?.slice(0, 10) ?? '없음'})가 기록된 head_sha와 다름` }
  atomicWrite(o.profilePath, sandboxProfile(o.sandbox))
  const results: CheckOutcome[] = []
  const warnings: string[] = []
  for (const c of o.checks) {
    const before = await wtStatus(o.wt)
    const { timedOut: _t, ...ran } = await runSandboxed(c.command, o.wt.path, o.timeoutMs, o.profilePath, c.id, o.onSpawn)
    const r: CheckOutcome = { ...ran, kind: c.kind }
    const after = await wtStatus(o.wt).catch(() => '?')
    if (after !== before || (await headOf()) !== o.head) { r.pass = false; r.outputTail += '\n[hq] 검사가 작업 폴더(파일 또는 HEAD)를 바꿈 — 실패로 처리' }
    else if (c.baseFailed && !r.pass) r.baseFailed = true
    if (c.kind === 'new' && o.basePassed?.[c.id]) warnings.push(`[${c.id}] 이 검사는 base에서도 통과해서 새 동작을 확인하지 않아요`)
    results.push(r)
  }
  const secrets = await secretScan(o.wt.mirror, o.base, o.head)
  return { checks: results, secrets, pass: results.every((r) => r.pass || r.baseFailed) && secrets.length === 0, error: null, warnings }
}

/**
 * Runs checks once on the base in a throwaway mirror worktree (§9 baseline — recorded, never an exemption).
 * `setup` runs first; if it fails every check counts as failed on the base.
 */
export async function baseline(o: { mirror: string; base: string; path: string; checks: CheckSpec[]; setup: string | null; timeoutMs: number; sandbox: (wt: string) => SandboxOpts; profilePath: string; onSpawn?: OnSpawn }): Promise<Record<string, BaseResult>> {
  const res: Record<string, BaseResult> = {}
  if (!o.checks.length) return res
  const wt = await verifyWorktree(o.mirror, o.path, o.base)
  try {
    atomicWrite(o.profilePath, sandboxProfile(o.sandbox(wt.path)))
    if (o.setup) {
      const s = await runSandboxed(o.setup, wt.path, o.timeoutMs, o.profilePath, 'setup', o.onSpawn)
      if (!s.pass) { for (const c of o.checks) res[c.id] = { pass: false, exitCode: null, timedOut: false, setupFailed: true, tail: s.outputTail.slice(-1500) }; return res }
    }
    for (const c of o.checks) {
      const r = await runSandboxed(c.command, wt.path, o.timeoutMs, o.profilePath, c.id, o.onSpawn)
      res[c.id] = { pass: r.pass, exitCode: r.exitCode, timedOut: r.timedOut, tail: r.outputTail.slice(-1500) }
    }
    return res
  } finally { await removeMirrorWorktree(o.mirror, wt.path) }
}

export const checksProfile = (hqDir: string) => join(hqDir, 'checks.sb')
