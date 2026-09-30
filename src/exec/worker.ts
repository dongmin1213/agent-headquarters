// Spawning and supervising detached, sandboxed `claude -p` processes (execution.md §6 §7 §13).
// The process outlives the daemon: stdin is the prompt file, stdout/stderr go straight to hq/ log files.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { HqConfig } from '../config.ts'
import { atomicJson, atomicWrite, readJson } from './fsx.ts'
import { childEnv, sandboxProfile, wrap, type SandboxOpts } from './sandbox.ts'

export type Role = 'implement' | 'collect' | 'review'
export interface ProcessInfo { pid: number; startedAt: string; sessionId: string; lstart: string | null }

const modelArg = (cfg: HqConfig, m: string) => cfg.models[m as keyof HqConfig['models']] ?? m

/** §6 argv per role. Tool rule lists are separate argv items (rules like `Bash(git push:*)` contain spaces). */
export function claudeArgs(cfg: HqConfig, o: { role: Role; model: string; sessionId: string; resume: boolean; out: string | null; schema?: object }): string[] {
  const base = ['-p', '--output-format', 'stream-json', '--verbose', '--model', modelArg(cfg, o.model),
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]), '--max-turns', String(cfg.maxTurns)]
  const guard = ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--disallowedTools', ...cfg.workerDisallowedTools]
  if (o.role === 'implement') return [...base, '--tools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch', '--permission-mode', 'acceptEdits', '--add-dir', o.out!, ...guard]
  if (o.role === 'collect') return [...base, '--tools', 'Read,Glob,Grep,WebFetch,WebSearch,Write', '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', `Write(/${o.out}/**)`, ...guard]
  return [...base, '--tools', 'Bash,Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Bash', 'Read', 'Glob', 'Grep',
    '--json-schema', JSON.stringify(o.schema), ...guard]
}

export function psLstart(pid: number): Promise<string | null> {
  return new Promise((resolve) => execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } },
    (err, out) => resolve(err ? null : String(out).trim() || null)))
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Alive and the same process we started: pid reuse is ruled out by the recorded start time. */
export async function sameProcessAlive(pid: number, lstart: string | null, startedAt: string | null): Promise<boolean> {
  if (!pidAlive(pid)) return false
  const now = await psLstart(pid)
  if (!now) return false
  if (lstart) return now === lstart
  return !!startedAt && Math.abs(Date.parse(now) - Date.parse(startedAt)) <= 2_000
}

export function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch { /* gone */ } }
}

/** SIGTERM the whole process group now and SIGKILL it after the grace period (§7.4). */
export function terminateGroup(pid: number, graceMs = 10_000): void {
  killGroup(pid, 'SIGTERM')
  setTimeout(() => killGroup(pid, 'SIGKILL'), graceMs).unref()
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

export interface Launched { info: ProcessInfo; child: ChildProcess }

/**
 * Writes prompt.md, spec.json and the sandbox profile into hq/, spawns the CLI inside the sandbox
 * as its own process group, and records process.json atomically. Throws when the process cannot start.
 */
export async function launch(o: { claudeBin: string; argv: string[]; cwd: string; hqDir: string; outDir: string | null; prompt: string; sessionId: string; spec: object; sandbox: SandboxOpts }): Promise<Launched> {
  mkdirSync(o.hqDir, { recursive: true })
  if (o.outDir) mkdirSync(o.outDir, { recursive: true })
  atomicWrite(join(o.hqDir, 'prompt.md'), o.prompt)
  const profile = join(o.hqDir, 'sandbox.sb')
  atomicWrite(profile, sandboxProfile(o.sandbox))
  const argv = wrap([o.claudeBin, ...o.argv], profile)
  atomicJson(join(o.hqDir, 'spec.json'), { argv: argv.map((a) => (a.length > 2000 ? a.slice(0, 2000) + '…' : a)), cwd: o.cwd, ...o.spec })
  const env = childEnv(o.outDir ? { HQ_ATTEMPT_OUT: o.outDir } : {})
  const fin = openSync(join(o.hqDir, 'prompt.md'), 'r')
  const fout = openSync(join(o.hqDir, 'stream.jsonl'), 'a')
  const ferr = openSync(join(o.hqDir, 'stderr.log'), 'a')
  let child: ChildProcess
  try { child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env, detached: true, stdio: [fin, fout, ferr] }) } finally { closeSync(fin); closeSync(fout); closeSync(ferr) }
  const pid = await new Promise<number>((resolve, reject) => {
    if (child.pid) { child.once('error', () => {}); return resolve(child.pid) }
    child.once('error', reject)
  })
  child.unref()
  const info: ProcessInfo = { pid, startedAt: new Date().toISOString(), sessionId: o.sessionId, lstart: await psLstart(pid) }
  atomicJson(join(o.hqDir, 'process.json'), info)
  return { info, child }
}

export const readProcessInfo = (hqDir: string) => readJson<ProcessInfo>(join(hqDir, 'process.json'))
