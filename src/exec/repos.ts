// Repository isolation (execution.md §6.1). hq never runs git inside a repository a worker can write:
// workers get their own `clone --shared` of an hq-owned bare mirror; hq only fetches from it into the mirror,
// and does verification, review and integration in worktrees of the mirror, addressed by explicit --git-dir.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { GitResult } from './git.ts'
import { withRepo } from './git.ts'

/** Applied to every hq git call: no hooks, no fsmonitor, no untracked cache. */
export const HQ_GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']
/** Identity for commits hq itself creates (dependency bases, integration merges). */
export const HQ_IDENT = ['-c', 'user.name=hq', '-c', 'user.email=hq@localhost']
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1' }
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES']) delete (ENV as Record<string, string | undefined>)[k]
/** Diff flags that keep repository-configured programs out of hq's diffs. */
export const SAFE_DIFF = ['--no-ext-diff', '--no-textconv']

/** hq's git entry point for mirrors and mirror worktrees: fixed -c options, safe env, explicit --git-dir/--work-tree. */
export function hqGit(gitDir: string | null, workTree: string | null, args: string[], o: { cwd?: string; maxBuffer?: number } = {}): Promise<GitResult> {
  const argv = [...HQ_GIT_CONFIG, ...(gitDir ? ['--git-dir', gitDir] : []), ...(workTree ? ['--work-tree', workTree] : []), ...args]
  const cwd = o.cwd ?? workTree ?? gitDir ?? process.cwd()
  return new Promise((done) => {
    execFile('git', argv, { cwd, env: ENV, maxBuffer: o.maxBuffer ?? 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === -1 ? String(err.message) : '') })
    })
  })
}

export async function hqGitOk(gitDir: string | null, workTree: string | null, args: string[], o: { cwd?: string } = {}): Promise<string> {
  const r = await hqGit(gitDir, workTree, args, o)
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 3).join(' ')} 실패: ${(r.stderr || r.stdout).trim().slice(0, 500)}`)
  return r.stdout.trim()
}

export const mirrorPath = (home: string, projectId: string) => join(home, 'repos', `${projectId}.git`)

/** Creates the bare mirror on first use, then fetches every branch, tag and the project's HEAD. Returns the mirror path. */
export async function ensureMirror(project: { id: string; path: string }, mirror: string): Promise<string> {
  return withRepo(mirror, async () => {
    if (!existsSync(join(mirror, 'HEAD'))) {
      mkdirSync(dirname(mirror), { recursive: true })
      rmSync(mirror, { recursive: true, force: true })
      await hqGitOk(null, null, ['clone', '--bare', '--no-local', '-q', project.path, mirror], { cwd: dirname(mirror) })
    }
    await hqGitOk(mirror, null, ['fetch', '-q', '--no-tags', project.path, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', '+HEAD:refs/hq/project-head'])
    return mirror
  })
}

/** The worker's own repository: shares the mirror's objects read-only, branch `hq-work` at the base. */
export async function newWorkClone(mirror: string, path: string, baseSha: string, identity?: { name?: string; email?: string }): Promise<void> {
  rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(path), { recursive: true })
  await hqGitOk(null, null, ['clone', '--shared', '--no-checkout', '-q', mirror, path], { cwd: dirname(path) })
  // The only git commands hq runs inside a worker clone: right after creation, before any worker touched it.
  await hqGitOk(join(path, '.git'), path, ['checkout', '-q', '-b', 'hq-work', baseSha])
  // Worker commits carry the project's own identity, not whatever the machine's global config says.
  if (identity?.name) await hqGitOk(join(path, '.git'), path, ['config', 'user.name', identity.name])
  if (identity?.email) await hqGitOk(join(path, '.git'), path, ['config', 'user.email', identity.email])
}

/**
 * Brings the worker's `hq-work` into the mirror under `ref` (runs in the mirror). Every received object is checked
 * (fsck: e.g. a tree entry named `.git`, malformed objects), so nothing corrupt or malicious enters the mirror (S6).
 * Returns the fetched SHA, or null with a Korean reason.
 */
export async function fetchWork(mirror: string, clonePath: string, ref: string): Promise<{ sha: string | null; error: string | null }> {
  return withRepo(mirror, async () => {
    const r = await hqGit(mirror, null, ['-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
      'fetch', '-q', '--no-tags', '--no-write-fetch-head', clonePath, `+refs/heads/hq-work:${ref}`])
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 400)
      const fsck = /fsck|hasDotgit|badTree|bad(Date|Email|Name|Filemode)|missing(Author|Committer|Tree)|zeroPaddedFilemode|index-pack failed/i.test(r.stderr)
      return { sha: null, error: fsck ? `작업 결과를 가져오다 git 객체 검사에서 거부됐어요(손상됐거나 위험한 객체): ${msg}` : `작업 결과(hq-work 브랜치)를 가져오지 못했어요: ${msg}` }
    }
    const s = await hqGit(mirror, null, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
    return s.code === 0 ? { sha: s.stdout.trim(), error: null } : { sha: null, error: '가져온 작업 결과에 커밋이 없어요' }
  })
}

/** A mirror worktree plus its admin dir, read once right after creation (the `.git` file inside is untrusted later). */
export interface MirrorWorktree { path: string; gitDir: string; mirror: string }

export async function verifyWorktree(mirror: string, path: string, sha: string): Promise<MirrorWorktree> {
  return withRepo(mirror, async () => {
    if (existsSync(path)) await removeWorktreeUnlocked(mirror, path)
    mkdirSync(dirname(path), { recursive: true })
    await hqGitOk(mirror, null, ['worktree', 'add', '-q', '--detach', path, sha])
    const m = /^gitdir: (.+)$/m.exec(readFileSync(join(path, '.git'), 'utf8'))
    if (!m) throw new Error(`worktree 관리 폴더를 찾을 수 없음: ${path}`)
    const gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(path, m[1].trim())
    return { path, gitDir, mirror }
  })
}

async function removeWorktreeUnlocked(mirror: string, path: string): Promise<void> {
  await hqGit(mirror, null, ['worktree', 'remove', '--force', path])
  rmSync(path, { recursive: true, force: true })
  await hqGit(mirror, null, ['worktree', 'prune'])
}

export function removeMirrorWorktree(mirror: string, path: string): Promise<void> {
  return withRepo(mirror, () => removeWorktreeUnlocked(mirror, path))
}

/** git in a mirror worktree, never trusting its `.git` file. */
export const wtGit = (wt: MirrorWorktree, args: string[]) => hqGit(wt.gitDir, wt.path, args)
export const wtGitOk = (wt: MirrorWorktree, args: string[]) => hqGitOk(wt.gitDir, wt.path, args)

export async function wtStatus(wt: MirrorWorktree): Promise<string> {
  return (await wtGitOk(wt, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules'])).trim()
}

export async function mirrorRev(mirror: string, ref: string): Promise<string | null> {
  const r = await hqGit(mirror, null, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
  return r.code === 0 ? r.stdout.trim() : null
}

export async function mirrorChanged(mirror: string, base: string, head: string): Promise<string[]> {
  if (base === head) return []
  return (await hqGitOk(mirror, null, ['diff', '--name-only', '-z', '--no-renames', ...SAFE_DIFF, base, head])).split('\0').filter(Boolean)
}

export async function mirrorIsAncestor(mirror: string, a: string, b: string): Promise<boolean> {
  return (await hqGit(mirror, null, ['merge-base', '--is-ancestor', a, b])).code === 0
}

export async function mirrorHasMerges(mirror: string, base: string, head: string): Promise<boolean> {
  return (await hqGitOk(mirror, null, ['rev-list', '--merges', `${base}..${head}`])).length > 0
}

/** Merges commits into a mirror worktree with --no-ff; aborts and reports conflicting files on failure. */
export async function wtMerge(wt: MirrorWorktree, shas: string[], message: string): Promise<{ ok: true; sha: string } | { ok: false; files: string[]; error: string }> {
  for (const sha of shas) {
    const r = await wtGit(wt, [...HQ_IDENT, 'merge', '--no-ff', '--no-edit', '-m', message, sha])
    if (r.code !== 0) {
      const u = await wtGit(wt, ['diff', '--name-only', '--diff-filter=U'])
      await wtGit(wt, ['merge', '--abort'])
      return { ok: false, files: u.stdout.split('\n').filter(Boolean), error: (r.stderr || r.stdout).trim().slice(0, 500) }
    }
  }
  return { ok: true, sha: await wtGitOk(wt, ['rev-parse', 'HEAD']) }
}
