// Mechanical verification run by hq itself (execution.md §9).
// Acceptance `check` commands were shown verbatim on the approved plan card, so they run as approved —
// but inside the sandbox, with a minimal env, stdin /dev/null, in their own process group.
import { spawn } from 'node:child_process'
import { lstatSync, readlinkSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { CheckResult } from '../types.ts'
import { atomicWrite } from './fsx.ts'
import { hqGit, removeMirrorWorktree, SAFE_DIFF, verifyWorktree, wtGit, type MirrorWorktree } from './repos.ts'
import { cacheEnv, childEnv, makeCacheDir, sandboxProfile, wrap, type SandboxOpts } from './sandbox.ts'

/** `baseFailed`: a regression check that already failed on the base for an ordinary reason — still run; its failure alone does not fail the file. */
export interface CheckSpec { id: string; command: string; kind?: 'new' | 'regression'; baseFailed?: boolean }
export interface SecretHit { commit: string; file: string; line: number; pattern: string }
export type CheckOutcome = CheckResult & { kind?: string; baseFailed?: boolean }
/**
 * `warnings`: new-kind checks that already passed on the base (they do not prove the new behaviour).
 * `manual`: regression checks that failed on the base and failed again on the candidate — handed to the reviewer (§9).
 * `baseTails`: base output tail for each id in `manual`.
 */
export interface ChecksFile {
  checks: CheckOutcome[]; secrets: SecretHit[]; pass: boolean; error: string | null; warnings?: string[]; manual?: string[]; baseTails?: Record<string, string>
  /** The worktree's tracked content differed from the commit under test before any check ran (setup changed it): an environment failure. */
  setupChanged?: boolean
  /** Untracked and ignored files present before the first check, i.e. made by setup (the worktree is fresh). Recorded, never a failure. */
  setupCreated?: SetupCreated
}
/** `count`: files in total; `sample`: first 20 entries, files under an ignored directory collapsed to `dir/ (N개)`. */
export interface SetupCreated { count: number; sample: string[] }
/** One check's result on the base (§9 baseline). `setupFailed`: the project setup failed, so the check never ran. */
export interface BaseResult { pass: boolean; exitCode: number | null; timedOut: boolean; setupFailed?: boolean; tail: string }
/** The base run says nothing about the code: setup failed, timed out, or the command could not be found/executed. */
export const envFailure = (b: BaseResult): boolean => !!b.setupFailed || b.timedOut || b.exitCode === 126 || b.exitCode === 127
/** A base-failed check may be handed to the reviewer only when it failed like on the base: not a timeout or 126/127. */
export const plainFailure = (r: { pass: boolean; exitCode: number | null }): boolean => !r.pass && r.exitCode !== null && r.exitCode !== 126 && r.exitCode !== 127
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
export function runSandboxed(command: string, cwd: string, timeoutMs: number, profilePath: string, id = 'cmd', onSpawn?: OnSpawn, isolatedHome = false): Promise<CheckResult & { timedOut: boolean }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const out = new LineKeeper()
    const argv = wrap(['/bin/sh', '-c', command], profilePath)
    const cache = makeCacheDir() // per-command package-manager cache (§6.2), removed when the command ends
    const child = spawn(argv[0], argv.slice(1), { cwd, env: childEnv({ ...cacheEnv(cache), ...(isolatedHome ? { HOME: cache } : {}) }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
      rmSync(cache, { recursive: true, force: true })
      let tail = out.text()
      if (timedOut) tail += `\n[hq] 시간 초과 (${Math.round(timeoutMs / 1000)}초) — 프로세스 그룹 종료`
      resolve({ id, command, exitCode: timedOut ? null : code, durationMs: Date.now() - started, pass: !timedOut && code === 0, outputTail: tail, timedOut })
    })
  })
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['private-key', /-----BEGIN .*PRIVATE KEY/],
  ['anthropic-key', /sk-ant-/],
  ['openai-key', /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
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

const LIST_MAX = 10
const fileList = (files: string[]) => files.slice(0, LIST_MAX).join(', ') + (files.length > LIST_MAX ? ` 외 ${files.length - LIST_MAX}개` : '')
export const setupChangedReason = (files: string[]) => `setup이 추적 파일을 바꿨어요: ${fileList(files)}`

const gitBlobSha = (data: Buffer | string) => { const b = Buffer.isBuffer(data) ? data : Buffer.from(data); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex') }

/**
 * Tracked files whose content (or type/mode) in the worktree or index differs from commit `sha` (§9, F01).
 * Content-based: every tracked file is hashed (`git hash-object`, with the repository's attributes), not only
 * those whose stat changed; git's own worktree/index diffs catch deletions, type changes and index edits.
 * Untracked and ignored files are not looked at (build outputs are allowed). Fails closed: a git error is a change.
 */
export async function trackedChanges(wt: MirrorWorktree, sha: string): Promise<string[]> {
  const changed = new Set<string>()
  const z = (out: string) => out.split('\0').filter(Boolean)
  const w = await wtGit(wt, ['diff', '--name-only', '-z', '--no-renames', '--ignore-submodules', ...SAFE_DIFF, sha, '--'])
  const c = await wtGit(wt, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--ignore-submodules', ...SAFE_DIFF, sha, '--'])
  const t = await wtGit(wt, ['ls-tree', '-r', '-z', '--full-tree', sha])
  if (w.code !== 0 || c.code !== 0 || t.code !== 0) return [`(git 확인 실패: ${(w.stderr || c.stderr || t.stderr).trim().slice(0, 200)})`]
  for (const f of [...z(w.stdout), ...z(c.stdout)]) changed.add(f)
  const regular: { path: string; blob: string }[] = []
  for (const entry of z(t.stdout)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]*)$/.exec(entry)
    if (!m) continue
    const [, mode, type, blob, path] = m
    if (type !== 'blob') continue // submodules
    let st
    try { st = lstatSync(join(wt.path, path)) } catch { changed.add(path); continue }
    if (mode === '120000') {
      if (!st.isSymbolicLink() || gitBlobSha(readlinkSync(join(wt.path, path), { encoding: 'buffer' })) !== blob) changed.add(path)
      continue
    }
    if (!st.isFile() || st.isSymbolicLink() || ((st.mode & 0o111) !== 0) !== (mode === '100755')) { changed.add(path); continue }
    regular.push({ path, blob })
  }
  if (regular.length) {
    const h = await hashPaths(wt, regular.map((r) => r.path))
    if (!h) return [...changed, '(내용 해시 실패)']
    regular.forEach((r, i) => { if (h[i] !== r.blob) changed.add(r.path) })
  }
  return [...changed].sort()
}

/** `git hash-object` of worktree paths (attributes applied like on checkout), in batches to stay under argv limits. */
async function hashPaths(wt: MirrorWorktree, paths: string[]): Promise<string[] | null> {
  const out: string[] = []
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500)
    const r = await hqGit(wt.gitDir, wt.path, ['hash-object', '--', ...chunk], { cwd: wt.path })
    const l = r.stdout.split('\n').filter(Boolean)
    if (r.code !== 0 || l.length !== chunk.length) return null
    out.push(...l)
  }
  return out
}

const SAMPLE_MAX = 20

/**
 * Untracked (non-ignored) files plus ignored files in the worktree. Files under an ignored directory (node_modules/,
 * dist/ …) are counted but shown as one `dir/ (N개)` entry. Null when git fails (nothing recorded).
 */
export async function untrackedFiles(wt: MirrorWorktree): Promise<SetupCreated | null> {
  const z = (out: string) => out.split('\0').filter(Boolean)
  const plain = await wtGit(wt, ['ls-files', '-z', '-o', '--exclude-standard'])
  const ignored = await wtGit(wt, ['ls-files', '-z', '-o', '-i', '--exclude-standard'])
  const dirs = await wtGit(wt, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'])
  if (plain.code !== 0 || ignored.code !== 0 || dirs.code !== 0) return null
  const ignoredDirs = z(dirs.stdout).filter((d) => d.endsWith('/'))
  const perDir = new Map<string, number>(ignoredDirs.map((d) => [d, 0]))
  const loose: string[] = []
  for (const f of z(ignored.stdout)) {
    const d = ignoredDirs.find((x) => f.startsWith(x))
    if (d) perDir.set(d, perDir.get(d)! + 1)
    else loose.push(f)
  }
  const files = [...z(plain.stdout), ...loose]
  const entries = [...files, ...[...perDir].map(([d, n]) => `${d} (${n}개)`)].sort()
  return { count: files.length + [...perDir.values()].reduce((a, b) => a + b, 0), sample: entries.slice(0, SAMPLE_MAX) }
}

/** `setup이 만든 파일: a, b, node_modules/ (3개) (모두 5개)` for the review prompt; '' when none. */
export const setupCreatedLine = (s: SetupCreated | undefined): string =>
  s && s.count ? `setup이 만든 파일: ${s.sample.join(', ')} (모두 ${s.count}개)` : ''

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

/**
 * Runs checks in the sandbox. No baseline exemption (v3): every automatic check must pass.
 * Before the first check the worktree's tracked content must equal `head` (setup may only add untracked/ignored
 * files); after every check it is compared again, so a check that rewrites tracked files fails (§9, F01).
 */
export async function runChecks(o: RunChecksOpts): Promise<ChecksFile> {
  const headOf = async () => { const r = await wtGit(o.wt, ['rev-parse', 'HEAD']); return r.code === 0 ? r.stdout.trim() : null }
  const head = await headOf()
  if (head !== o.head) return { checks: [], secrets: [], pass: false, error: `검증 worktree HEAD(${head?.slice(0, 10) ?? '없음'})가 기록된 head_sha와 다름` }
  const before = await trackedChanges(o.wt, o.head)
  if (before.length) return { checks: [], secrets: [], pass: false, error: setupChangedReason(before), setupChanged: true }
  // Callers hand a fresh worktree (verifyWorktree) and run only setup on it before this point: whatever untracked or
  // ignored file exists now was made by setup. Content checks ignore such files, so they are recorded for the reviewer.
  const created = await untrackedFiles(o.wt)
  const setupCreated = created?.count ? { setupCreated: created } : {}
  atomicWrite(o.profilePath, sandboxProfile(o.sandbox))
  const results: CheckOutcome[] = []
  const warnings: string[] = []
  let dirty = false
  for (const c of o.checks) {
    const { timedOut: _t, ...ran } = await runSandboxed(c.command, o.wt.path, o.timeoutMs, o.profilePath, c.id, o.onSpawn, !!o.sandbox.graphics)
    const r: CheckOutcome = { ...ran, kind: c.kind }
    // Once a check changed tracked files, later checks run on content that is not the commit: they fail too.
    const changed = dirty ? [] : await trackedChanges(o.wt, o.head).catch(() => ['?'])
    const moved = (await headOf()) !== o.head
    if (dirty) { r.pass = false; r.outputTail += '\n[hq] 앞선 검사가 추적 파일을 바꾼 뒤라 결과를 인정하지 않음 — 실패로 처리' }
    else if (changed.length || moved) {
      dirty = true
      r.pass = false
      r.outputTail += `\n[hq] 검사가 작업 폴더의 추적 파일 또는 HEAD를 바꿈${changed.length ? `: ${fileList(changed)}` : ''} — 실패로 처리`
    } else if (c.baseFailed && plainFailure(r)) r.baseFailed = true
    if (c.kind === 'new' && o.basePassed?.[c.id]) warnings.push(`[${c.id}] 이 검사는 base에서도 통과해서 새 동작을 확인하지 않아요`)
    results.push(r)
  }
  const secrets = await secretScan(o.wt.mirror, o.base, o.head)
  return { checks: results, secrets, pass: results.every((r) => r.pass || r.baseFailed) && secrets.length === 0, error: null, warnings, ...setupCreated }
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
    const setupFailed = (tail: string) => { for (const c of o.checks) res[c.id] = { pass: false, exitCode: null, timedOut: false, setupFailed: true, tail }; return res }
    if (o.setup) {
      const s = await runSandboxed(o.setup, wt.path, o.timeoutMs, o.profilePath, 'setup', o.onSpawn, !!o.sandbox(wt.path).graphics)
      if (!s.pass) return setupFailed(s.outputTail.slice(-1500))
    }
    const changed = await trackedChanges(wt, o.base)
    if (changed.length) return setupFailed(setupChangedReason(changed))
    let dirty = false
    for (const c of o.checks) {
      const r = await runSandboxed(c.command, wt.path, o.timeoutMs, o.profilePath, c.id, o.onSpawn, !!o.sandbox(wt.path).graphics)
      res[c.id] = { pass: r.pass && !dirty, exitCode: r.exitCode, timedOut: r.timedOut, tail: r.outputTail.slice(-1500) }
      if (!dirty && (await trackedChanges(wt, o.base)).length) {
        dirty = true
        res[c.id] = { ...res[c.id], pass: false, tail: `${res[c.id].tail}\n[hq] 검사가 추적 파일을 바꿈 — 실패로 기록` }
      }
    }
    return res
  } finally { await removeMirrorWorktree(o.mirror, wt.path) }
}

export const checksProfile = (hqDir: string) => join(hqDir, 'checks.sb')
