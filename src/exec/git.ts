// Git plumbing for worktrees, verification and merge. Always execFile with argv, never a shell.
import { execFile } from 'node:child_process'
import { existsSync, realpathSync, rmSync } from 'node:fs'

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

/** Files that differ between two commits (NUL-separated to survive odd names). */
export async function changedFiles(cwd: string, base: string, head: string): Promise<string[]> {
  const out = await gitOk(cwd, ['diff', '--name-only', '-z', '--no-renames', base, head])
  return out.split('\0').filter(Boolean)
}

export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', a, b])).code === 0
}

async function registeredWorktrees(repo: string): Promise<string[]> {
  const out = await gitOk(repo, ['worktree', 'list', '--porcelain'])
  return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
}

function sameDir(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

/** Creates the task worktree on its branch, or reuses it (rework continues on previous commits). */
export async function ensureWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (existsSync(path)) {
    for (const w of await registeredWorktrees(repo)) if (sameDir(w, path)) return
    throw new Error(`worktree 경로가 이미 있지만 git worktree가 아닙니다: ${path}`)
  }
  await git(repo, ['worktree', 'prune'])
  const hasBranch = (await git(repo, ['show-ref', '--verify', '-q', `refs/heads/${branch}`])).code === 0
  await gitOk(repo, hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base])
}

export async function addDetachedWorktree(repo: string, path: string, sha: string): Promise<void> {
  if (existsSync(path)) await removeWorktree(repo, path)
  await gitOk(repo, ['worktree', 'add', '--detach', path, sha])
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path])
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  await git(repo, ['worktree', 'prune'])
}
