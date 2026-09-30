// Applying an accepted integration to the user's checkout (execution.md §12): fetch from the mirror, one `merge --ff-only`.
// This is the user's own repository, so its hooks and settings apply as they would for the user (plain git).
import { currentBranch, git, revParse, statusPorcelain, withRepo } from './git.ts'
import { integrationRef } from './integration.ts'
import { josa } from '../josa.ts'

export type MergeResult = { kind: 'merged'; sha: string } | { kind: 'stale'; why: string } | { kind: 'detached' }

/** Re-checks branch, SHA and cleanliness under the repo mutex; anything different means the card is stale. */
export function applyMerge(o: { repo: string; mirror: string; requestId: string; project: string; target: string; targetSha: string; integrationSha: string }): Promise<MergeResult> {
  return withRepo(o.repo, async () => {
    const branch = await currentBranch(o.repo)
    if (!branch) return { kind: 'detached' } as const
    if (branch !== o.target) return { kind: 'stale', why: `대상 checkout의 브랜치가 ${o.target}에서 ${josa(branch, '으로/로')} 바뀜` } as const
    const head = await revParse(o.repo)
    if (head !== o.targetSha) return { kind: 'stale', why: `${o.target}에 새 커밋이 생김 (${o.targetSha.slice(0, 10)} → ${head?.slice(0, 10) ?? '없음'})` } as const
    const status = await statusPorcelain(o.repo)
    if (status) return { kind: 'stale', why: `대상 checkout에 커밋되지 않은 변경이 있음: ${status.split('\n').slice(0, 3).join('; ')}` } as const
    // Fetch the integration commit by its hq ref (a bare SHA want is not always allowed), then confirm the SHA.
    const f = await git(o.repo, ['fetch', '-q', '--no-tags', o.mirror, integrationRef(o.requestId, o.project)])
    if (f.code !== 0) return { kind: 'stale', why: `통합 커밋을 가져오지 못함: ${(f.stderr || f.stdout).trim().slice(0, 300)}` } as const
    const fetched = await revParse(o.repo, 'FETCH_HEAD')
    if (fetched !== o.integrationSha) return { kind: 'stale', why: `가져온 통합 커밋(${fetched?.slice(0, 10)})이 카드의 통합 커밋과 다름` } as const
    const r = await git(o.repo, ['merge', '--ff-only', o.integrationSha])
    if (r.code !== 0) return { kind: 'stale', why: `fast-forward 병합 실패: ${(r.stderr || r.stdout).trim().slice(0, 300)}` } as const
    return { kind: 'merged', sha: (await revParse(o.repo))! } as const
  })
}
