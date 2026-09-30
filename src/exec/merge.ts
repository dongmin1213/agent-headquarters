// Applying an accepted integration to the user's checkout (execution.md §12): one `git merge --ff-only`.
import { currentBranch, git, revParse, statusPorcelain, withRepo } from './git.ts'

export type MergeResult = { kind: 'merged'; sha: string } | { kind: 'stale'; why: string } | { kind: 'detached' }

/** Re-checks branch, SHA and cleanliness under the repo mutex; anything different means the card is stale. */
export function applyMerge(o: { repo: string; target: string; targetSha: string; integrationSha: string }): Promise<MergeResult> {
  return withRepo(o.repo, async () => {
    const branch = await currentBranch(o.repo)
    if (!branch) return { kind: 'detached' } as const
    if (branch !== o.target) return { kind: 'stale', why: `대상 checkout의 브랜치가 ${o.target}에서 ${branch}로 바뀜` } as const
    const head = await revParse(o.repo)
    if (head !== o.targetSha) return { kind: 'stale', why: `${o.target}에 새 커밋이 생김 (${o.targetSha.slice(0, 10)} → ${head?.slice(0, 10) ?? '없음'})` } as const
    const status = await statusPorcelain(o.repo)
    if (status) return { kind: 'stale', why: `대상 checkout에 커밋되지 않은 변경이 있음: ${status.split('\n').slice(0, 3).join('; ')}` } as const
    const r = await git(o.repo, ['merge', '--ff-only', o.integrationSha])
    if (r.code !== 0) return { kind: 'stale', why: `fast-forward 병합 실패: ${(r.stderr || r.stdout).trim().slice(0, 300)}` } as const
    return { kind: 'merged', sha: (await revParse(o.repo))! } as const
  })
}
