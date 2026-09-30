// Restart recovery (execution.md §7 §12) and the once-a-minute invariant check (§5).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hqDirOf } from './decisions.ts'
import { git, revParse, withRepo } from './git.ts'
import type { Runner } from './runner.ts'
import { sameProcessAlive } from './worker.ts'
import { readJson } from './fsx.ts'

export interface Violation { requestId: string; taskId: string | null; problem: string }

/** Re-adopts or closes attempts that were live when the daemon stopped, and resets interrupted in-memory work. */
export async function recover(d: Runner): Promise<void> {
  const s = d.store
  for (const att of s.liveAttempts()) {
    if (d.live.has(att.id) || d.launching.has(att.id)) continue
    const pid = att.pid
    const lstart = att.lstart
    if (!pid) {
      // Spawned but the pid never reached the DB: process.json, then a process running this session id (§7.3).
      const info = readJson<{ pid: number; lstart: string | null; startedAt: string }>(join(hqDirOf(att), 'process.json'))
      const found = info && await sameProcessAlive(info.pid, info.lstart, info.startedAt) ? info.pid : await d.findOrphan(att.session_id)
      if (found) { await d.adopt(att, found); continue }
      s.tx(() => {
        s.updateAttempt(att.id, { status: 'start_failed', ended_at: d.iso(), reason: '시작 기록 없음 (재시작 복구)' })
        const t = s.task(att.task_id)
        if (att.kind === 'work' && t?.status === 'running') s.updateTask(t.id, { status: 'pending' })
      })
      continue
    }
    const alive = await sameProcessAlive(pid, lstart, att.started_at)
    if (att.status === 'starting') s.updateAttempt(att.id, { status: 'running' })
    d.track({ ...att, status: 'running' }, pid, lstart, att.started_at, null, !alive)
  }
  // CEO turns do not survive a restart.
  for (const r of s.requestsByStatus(['thinking'])) s.updateRequest(r.id, { status: 'queued' })
  // Interrupted integrations rerun; an interrupted merge is resolved by looking at the target.
  for (const r of s.requestsByStatus(['executing', 'accepted', 'blocked', 'merging'])) {
    for (const m of s.mergeRows(r.id)) {
      if (m.state === 'integrating') s.putMerge(r.id, m.project, { state: 'pending' })
      if (m.state === 'merging') {
        const p = d.project(m.project)
        const head = p ? await revParse(p.path) : null
        if (p && existsSync(join(p.path, '.git', 'MERGE_HEAD'))) await withRepo(p.path, () => git(p.path, ['merge', '--abort']))
        s.putMerge(r.id, m.project, head && head === m.integration_sha ? { state: 'merged', result_sha: head } : { state: 'pending', note: '병합 중 재시작 — 다시 확인' })
      }
    }
    if (r.status === 'merging') {
      const done = s.mergeRows(r.id).every((m) => m.state === 'merged')
      s.updateRequest(r.id, { status: done ? 'merged' : 'accepted' })
    }
  }
  for (const t of s.tasksByStatus(['verifying'])) if (t.checks_state === 'running') s.updateTask(t.id, { checks_state: null })
}

/**
 * Every non-terminal request/task must have a live process, an open decision, a timer, or be dispatchable (§5).
 * Violations are surfaced as blocked tasks (a decision item) — never silently fixed.
 */
export function reconcile(d: Runner): Violation[] {
  const s = d.store
  const out: Violation[] = []
  const hold = d.quota().mode === 'hold'
  const liveTaskIds = new Set(s.liveAttempts().map((a) => a.task_id))
  const openIds = new Set(s.openApprovals(d.now()).map((a) => a.id))
  for (const r of s.requestsByStatus(['executing', 'blocked', 'awaiting_acceptance', 'accepted'])) {
    const tasks = s.tasks(r.id)
    const flag = (taskId: string | null, problem: string) => out.push({ requestId: r.id, taskId, problem })
    for (const t of tasks) {
      if (t.status === 'running' && !liveTaskIds.has(t.id)) flag(t.id, '실행 중인데 살아 있는 프로세스가 없음')
      if (t.status === 'verifying' && !d.checking.has(t.id)) flag(t.id, '검증 중인데 검사 작업이 없음')
      if (t.status === 'question' && !s.taskQuestions(t.id).some((q) => q.revision === t.revision && q.answer === null)) flag(t.id, '질문 대기인데 미답 질문이 없음')
      if (t.status === 'held' && !hold && r.status !== 'executing') flag(t.id, '한도 보류인데 한도가 풀렸고 요청이 실행 중이 아님')
      if (['pending', 'rework'].includes(t.status)) {
        const deps = t.spec ? (JSON.parse(t.spec).depends_on as string[]) : []
        if (deps.some((k) => tasks.find((x) => x.key === k)?.status === 'cancelled')) flag(t.id, '선행 작업이 취소됐는데 대기 중')
      }
    }
    if (r.status === 'blocked') {
      const hasDecision = tasks.some((t) => t.status === 'blocked' || t.status === 'question') || [...openIds].some((id) => id.startsWith(`integration:${r.id}:`))
        || tasks.some((t) => openIds.has(`revise:${t.id}`))
      if (!hasDecision) flag(null, '막힌 요청인데 결정할 카드가 없음')
    }
    if (r.status === 'awaiting_acceptance' && !openIds.has(`accept:${r.id}`)) flag(null, '수락 대기인데 수락 카드가 없음')
    if (r.status === 'accepted') for (const m of s.mergeRows(r.id)) if (m.state === 'offered' && !openIds.has(`merge:${r.id}:${m.project}`)) flag(null, `병합 카드가 없음 (${m.project})`)
  }
  if (!out.length) return out
  s.tx(() => {
    for (const v of out) {
      const r = s.request(v.requestId)!
      const tasks = s.tasks(v.requestId)
      const target = (v.taskId ? s.task(v.taskId) : null) ?? tasks.find((t) => !['passed', 'cancelled', 'blocked'].includes(t.status)) ?? tasks.find((t) => t.status === 'passed')
      if (target && target.status !== 'blocked') {
        if (target.status === 'passed' && r.status !== 'blocked') s.updateRequest(r.id, { status: 'blocked', note: `불변식 위반: ${v.problem}` })
        s.updateTask(target.id, { status: 'blocked', note: `불변식 위반: ${v.problem}` })
      }
      if (!['blocked'].includes(s.request(r.id)!.status)) s.updateRequest(r.id, { status: 'blocked', note: `불변식 위반: ${v.problem}` })
    }
  })
  for (const v of out) d.bus.emit({ kind: 'request', text: `불변식 위반: ${v.problem}`, data: { id: v.requestId, taskId: v.taskId } })
  return out
}
