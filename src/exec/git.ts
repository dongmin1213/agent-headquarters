// Plain git for the user's own project checkout (read state, fetch + ff-merge). Always execFile with argv, never a shell.
// Everything hq does in its own repositories (mirror, verification worktrees) goes through repos.ts (§6.1).
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'

export interface GitResult { code: number; stdout: string; stderr: string }

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }

export function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: ENV, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === -1 ? String(err.message) : '') })
    })
  })
}

/** Runs git and throws with stderr on a non-zero exit; returns trimmed stdout. */
export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args)
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 3).join(' ')} 실패: ${(r.stderr || r.stdout).trim().slice(0, 500)}`)
  return r.stdout.trim()
}

export async function revParse(cwd: string, ref = 'HEAD'): Promise<string | null> {
  if (!existsSync(cwd)) return null
  const r = await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
  return r.code === 0 ? r.stdout.trim() : null
}

/** A usable project: a git work tree with at least one commit. */
export async function isRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  const r = await git(path, ['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true' && (await revParse(path)) !== null
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() || null : null
}

export async function statusPorcelain(cwd: string): Promise<string> {
  return (await gitOk(cwd, ['status', '--porcelain', '--untracked-files=all'])).trim()
}

// ----- repository mutex -----

const locks = new Map<string, Promise<unknown>>()
/** Serializes git writes per repository (execution.md §7.5). */
export function withRepo<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  let key = repo
  try { key = realpathSync(repo) } catch { /* keep as is */ }
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}
