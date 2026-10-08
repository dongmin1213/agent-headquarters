// Integration (execution.md §12): merge every passed task's recorded head SHA onto the target's current SHA
// in a mirror worktree, run setup + the included tasks' checks + the secret scan there. The user's checkout is not touched.
import type { CheckSpec, ChecksFile, OnSpawn } from './checks.ts'
import { runChecks, runSandboxed } from './checks.ts'
import { atomicWrite } from './fsx.ts'
import { hqGitOk, mirrorIsAncestor, mirrorRev, removeMirrorWorktree, verifyWorktree, wtGitOk, wtMerge } from './repos.ts'
import { withRepo } from './git.ts'
import { sandboxProfile, type SandboxOpts } from './sandbox.ts'

export interface IntegrationHead { taskId: string; title: string; sha: string }
export type IntegrationResult =
  | { kind: 'ok'; sha: string; targetSha: string; checks: ChecksFile }
  | { kind: 'conflict'; files: string[]; targetSha: string; taskId: string }
  | { kind: 'failed'; targetSha: string | null; checks: ChecksFile | null; reason: string
      /** Set when the only failures are base-failed checks (ids in `known`): the integration commit, kept under the integration ref. */
      sha?: string; known?: { id: string; command: string }[] }

export const integrationRef = (requestId: string, project: string) => `refs/hq/integration/${requestId}/${project}`

/** The mirror must be fetched from the project first so `refs/heads/<target>` is current. */
export async function integrate(o: {
  mirror: string; requestId: string; project: string; path: string; target: string; baseSha: string | null; heads: IntegrationHead[]
  setup: string | null; checks: CheckSpec[]; timeoutMs: number; sandbox: SandboxOpts; profilePath: string; onSpawn?: OnSpawn
}): Promise<IntegrationResult> {
  const targetSha = await mirrorRev(o.mirror, `refs/heads/${o.target}`)
  if (!targetSha) return { kind: 'failed', targetSha: null, checks: null, reason: `대상 브랜치(${o.target})를 찾을 수 없음` }
  // A reset/rebase of the target must never silently reintroduce history removed since approval.
  if (!o.baseSha || !await mirrorIsAncestor(o.mirror, o.baseSha, targetSha))
    return { kind: 'failed', targetSha, checks: null, reason: '대상 브랜치 이력이 요청 기준 커밋을 포함하지 않습니다. 삭제된 이력을 되살리지 않도록 통합을 중단했습니다. 기준 이력을 확인하고 계획을 다시 수립해야 합니다.' }
  for (const h of o.heads) if (!await mirrorIsAncestor(o.mirror, o.baseSha, h.sha))
    return { kind: 'failed', targetSha, checks: null, reason: `작업 ${h.taskId}의 제출 커밋이 요청 기준 이력을 포함하지 않습니다.` }
  const wt = await verifyWorktree(o.mirror, o.path, targetSha)
  try {
    for (const h of o.heads) {
      const m = await withRepo(o.mirror, () => wtMerge(wt, [h.sha], `hq: ${h.title} (${h.taskId})`))
      if (!m.ok) return { kind: 'conflict', files: m.files, targetSha, taskId: h.taskId }
    }
    const sha = await wtGitOk(wt, ['rev-parse', 'HEAD'])
    if (o.setup) {
      atomicWrite(o.profilePath, sandboxProfile(o.sandbox))
      const s = await runSandboxed(o.setup, wt.path, o.timeoutMs, o.profilePath, 'setup', o.onSpawn, !!o.sandbox.graphics)
      if (!s.pass) return { kind: 'failed', targetSha, checks: null, reason: `setup 실패 (종료 코드 ${s.exitCode ?? '시간 초과'}): ${s.outputTail.split('\n').slice(-5).join(' ').slice(0, 300)}` }
    }
    const checks = await runChecks({ wt, base: targetSha, head: sha, checks: o.checks, timeoutMs: o.timeoutMs, sandbox: o.sandbox, profilePath: o.profilePath, onSpawn: o.onSpawn })
    // No exemption in integration (F02): a base-failed check failing here is a failure. The reviewer judged "no worse"
    // on the task's own base; the target may have moved since, so the chairman looks at it on the integration card.
    const carried = checks.checks.filter((c) => c.baseFailed)
    for (const c of carried) delete c.baseFailed
    if (carried.length) checks.pass = false
    if (!checks.pass) {
      if (checks.error) return { kind: 'failed', targetSha, checks, reason: checks.error }
      const others = checks.checks.filter((c) => !c.pass && !carried.includes(c)).map((c) => c.id)
      if (!others.length && !checks.secrets.length) {
        // Only known (base-failed) failures: the chairman may accept them for this commit, so keep it reachable.
        await withRepo(o.mirror, () => hqGitOk(o.mirror, null, ['update-ref', integrationRef(o.requestId, o.project), sha]))
        return { kind: 'failed', targetSha, checks, sha, known: carried.map((c) => ({ id: c.id, command: c.command })),
          reason: carried.map((c) => `기존 실패 검사 ${c.id}(${c.command})가 통합본에서도 실패해요 · 작업 검토 뒤 대상 브랜치가 바뀌었을 수 있어 확인이 필요해요`).join('\n') }
      }
      const reason = [...carried.map((c) => `기존 실패 검사 ${c.id}(${c.command})가 통합본에서도 실패해요 · 작업 검토 뒤 대상 브랜치가 바뀌었을 수 있어 확인이 필요해요`),
        ...(others.length || checks.secrets.length ? [`통합 검사 실패: ${[...others, ...(checks.secrets.length ? ['비밀값 탐지'] : [])].join(', ')}`] : [])].join('\n')
      return { kind: 'failed', targetSha, checks, reason }
    }
    // Keep the integration commit reachable after the worktree goes away; the merge fetches this ref.
    await withRepo(o.mirror, () => hqGitOk(o.mirror, null, ['update-ref', integrationRef(o.requestId, o.project), sha]))
    return { kind: 'ok', sha, targetSha, checks }
  } finally {
    await removeMirrorWorktree(o.mirror, wt.path).catch(() => {})
  }
}
