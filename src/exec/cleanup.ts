import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { withRepo } from './git.ts'
import { hqGitOk } from './repos.ts'

/** Only HQ's own request directories; never follow a substituted parent symlink. */
export function requestScratchPaths(home: string, requestId: string): string[] {
  if (!/^req-[a-zA-Z0-9_-]+$/.test(requestId)) throw new Error('Invalid cleanup request id')
  return ['work', 'worktrees'].map(area => {
    const parent = join(home, area), path = join(parent, requestId)
    for (const p of [parent, path]) {
      const st = lstatSync(p, { throwIfNoEntry: false })
      if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new Error(`Unsafe cleanup directory: ${p}`)
    }
    return path
  })
}

export function requestScratchChildren(home: string, requestId: string): string[] {
  return requestScratchPaths(home, requestId).flatMap(root => existsSync(root) ? readdirSync(root).map(name => join(root, name)) : [])
}

/** Call only after the request has finished and all of its process groups have exited. */
export async function removeRequestScratch(home: string, requestId: string, gitDirs: string[]): Promise<void> {
  const roots = requestScratchPaths(home, requestId)
  // Include configured project repos for worktrees created by older HQ versions.
  // The registered path, not an untrusted checkout's .git file, identifies ownership.
  for (const gitDir of new Set(gitDirs)) {
    if (!existsSync(gitDir)) continue
    await withRepo(gitDir, async () => {
      const list = await hqGitOk(gitDir, null, ['worktree', 'list', '--porcelain', '-z'])
      for (const field of list.split('\0')) {
        if (!field.startsWith('worktree ')) continue
        const path = field.slice(9)
        if (roots.some(root => path === root || path.startsWith(root + '/'))) {
          await hqGitOk(gitDir, null, ['worktree', 'remove', '--force', path])
        }
      }
    })
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

/** Names are hashes captured from known request-owned Codex homes, never a global cache sweep. */
export function removeRequestCodexHomes(home: string, hashes: string[]): void {
  const parent = join(home, 'codex')
  const st = lstatSync(parent, { throwIfNoEntry: false })
  if (!st) return
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe Codex cleanup directory')
  if (hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid Codex home hash')
  for (const hash of new Set(hashes)) rmSync(join(parent, hash), { recursive: true, force: true })
}
