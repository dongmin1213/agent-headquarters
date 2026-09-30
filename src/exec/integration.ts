// Integration (execution.md §12): merge every passed task's recorded head SHA onto the target's current SHA
// in a mirror worktree, run setup + the included tasks' checks + the secret scan there. The user's checkout is not touched.
import type { CheckSpec, ChecksFile, OnSpawn } from './checks.ts'
import { runChecks, runSandboxed } from './checks.ts'
import { atomicWrite } from './fsx.ts'
import { hqGitOk, mirrorRev, removeMirrorWorktree, verifyWorktree, wtGitOk, wtMerge } from './repos.ts'
import { withRepo } from './git.ts'
import { sandboxProfile, type SandboxOpts } from './sandbox.ts'

export interface IntegrationHead { taskId: string; title: string; sha: string }
export type IntegrationResult =
  | { kind: 'ok'; sha: string; targetSha: string; checks: ChecksFile }
  | { kind: 'conflict'; files: string[]; targetSha: string; taskId: string }
  | { kind: 'failed'; targetSha: string | null; checks: ChecksFile | null; reason: string }

export const integrationRef = (requestId: string, project: string) => `refs/hq/integration/${requestId}/${project}`

/** The mirror must be fetched from the project first so `refs/heads/<target>` is current. */
export async function integrate(o: {
  mirror: string; requestId: string; project: string; path: string; target: string; heads: IntegrationHead[]
  setup: string | null; checks: CheckSpec[]; timeoutMs: number; sandbox: SandboxOpts; profilePath: string; onSpawn?: OnSpawn
}): Promise<IntegrationResult> {
  const targetSha = await mirrorRev(o.mirror, `refs/heads/${o.target}`)
  if (!targetSha) return { kind: 'failed', targetSha: null, checks: null, reason: `대상 브랜치 ${o.target}를 찾을 수 없음` }
  const wt = await verifyWorktree(o.mirror, o.path, targetSha)
  try {
    for (const h of o.heads) {
      const m = await withRepo(o.mirror, () => wtMerge(wt, [h.sha], `hq: ${h.title} (${h.taskId})`))
      if (!m.ok) return { kind: 'conflict', files: m.files, targetSha, taskId: h.taskId }
    }
    const sha = await wtGitOk(wt, ['rev-parse', 'HEAD'])
    if (o.setup) {
      atomicWrite(o.profilePath, sandboxProfile(o.sandbox))
      const s = await runSandboxed(o.setup, wt.path, o.timeoutMs, o.profilePath, 'setup', o.onSpawn)
      if (!s.pass) return { kind: 'failed', targetSha, checks: null, reason: `setup 실패 (종료 코드 ${s.exitCode ?? '시간 초과'}): ${s.outputTail.split('\n').slice(-5).join(' ').slice(0, 300)}` }
    }
    const checks = await runChecks({ wt, base: targetSha, head: sha, checks: o.checks, timeoutMs: o.timeoutMs, sandbox: o.sandbox, profilePath: o.profilePath, onSpawn: o.onSpawn })
    if (!checks.pass) return { kind: 'failed', targetSha, checks, reason: checks.error ?? `통합 검사 실패: ${checks.checks.filter((c) => !c.pass).map((c) => c.id).join(', ') || '비밀값 탐지'}` }
    // Keep the integration commit reachable after the worktree goes away; the merge fetches this ref.
    await withRepo(o.mirror, () => hqGitOk(o.mirror, null, ['update-ref', integrationRef(o.requestId, o.project), sha]))
    return { kind: 'ok', sha, targetSha, checks }
  } finally {
    await removeMirrorWorktree(o.mirror, wt.path).catch(() => {})
  }
}
