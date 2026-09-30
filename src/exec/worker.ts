// Spawning and supervising detached, sandboxed `claude -p` processes (execution.md §6 §7 §13).
// The process outlives the daemon: stdin is the prompt file, stdout/stderr go straight to hq/ log files.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HqConfig } from '../config.ts'
import { atomicJson, atomicWrite, readJson } from './fsx.ts'
import { cacheEnv, childEnv, isCacheDir, makeCacheDir, sandboxProfile, wrap, type SandboxOpts } from './sandbox.ts'

export type Role = 'implement' | 'collect' | 'review'
/** `cacheDir`: the per-launch package-manager cache (§6.2), removed once the attempt's process group is gone. */
export interface ProcessInfo { pid: number; startedAt: string; sessionId: string; lstart: string | null; cacheDir?: string }

const modelArg = (cfg: HqConfig, m: string) => cfg.models[m as keyof HqConfig['models']] ?? m

/** §6 argv per role. Tool rule lists are separate argv items (rules like `Bash(git push:*)` contain spaces). */
export function claudeArgs(cfg: HqConfig, o: { role: Role; model: string; sessionId: string; resume: boolean; out: string | null; schema?: object }): string[] {
  const base = ['-p', '--output-format', 'stream-json', '--verbose', '--model', modelArg(cfg, o.model),
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]), '--max-turns', String(cfg.maxTurns)]
  const guard = ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--disallowedTools', ...cfg.workerDisallowedTools]
  if (o.role === 'implement') return [...base, '--tools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch',
    // Without --allowedTools, `git commit` is denied as "requires approval" in -p mode (verified on 2.1.285); the sandbox is the boundary.
    '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', '--permission-mode', 'acceptEdits', '--add-dir', o.out!, ...guard]
  if (o.role === 'collect') return [...base, '--tools', 'Read,Glob,Grep,WebFetch,WebSearch,Write', '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', `Write(/${o.out}/**)`, ...guard]
  return [...base, '--tools', 'Bash,Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Bash', 'Read', 'Glob', 'Grep',
    '--json-schema', JSON.stringify(o.schema), ...guard]
}

/** Start time of a live pid, or null when the process is gone or `ps` cannot run (never rejects). */
export function psLstart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } },
        (err, out) => resolve(err ? null : String(out).trim() || null))
    } catch { resolve(null) } // execFile throws synchronously on EPERM (setuid ps inside a sandbox)
  })
}

export type PsLstart = (pid: number) => Promise<string | null>

/** `ps -o pid=,lstart=,command= -p <pid>` output (LC_ALL=C), or null when the process is gone or ps cannot run (never rejects). */
export function psInfo(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('ps', ['-o', 'pid=,lstart=,command=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } },
        (err, out) => resolve(err ? null : String(out).trim() || null))
    } catch { resolve(null) }
  })
}

/**
 * Whether a `ps` line looks like one of our workers: it names the claude binary and either one of the task's paths
 * (worktree/clone) or one of its attempt sessions (`--session-id <id>` / `--resume <id>`).
 */
export function looksLikeWorker(line: string, o: { bin: string; paths: string[]; sessions: string[] }): boolean {
  if (!o.bin || !line.includes(o.bin)) return false
  return o.paths.some((p) => !!p && line.includes(p)) || o.sessions.some((s) => !!s && (line.includes(`--session-id ${s}`) || line.includes(`--resume ${s}`)))
}

/** Calls a ps function, turning a synchronous throw or a rejection into null. */
async function safeLstart(ps: PsLstart, pid: number): Promise<string | null> {
  try { return await ps(pid) } catch { return null }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Who owns a pid now (§7, §22):
 * - `same`: alive and its start time equals the recorded one — the process we started.
 * - `gone`: no process with this pid.
 * - `other`: alive with a different start time — the pid was reused.
 * - `unknown`: alive but a start time is missing on either side (ps unavailable, or never recorded).
 * Only `same` may be signalled. There is no liveness-only fallback: alive alone never means ours.
 */
export type Identity = 'same' | 'gone' | 'other' | 'unknown'

export async function identify(pid: number, lstart: string | null, ps: PsLstart = psLstart): Promise<Identity> {
  if (!pidAlive(pid)) return 'gone'
  const now = await safeLstart(ps, pid)
  if (!now) return pidAlive(pid) ? 'unknown' : 'gone'
  if (!lstart) return 'unknown'
  return now === lstart ? 'same' : 'other'
}

/** Pids whose process group id is `pgid`, or null when ps cannot run (never rejects). */
export function psGroupMembers(pgid: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    try {
      execFile('ps', ['-axo', 'pid=,pgid='], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve(null)
        const pids: number[] = []
        for (const line of String(out).split('\n')) {
          const [p, g] = line.trim().split(/\s+/).map(Number)
          if (p > 0 && g === pgid) pids.push(p)
        }
        resolve(pids)
      })
    } catch { resolve(null) }
  })
}

/** How identity is observed; tests inject failing or swapped probes. */
export interface Probe {
  lstart: PsLstart; members: (pgid: number) => Promise<number[] | null>
  /** `ps -o pid=,lstart=,command=` line for the lingering-worker card (default psInfo). */
  info?: (pid: number) => Promise<string | null>
}
export const defaultProbe: Probe = { lstart: psLstart, members: psGroupMembers, info: psInfo }

/**
 * Identity of the process group led by `pid`. When the leader is gone but members of its group remain, the group is
 * still ours: the kernel never hands out a pid that is in use as a process group id. When the pid was reused (`other`),
 * the old group was necessarily empty.
 */
export async function groupIdentity(pid: number, lstart: string | null, probe: Probe = defaultProbe): Promise<Identity> {
  const id = await identify(pid, lstart, probe.lstart)
  if (id !== 'gone') return id
  let members: number[] | null
  try { members = await probe.members(pid) } catch { members = null }
  if (members === null) return 'unknown'
  return members.length ? 'same' : 'gone'
}

/** Signals the process group `-pid` only; never a bare pid (a failed group kill is not retried on the pid). */
export function killGroup(pid: number, sig: NodeJS.Signals): boolean {
  if (!(pid > 1)) return false
  try { process.kill(-pid, sig); return true } catch { return false }
}

/** Signals the group only when it is confirmed ours (`same`); returns the identity it saw. */
export async function signalGroup(pid: number, lstart: string | null, sig: NodeJS.Signals, probe: Probe = defaultProbe): Promise<Identity> {
  const id = await groupIdentity(pid, lstart, probe)
  if (id === 'same') killGroup(pid, sig)
  return id
}

/**
 * SIGTERM the whole process group now and SIGKILL it after the grace period (§7.4) — each only while the group is
 * confirmed ours; identity is checked again right before the SIGKILL.
 */
export async function terminateGroup(pid: number, lstart: string | null, graceMs = 10_000, probe: Probe = defaultProbe): Promise<Identity> {
  const id = await signalGroup(pid, lstart, 'SIGTERM', probe)
  if (id === 'same') setTimeout(() => { void signalGroup(pid, lstart, 'SIGKILL', probe) }, graceMs).unref()
  return id
}

/** A process still running this session (started before hq could record its pid). §7.3 */
export function findOrphan(sessionId: string): Promise<number | null> {
  const probe = (flag: string) => new Promise<number | null>((resolve) => execFile('pgrep', ['-f', '--', `${flag} ${sessionId}`], (err, out) => {
    if (err) return resolve(null)
    const pids = String(out).split('\n').map(Number).filter((p) => p > 0 && p !== process.pid)
    resolve(pids[0] ?? null)
  }))
  return probe('--session-id').then((p) => p ?? probe('--resume'))
}

/** Exit of a spawned child, observed from spawn time on (a fast exit before tracking starts is never missed). */
export interface ExitWatch {
  exited: boolean
  code: number | null
  signal: NodeJS.Signals | null
  /** Runs `cb` once the child has exited (immediately when it already has). */
  onExit(cb: () => void): void
}

/** Watches a child from now on; also reads exitCode/signalCode in case the exit happened before the listener. */
export function watchExit(child: ChildProcess): ExitWatch {
  const cbs: (() => void)[] = []
  const w: ExitWatch = {
    exited: false, code: null, signal: null,
    onExit(cb) { if (w.exited) cb(); else cbs.push(cb) },
  }
  const done = (code: number | null, signal: NodeJS.Signals | null) => {
    if (w.exited) return
    w.exited = true; w.code = code; w.signal = signal
    for (const cb of cbs.splice(0)) cb()
  }
  child.once('exit', done)
  child.once('close', (code, signal) => done(code, signal))
  if (child.exitCode !== null || child.signalCode !== null) done(child.exitCode, child.signalCode as NodeJS.Signals | null)
  return w
}

export interface Launched { info: ProcessInfo; child: ChildProcess; exit: ExitWatch }

/** Thrown by launch() when `proceed` says the attempt must not start any more (nothing was spawned). */
export class LaunchAborted extends Error {}

/**
 * Writes prompt.md, spec.json and the sandbox profile into hq/, spawns the CLI inside the sandbox
 * as its own process group, and records process.json atomically. Throws when the process cannot start.
 * `proceed` is asked right before the spawn (there is no await between the two); false → LaunchAborted, nothing spawned.
 */
export async function launch(o: { claudeBin: string; argv: string[]; cwd: string; hqDir: string; outDir: string | null; prompt: string; sessionId: string; spec: object; sandbox: SandboxOpts; proceed?: () => boolean }, ps: PsLstart = psLstart): Promise<Launched> {
  mkdirSync(o.hqDir, { recursive: true })
  if (o.outDir) mkdirSync(o.outDir, { recursive: true })
  atomicWrite(join(o.hqDir, 'prompt.md'), o.prompt)
  const profile = join(o.hqDir, 'sandbox.sb')
  atomicWrite(profile, sandboxProfile(o.sandbox))
  const argv = wrap([o.claudeBin, ...o.argv], profile)
  atomicJson(join(o.hqDir, 'spec.json'), { argv: argv.map((a) => (a.length > 2000 ? a.slice(0, 2000) + '…' : a)), cwd: o.cwd, ...o.spec })
  if (o.proceed && !o.proceed()) throw new LaunchAborted('시작 전에 취소됨')
  const cacheDir = makeCacheDir()
  const env = childEnv({ ...cacheEnv(cacheDir), ...(o.outDir ? { HQ_ATTEMPT_OUT: o.outDir } : {}) })
  const fin = openSync(join(o.hqDir, 'prompt.md'), 'r')
  const fout = openSync(join(o.hqDir, 'stream.jsonl'), 'a')
  const ferr = openSync(join(o.hqDir, 'stderr.log'), 'a')
  let child: ChildProcess
  let exit: ExitWatch
  try {
    child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env, detached: true, stdio: [fin, fout, ferr] })
    exit = watchExit(child)
  } finally { closeSync(fin); closeSync(fout); closeSync(ferr) }
  const pid = await new Promise<number>((resolve, reject) => {
    if (child.pid) { child.once('error', () => {}); return resolve(child.pid) }
    child.once('error', reject)
  }).catch((e) => { removeCacheDir(cacheDir); throw e })
  child.unref()
  // ps may be unavailable (e.g. setuid exec denied inside a sandbox); the worker is already running and must be tracked.
  // A null lstart makes its identity `unknown` after the handle is gone (e.g. after a restart): never signalled.
  const info: ProcessInfo = { pid, startedAt: new Date().toISOString(), sessionId: o.sessionId, lstart: exit.exited ? null : await safeLstart(ps, pid), cacheDir }
  atomicJson(join(o.hqDir, 'process.json'), info)
  return { info, child, exit }
}

/** Deletes a per-launch cache folder; anything that is not one (see isCacheDir) is left alone. */
export function removeCacheDir(dir: string | undefined): void {
  if (dir && isCacheDir(dir)) rmSync(dir, { recursive: true, force: true })
}

export const readProcessInfo = (hqDir: string) => readJson<ProcessInfo>(join(hqDir, 'process.json'))
