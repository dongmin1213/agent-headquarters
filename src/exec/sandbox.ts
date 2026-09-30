// macOS Seatbelt boundary for workers, reviewers, setup and check commands (execution.md §6).
// SBPL: later rules take precedence, so the order below is deny-hq → allow-own → deny-writes-outside-allowlist.
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, basename, join } from 'node:path'

export interface SandboxOpts {
  /** Task/review/integration worktree (read-write). */
  worktree: string
  /** Attempt out/ folder (read-write), or null when the command submits nothing (checks, setup). */
  out: string | null
  /** Shared git dir of the project (`git rev-parse --git-common-dir`), writable so worktree commits work. */
  repoGitDir: string | null
  hqHome: string
  /** Folder holding the daemon token (~/.config/hq). */
  tokenDir: string
  hqPort: number
  extraWritable: string[]
  /** ~/.claude (the CLI's own state). */
  claudeDir: string
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

export function sandboxProfile(o: SandboxOpts): string {
  const home = real(homedir())
  const own = [o.worktree, ...(o.out ? [o.out] : [])].map(real)
  const writable = [...own, ...(o.repoGitDir ? [real(o.repoGitDir)] : []), real(o.claudeDir), '/private/tmp', '/private/var/folders', '/dev', ...o.extraWritable.map(real)]
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write* (subpath ${q(real(o.tokenDir))}) (subpath ${q(real(o.hqHome))}))`,
    `(allow file-read* file-write* ${own.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    `(deny file-write* (require-not (require-any ${writable.map((p) => `(subpath ${q(p)})`).join(' ')} (regex ${q(`^${reEsc(home)}/\\.claude\\.json`)}))))`,
    `(deny network-outbound (remote ip ${q(`localhost:${o.hqPort}`)}))`,
    '',
  ].join('\n')
}

export function wrap(argv: string[], profilePath: string): string[] {
  return ['sandbox-exec', '-f', profilePath, ...argv]
}

const PASS = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL']

/** Allow-listed environment only: no HQ_TOKEN, API keys or SSH agent reach sandboxed processes. */
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
