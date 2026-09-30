// macOS Seatbelt boundary for workers, reviewers, setup and check commands (execution.md §6.2).
// SBPL: later rules take precedence. v4 layout (allow-lists, measured on macOS 26.5 / CLI 2.1.285):
//   signals: only processes of this same sandbox instance
//   mach-lookup: deny, then the measured allow-list (MACH_SERVICES) — closes LaunchServices/launchd escapes
//   reads: deny $HOME, $HQ_HOME and registered projects, then re-allow the measured home list + own paths
//   writes: deny outside own paths/temp/own ~/.claude/projects/<cwd>/, then $HQ_HOME, projects, the rest of ~/.claude
// Only content reads are denied; metadata (lstat of ancestors) stays allowed, or Node's resolver fails with EPERM.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, basename, join } from 'node:path'

export interface SandboxOpts {
  /** The one repository/worktree this process may write (work clone, verification/review/integration worktree). */
  worktree: string
  /** Attempt out/ folder (read-write), or null when the command submits nothing (checks, setup). */
  out: string | null
  hqHome: string
  /** Folder holding the daemon token (dirname of HQ_TOKEN_FILE). */
  tokenDir: string
  hqPort: number
  extraWritable: string[]
  /** Registered project checkouts: never readable or writable (workers use their clone of the hq mirror). */
  projects: string[]
  /** The hq bare mirror the worktree borrows objects from (read-only), or null. */
  mirror?: string | null
  /** Extra read-only roots, e.g. the folder of a configured absolute `claudeBin` (see claudeBinReadable). */
  readable?: string[]
  /** Home directory for ~ paths (tests use a fake one). */
  home?: string
}

/** Seatbelt matches resolved paths (/var → /private/var); resolve the deepest existing ancestor. */
export function real(p: string): string {
  let cur = p
  const rest: string[] = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return p
    rest.unshift(basename(cur)); cur = parent
  }
  return join(realpathSync(cur), ...rest)
}

const q = (s: string) => JSON.stringify(s) // SBPL string literal: same escaping as JSON for our paths
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sub = (p: string) => `(subpath ${q(p)})`
const lit = (p: string) => `(literal ${q(p)})`
const rx = (r: string) => `(regex ${q(r)})`

/**
 * Mach services a sandboxed process may look up; everything else is denied — LaunchServices (lsd, launchservicesd),
 * cfprefsd (`defaults write` into other apps' domains), pasteboard, windowserver, tccd … The S1 escape
 * (NSWorkspace.openApplication → launchd starts an unsandboxed app) needs them.
 * Measured on macOS 26.5: under `(allow mach-lookup (with report))` the real CLI worker (haiku: Read + Bash git status
 * + Write), git status/commit, npm ci (network), node --test, npx tsc, coreutils, whoami/id/python pwd, curl https and
 * git ls-remote https looked up 14 names; every one except these two could be denied with all of that still passing
 * (notification_center, logd, cfprefsd.*, securityd.xpc, trustd.agent, FSEvents, analyticsd, DNSConfiguration,
 * opendirectoryd.membership, bsd.dirhelper, launchservicesd, lsd.modifydb: denial only loses logs/prefs/fallbacks).
 */
export const MACH_SERVICES: [string, string][] = [
  ['com.apple.SecurityServer', 'securityd: login-keychain read of the subscription token (without it the CLI answers "Not logged in")'],
  ['com.apple.system.opendirectoryd.libinfo', 'getpwuid/getgrgid (without it whoami, id -un and python pwd fail)'],
]

/**
 * ~ entries the sandbox may read; everything else under $HOME (~/.codex, ~/.config/*, ~/Library/Application Support,
 * cookies, browser profiles, ~/Documents, shell rc files …) is content-denied. Entries ending in '/' are folders.
 * Measured one at a time with the real worker run + git/npm/node workloads: only Library/Keychains is strictly
 * required (denied → "Not logged in"); the rest are design allowances whose denial did not break a run today.
 * ~/.claude and ~/.claude.json are NOT listed: the CLI (-p, --setting-sources "", then --resume) runs with both
 * unreadable except its own projects/<encoded cwd>/ folder, which is granted separately (other projects'
 * transcripts and memory stay unreadable).
 */
export const HOME_READABLE: [string, string][] = [
  ['Library/Keychains/', 'REQUIRED: login keychain holds the subscription token (items stay ACL-gated by securityd)'],
  ['.local/bin/', 'the `claude` launcher symlink (exec itself works without read access)'],
  ['.local/share/claude/', 'the CLI versions/<v> binary the launcher resolves to'],
  ['.gitconfig', 'user git config (identity fallback, aliases, safe.directory)'],
  ['.config/git/', 'git global ignore/attributes'],
  ['.npm/', 'npm cache, read-only (writes go to the per-run cache, see cacheEnv)'],
]

/**
 * ~/.claude writes: only the worker's own projects/<encoded cwd>/ folder (transcript; --resume needs it), minus its memory/.
 * Measured on 2.1.285 (-p, haiku, Read + Bash + Write, then --resume): it tries backups/, cache/model-catalog/,
 * session-env/, sessions/, shell-snapshots/, ~/.local/state/claude/locks and ~/.claude.json(.lock|.tmp.*), and every
 * one of those writes can be denied without breaking the run.
 */
const CLAUDE_PROTECTED_DIRS = ['skills', 'agents', 'commands', 'plugins', 'hooks']

/** The CLI's projects/ folder name for a cwd: every non-alphanumeric → '-'; >200 chars → 200-char prefix + '-' + hash. */
export function claudeProjectDir(cwd: string): { name: string; truncated: boolean } {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return s.length <= 200 ? { name: s, truncated: false } : { name: s.slice(0, 200), truncated: true }
}

let userTemp: string[] | null = null
/**
 * Writable temp roots: /private/tmp and this user's temp folder (/var/folders/<x>/<y>/T), not all of /var/folders —
 * its sibling C/ holds per-user caches (clang/swift module caches, app caches) that unsandboxed programs load (S4).
 */
function tempRoots(): string[] {
  if (!userTemp) {
    let darwin: string | null = null
    try { darwin = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim() || null } catch { /* not macOS */ }
    userTemp = [...new Set([real(tmpdir()), ...(darwin ? [real(darwin)] : [])])].filter((p) => p !== '/private/tmp' && !p.startsWith('/private/tmp/'))
  }
  return ['/private/tmp', ...userTemp]
}

export function sandboxProfile(o: SandboxOpts): string {
  const home = real(o.home ?? homedir())
  const hq = real(o.hqHome)
  const own = [o.worktree, ...(o.out ? [o.out] : [])].map(real)
  const projects = o.projects.map(real)
  const extra = o.extraWritable.map(real)
  const claudeDir = join(home, '.claude')
  const proj = claudeProjectDir(real(o.worktree))
  const claudeOwn = proj.truncated
    ? rx(`^${reEsc(join(claudeDir, 'projects', proj.name))}-[^/]*(/|$)`)
    : sub(join(claudeDir, 'projects', proj.name))
  // Its memory/ is loaded into later sessions in the same clone: never writable (a worker cannot plant instructions).
  const claudeOwnMemory = proj.truncated
    ? rx(`^${reEsc(join(claudeDir, 'projects', proj.name))}-[^/]*/memory(/|$)`)
    : sub(join(claudeDir, 'projects', proj.name, 'memory'))
  const homeRead = HOME_READABLE.map(([p]) => (p.endsWith('/') ? sub(join(home, p.slice(0, -1))) : lit(join(home, p))))
  const secretContents = [
    sub(real(o.tokenDir)), rx(`^${reEsc(hq)}/hq\\.db`), sub(join(hq, 'runs')), sub(join(hq, 'logs')), sub(join(hq, 'work')),
    sub(join(home, '.ssh')), sub(join(home, '.aws')), sub(join(home, '.config/gh')), lit(join(home, '.netrc')), lit(join(home, '.docker/config.json')),
    ...projects.map((p) => rx(`^${reEsc(p)}/(.*/)?\\.env[^/]*$`)),
  ]
  const writable = [...own, ...tempRoots(), '/dev', ...extra]
  const claudeControl = [rx(`^${reEsc(claudeDir)}/settings[^/]*\\.json$`), lit(join(claudeDir, 'CLAUDE.md')), ...CLAUDE_PROTECTED_DIRS.map((d) => sub(join(claudeDir, d)))]
  return [
    '(version 1)',
    '(allow default)',
    // F04: no signals to processes outside this sandbox instance (hq, the user's shells, other workers).
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    // S1: mach-lookup allow-list (see MACH_SERVICES).
    '(deny mach-lookup)',
    ...MACH_SERVICES.map(([n, why]) => `(allow mach-lookup (global-name ${q(n)})) ; ${why}`),
    // S2: $HOME, $HQ_HOME and project checkouts are unreadable except the measured list, the mirror and own paths.
    `(deny file-read-data ${[sub(home), sub(hq), ...projects.map(sub)].join(' ')})`,
    `(allow file-read-data ${[...homeRead, ...extra.map(sub), ...(o.mirror ? [sub(real(o.mirror))] : []), ...(o.readable ?? []).map((p) => sub(real(p))), claudeOwn].join(' ')})`,
    `(deny file-read-data file-write* ${secretContents.join(' ')})`,
    `(allow file-read-data file-write* ${own.map(sub).join(' ')})`,
    // S3/S4: writes only to own paths, temp, the worker's own ~/.claude/projects/<cwd>/ folder and extraWritable.
    `(deny file-write* (require-not (require-any ${writable.map(sub).join(' ')} ${claudeOwn})))`,
    // $HQ_HOME (mirrors, other worktrees, the DB) and user checkouts are never writable, even when they sit under an
    // allow-listed temp root; the process's own paths are re-allowed right after.
    `(deny file-write* ${[sub(hq), ...projects.map(sub)].join(' ')})`,
    `(allow file-write* ${own.map(sub).join(' ')})`,
    // ~/.claude and ~/.claude.json* are denied explicitly too, so the rule holds even when $HOME sits under a temp root.
    `(deny file-write* (require-all ${sub(claudeDir)} (require-not ${claudeOwn})) ${rx(`^${reEsc(home)}/\\.claude\\.json`)})`,
    `(deny file-write* ${[...claudeControl, claudeOwnMemory].join(' ')})`,
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl"))',
    '(deny appleevent-send)',
    `(deny network-outbound (remote ip ${q(`localhost:${o.hqPort}`)}))`,
    '',
  ].join('\n')
}

/** Read root for a configured absolute `claudeBin` outside the allow-list (its resolved folder), else nothing. */
export function claudeBinReadable(bin: string): string[] {
  if (!bin.startsWith('/') || !existsSync(bin)) return []
  return [dirname(realpathSync(bin))]
}

// Test-only seam: reachable solely by direct import (never from config, env vars, CLI flags or HTTP).
let sandboxWrapper = 'sandbox-exec'
export function setSandboxWrapperForTests(bin: string | null): void { sandboxWrapper = bin ?? 'sandbox-exec' }

export function wrap(argv: string[], profilePath: string): string[] {
  return [sandboxWrapper, '-f', profilePath, ...argv]
}

/**
 * A fresh, unguessable per-run cache path under the (writable) temp dir, so npm/pip/XDG caches never touch ~.
 * Not created here: the tools create it on first use, so runs that install nothing leave nothing behind.
 */
export function makeCacheDir(): string {
  return join(realpathSync(tmpdir()), `hq-cache-${randomUUID()}`)
}

/** True for a folder made by makeCacheDir (guards the recursive delete). */
export function isCacheDir(p: string): boolean {
  return dirname(p) === realpathSync(tmpdir()) && basename(p).startsWith('hq-cache-')
}

/** S4: package-manager caches point at the per-run folder, so nothing sandboxed writes a cache that is later run outside. */
export const cacheEnv = (dir: string): Record<string, string> => ({ npm_config_cache: join(dir, 'npm'), XDG_CACHE_HOME: dir, PIP_CACHE_DIR: join(dir, 'pip') })

const PASS = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL']

/** Allow-listed environment only: no HQ_TOKEN, ANTHROPIC_ or OPENAI_ keys, or SSH agent reach sandboxed processes. */
export function childEnv(extra: Record<string, string> = {}, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of PASS) if (from[k] !== undefined) env[k] = from[k]
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'remote.pushDefault', GIT_CONFIG_VALUE_0: 'hq-no-push',
    GIT_CONFIG_KEY_1: 'push.default', GIT_CONFIG_VALUE_1: 'nothing',
  }, extra)
  return env
}
