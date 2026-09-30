// Shared CLI context: resolved paths, env overrides, output sinks and command runners.
// Every side effect (launchctl, open, build scripts) goes through `act`, which only prints under HQ_DRY_RUN=1.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { loadConfig } from '../config.ts'

const LABEL_BASE = 'com.agent-headquarters'

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface RunOpts { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }

export interface Ctx {
  /** Repository root (contains src/, config/, pet/). */
  root: string
  /** $HQ_HOME: runtime data, logs, pidfile. */
  home: string
  agentsDir: string
  port: number
  tokenFile: string
  /** Directory for the optional `hq` symlink (~/.local/bin). */
  binDir: string
  /** The user's home directory (for `~` shortening). */
  userHome: string
  uid: number
  dryRun: boolean
  env: NodeJS.ProcessEnv
  out(line: string): void
  err(line: string): void
  /** Read-only command: always runs, never throws (ENOENT → code 127). */
  run(cmd: string, args: string[], opts?: RunOpts): Promise<ExecResult>
  /** Side-effecting command: printed instead of run when dryRun. */
  act(cmd: string, args: string[], opts?: RunOpts): Promise<ExecResult>
}

export const expandHome = (p: string, home: string) => p.replace(/^~(?=\/|$)/, home)
export const shortenHome = (p: string, home: string) => (p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p)

/** Quote for display only (commands are always run with execFile argv, never through a shell). */
export const showCmd = (cmd: string, args: string[]) =>
  [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')

export function runCmd(cmd: string, args: string[], opts: RunOpts = {}): Promise<ExecResult> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 30_000, cwd: opts.cwd, env: opts.env, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (e, stdout, stderr) => {
        const err = e as (NodeJS.ErrnoException & { code?: number | string }) | null
        const code = !err ? 0 : err.code === 'ENOENT' ? 127 : typeof err.code === 'number' ? err.code : 1
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) })
      })
  })
}

/** Finds an executable on PATH (or returns the path itself when it contains a slash and exists). */
export function findBin(name: string, pathEnv: string | undefined): string | null {
  if (name.includes('/')) return existsSync(name) ? resolve(name) : null
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeAtomic(file: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, file)
}

export function makeCtx(env: NodeJS.ProcessEnv = process.env, over: Partial<Ctx> = {}): Ctx {
  const userHome = env.HOME || homedir()
  const root = over.root ?? (env.HQ_ROOT ? resolve(env.HQ_ROOT) : resolve(import.meta.dirname, '../..'))
  let home: string
  try { home = loadConfig(root, env).home } catch { home = expandHome(env.HQ_HOME ?? '~/.hq', userHome) }
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(p))
  const dryRun = env.HQ_DRY_RUN === '1'
  const ctx: Ctx = {
    root,
    home: abs(expandHome(home, userHome)),
    agentsDir: abs(expandHome(env.HQ_LAUNCH_AGENTS_DIR ?? join(userHome, 'Library/LaunchAgents'), userHome)),
    port: Number(env.HQ_PORT ?? 7777),
    tokenFile: abs(expandHome(env.HQ_TOKEN_FILE ?? join(userHome, '.config/hq/token'), userHome)),
    binDir: abs(expandHome(env.HQ_BIN_DIR ?? join(userHome, '.local/bin'), userHome)),
    userHome,
    uid: process.getuid?.() ?? 501,
    dryRun,
    env,
    out: (l: string) => { process.stdout.write(l + '\n') },
    err: (l: string) => { process.stderr.write(l + '\n') },
    run: runCmd,
    act: async (cmd, args, opts) => {
      if (ctx.dryRun) { ctx.out(`[dry-run] ${showCmd(cmd, args)}`); return { code: 0, stdout: '', stderr: '' } }
      return ctx.run(cmd, args, opts)
    },
    ...over,
  }
  if (!Number.isInteger(ctx.port) || ctx.port <= 0 || ctx.port > 65535) throw new Error(`HQ_PORT가 올바르지 않음: ${env.HQ_PORT}`)
  return ctx
}

export const logsDir = (ctx: Ctx) => join(ctx.home, 'logs')
export const daemonLog = (ctx: Ctx) => join(logsDir(ctx), 'daemon.log')
export const petLog = (ctx: Ctx) => join(logsDir(ctx), 'pet.log')
export const pidFile = (ctx: Ctx) => join(ctx.home, 'daemon.pid')
/** Written by the daemon itself (single-instance lock, exec-engine-spec §134). */
export const lockFile = (ctx: Ctx) => join(ctx.home, 'daemon.lock')
export const plistPath = (ctx: Ctx, label: string) => join(ctx.agentsDir, `${label}.plist`)

/**
 * launchd labels are global per user, so each installation gets its own. The default installation
 * (HQ_HOME = ~/.hq and port 7777) keeps the plain labels it has always used; any other one gets
 * `com.agent-headquarters.<8 hex of sha256("<home>:<port>")>.daemon|pet`.
 */
export function installSuffix(ctx: Ctx): string | null {
  const home = resolve(ctx.home)
  if (home === resolve(ctx.userHome, '.hq') && ctx.port === 7777) return null
  return createHash('sha256').update(`${home}:${ctx.port}`).digest('hex').slice(0, 8)
}
const label = (ctx: Ctx, kind: 'daemon' | 'pet') => { const s = installSuffix(ctx); return s ? `${LABEL_BASE}.${s}.${kind}` : `${LABEL_BASE}.${kind}` }
export const daemonLabel = (ctx: Ctx) => label(ctx, 'daemon')
export const petLabel = (ctx: Ctx) => label(ctx, 'pet')
export const launchdTarget = (ctx: Ctx, l: string) => `gui/${ctx.uid}/${l}`

/** The `path = <plist>` line of `launchctl print` output (the job's top-level plist), or null. */
export function launchdJobPath(printOut: string): string | null {
  const m = /^[ \t]*path = (.+?)[ \t]*$/m.exec(printOut)
  return m ? m[1] : null
}
export const samePath = (a: string, b: string) => {
  if (resolve(a) === resolve(b)) return true
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

export type LaunchdJob = 'ours' | 'foreign' | 'unloaded'
/**
 * Whether the loaded job `label` is this installation's: its plist path must be exactly plistPath(ctx, label).
 * 'foreign' (another installation's job, or output we cannot parse) must never be signalled, kickstarted or booted out.
 */
export async function launchdJob(ctx: Ctx, l: string): Promise<LaunchdJob> {
  const r = await ctx.run('launchctl', ['print', launchdTarget(ctx, l)], { timeoutMs: 5000 })
  if (r.code !== 0) return 'unloaded'
  const p = launchdJobPath(r.stdout)
  return p !== null && samePath(p, plistPath(ctx, l)) ? 'ours' : 'foreign'
}

/** The four variables that together name an installation. Setting only some of them mixes this installation with the default one. */
export const OVERRIDE_VARS = ['HQ_HOME', 'HQ_PORT', 'HQ_TOKEN_FILE', 'HQ_LAUNCH_AGENTS_DIR'] as const
export const PARTIAL_OVERRIDE_MSG = '다른 설치를 다루려면 HQ_HOME·HQ_PORT·HQ_TOKEN_FILE·HQ_LAUNCH_AGENTS_DIR를 모두 지정해 주세요'
/** Refusal message when only some of OVERRIDE_VARS are set (commands that write, delete or signal must not run then). */
export function partialOverride(ctx: Ctx): string | null {
  const set = OVERRIDE_VARS.filter((k) => (ctx.env[k] ?? '') !== '')
  return set.length > 0 && set.length < OVERRIDE_VARS.length ? PARTIAL_OVERRIDE_MSG : null
}

/** Written by `hq install`: proof that $HQ_HOME belongs to this installation, required before `--purge` deletes it. */
export const installMarker = (ctx: Ctx) => join(ctx.home, '.hq-install')
export interface InstallMarker { root: string; port: number; created: string }
export const markerContent = (ctx: Ctx): string => JSON.stringify({ root: ctx.root, port: ctx.port, created: new Date().toISOString() } satisfies InstallMarker, null, 2) + '\n'
/** True only when the marker exists, is a regular file, and names this root and port. */
export function markerMatches(ctx: Ctx): boolean {
  try {
    if (!lstatSync(installMarker(ctx)).isFile()) return false
    const m = JSON.parse(readFileSync(installMarker(ctx), 'utf8')) as Partial<InstallMarker>
    return typeof m.root === 'string' && samePath(m.root, ctx.root) && m.port === ctx.port
  } catch { return false }
}

export const petApp = (ctx: Ctx) => join(ctx.root, 'pet/HQPet.app')
export const petBinary = (ctx: Ctx) => join(petApp(ctx), 'Contents/MacOS/hqpet')
export const projectsFile = (ctx: Ctx) => join(ctx.root, 'config/projects.json')
