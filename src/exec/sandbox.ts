// macOS Seatbelt boundary for workers, reviewers, setup and check commands (execution.md §6.2).
// SBPL: later rules take precedence. Order: deny secret contents → allow own paths → deny writes outside the
// allow list → deny writes to user repos and ~/.claude control files → exec/appleevent/network denials.
// Only content reads are denied; metadata (lstat of ancestors) stays allowed, or Node's resolver fails with EPERM.
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
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
  /** Registered project checkouts: never writable, and their .env* files are unreadable. */
  projects: string[]
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
 * ~/.claude subfolders the CLI must write. Measured with the real CLI (2.1.285, haiku, -p): with all of ~/.claude
 * write-denied a one-line answer, Bash, Write and Edit worked; only `--resume` failed ("No conversation found")
 * until projects/ (session transcripts) was writable. ~/.claude.json* is always written (documented limit).
 */
export const CLAUDE_RUNTIME_DIRS = ['projects']
const CLAUDE_PROTECTED_DIRS = ['skills', 'agents', 'commands', 'plugins', 'hooks']

export function sandboxProfile(o: SandboxOpts): string {
  const home = real(o.home ?? homedir())
  const hq = real(o.hqHome)
  const own = [o.worktree, ...(o.out ? [o.out] : [])].map(real)
  const projects = o.projects.map(real)
  const secretContents = [
    sub(real(o.tokenDir)), rx(`^${reEsc(hq)}/hq\\.db`), sub(join(hq, 'runs')), sub(join(hq, 'logs')), sub(join(hq, 'work')),
    sub(join(home, '.ssh')), sub(join(home, '.aws')), sub(join(home, '.config/gh')), lit(join(home, '.netrc')), lit(join(home, '.docker/config.json')),
    // ~/Library/Keychains is NOT denied although §6.2 lists it: with it denied the real CLI answers "Not logged in"
    // (its subscription token lives in the login keychain; measured on 2.1.285). Reported as BLOCKED for a ruling.
    ...projects.map((p) => rx(`^${reEsc(p)}/(.*/)?\\.env[^/]*$`)),
  ]
  const writable = [...own, '/private/tmp', '/private/var/folders', '/dev', ...o.extraWritable.map(real), ...CLAUDE_RUNTIME_DIRS.map((d) => join(home, '.claude', d))]
  const claudeControl = [rx(`^${reEsc(join(home, '.claude'))}/settings[^/]*\\.json$`), lit(join(home, '.claude/CLAUDE.md')), ...CLAUDE_PROTECTED_DIRS.map((d) => sub(join(home, '.claude', d)))]
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read-data file-write* ${secretContents.join(' ')})`,
    `(allow file-read-data file-write* ${own.map(sub).join(' ')})`,
    `(deny file-write* (require-not (require-any ${writable.map(sub).join(' ')} ${rx(`^${reEsc(home)}/\\.claude\\.json`)})))`,
    // $HQ_HOME (mirrors, other worktrees, the DB) and user checkouts are never writable, even when they sit under an
    // allow-listed temp root; the process's own paths are re-allowed right after.
    `(deny file-write* ${[sub(hq), ...projects.map(sub)].join(' ')})`,
    `(allow file-write* ${own.map(sub).join(' ')})`,
    `(deny file-write* ${claudeControl.join(' ')})`,
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl"))',
    '(deny appleevent-send)',
    `(deny network-outbound (remote ip ${q(`localhost:${o.hqPort}`)}))`,
    '',
  ].join('\n')
}

// Test-only seam: reachable solely by direct import (never from config, env vars, CLI flags or HTTP).
let sandboxWrapper = 'sandbox-exec'
export function setSandboxWrapperForTests(bin: string | null): void { sandboxWrapper = bin ?? 'sandbox-exec' }

export function wrap(argv: string[], profilePath: string): string[] {
  return [sandboxWrapper, '-f', profilePath, ...argv]
}

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
