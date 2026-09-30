// Integration (execution.md §12): merge every passed task's recorded head SHA onto the target's current SHA
// in a separate worktree, run setup + all checks + the secret scan there. The user's checkout is not touched.
import { existsSync } from 'node:fs'
import type { CheckSpec, ChecksFile } from './checks.ts'
import { runChecks, runSandboxed } from './checks.ts'
import { atomicWrite } from './fsx.ts'
import { addDetachedWorktree, git, gitOk, mergeHeads, removeWorktree, withRepo } from './git.ts'
import { sandboxProfile, type SandboxOpts } from './sandbox.ts'

export interface IntegrationHead { taskId: string; title: string; sha: string }
export type IntegrationResult =
  | { kind: 'ok'; sha: string; targetSha: string; checks: ChecksFile }
  | { kind: 'conflict'; files: string[]; targetSha: string; taskId: string }
  | { kind: 'failed'; targetSha: string | null; checks: ChecksFile | null; reason: string }

export const integrationRef = (requestId: string, project: string) => `refs/hq/integration/${requestId}/${project}`

export async function integrate(o: {
  repo: string; requestId: string; project: string; path: string; target: string; heads: IntegrationHead[]
  setup: string | null; checks: CheckSpec[]; baselineFailed: Set<string>; timeoutMs: number; sandbox: SandboxOpts; profilePath: string
}): Promise<IntegrationResult> {
  const targetSha = await withRepo(o.repo, async () => {
    const r = await git(o.repo, ['rev-parse', '--verify', '-q', `refs/heads/${o.target}^{commit}`])
    if (r.code !== 0) return null
    const sha = r.stdout.trim()
    if (existsSync(o.path)) await removeWorktree(o.repo, o.path)
    await addDetachedWorktree(o.repo, o.path, sha)
    return sha
  })
  if (!targetSha) return { kind: 'failed', targetSha: null, checks: null, reason: `대상 브랜치 ${o.target}를 찾을 수 없음` }
  try {
    for (const h of o.heads) {
      const m = await withRepo(o.repo, () => mergeHeads(o.path, [h.sha], `hq: ${h.title} (${h.taskId})`))
      if (!m.ok) return { kind: 'conflict', files: m.files, targetSha, taskId: h.taskId }
    }
    const sha = await gitOk(o.path, ['rev-parse', 'HEAD'])
    if (o.setup) {
      atomicWrite(o.profilePath, sandboxProfile(o.sandbox))
      const s = await runSandboxed(o.setup, o.path, o.timeoutMs, o.profilePath, 'setup')
      if (!s.pass) return { kind: 'failed', targetSha, checks: null, reason: `setup 실패 (종료 코드 ${s.exitCode ?? '시간 초과'}): ${s.outputTail.split('\n').slice(-5).join(' ').slice(0, 300)}` }
    }
    const checks = await runChecks({ cwd: o.path, base: targetSha, head: sha, checks: o.checks, timeoutMs: o.timeoutMs, sandbox: o.sandbox, profilePath: o.profilePath, baselineFailed: o.baselineFailed })
    if (!checks.pass) return { kind: 'failed', targetSha, checks, reason: checks.error ?? `통합 검사 실패: ${checks.checks.filter((c) => !c.pass && !c.baselineFailed).map((c) => c.id).join(', ') || '비밀값 탐지'}` }
    // Keep the integration commit reachable after the worktree goes away.
    await withRepo(o.repo, () => gitOk(o.repo, ['update-ref', integrationRef(o.requestId, o.project), sha]))
    return { kind: 'ok', sha, targetSha, checks }
  } finally {
    await withRepo(o.repo, () => removeWorktree(o.repo, o.path)).catch(() => {})
  }
}
