// Screen data: decision items (§17), headline (§18), worker/task views (§19).
import { join } from 'node:path'
import type { Store, TaskRow, AttemptRow, ApprovalRow } from '../store.ts'
import type { DecisionItem, Headline, TaskView, WorkerView } from '../types.ts'
import type { QuotaState } from './quota.ts'
import { lastActivityOf } from './stream.ts'

const ORDER: DecisionItem['kind'][] = ['plan', 'ceo_question', 'worker_question', 'revise', 'blocked', 'integration', 'accept', 'merge']
export const BLOCKED_OPTIONS = ['retry', 'skip', 'stop']

function approvalRequestId(store: Store, a: ApprovalRow): string {
  if (a.subjectId) return a.subjectId
  const [, rest] = a.id.split(/:(.*)/s)
  if (a.kind === 'revise') return store.task(rest)?.request_id ?? ''
  return (rest ?? '').split(':')[0]
}

export function decisionItems(store: Store, now = Date.now()): DecisionItem[] {
  const items: DecisionItem[] = []
  for (const a of store.openApprovals(now)) {
    if (!['plan', 'revise', 'integration', 'accept', 'merge'].includes(a.kind)) continue
    items.push({ kind: a.kind as DecisionItem['kind'], id: a.id, revision: a.revision, requestId: approvalRequestId(store, a),
      taskId: a.kind === 'revise' ? a.id.slice('revise:'.length) : null, title: a.title, detail: a.body, options: a.options, subjectHash: a.subjectHash, createdAt: a.createdAt })
  }
  for (const r of store.requestsByStatus(['asking'])) for (const q of store.questions(r.id)) {
    if (q.answer !== null) continue
    items.push({ kind: 'ceo_question', id: q.id, revision: 0, requestId: r.id, taskId: null, title: q.question, detail: q.reason, options: q.options, subjectHash: null, createdAt: r.updated_at })
  }
  for (const t of store.tasksByStatus(['question'])) for (const q of store.taskQuestions(t.id)) {
    if (q.answer !== null || q.revision !== t.revision) continue
    items.push({ kind: 'worker_question', id: q.id, revision: t.revision, requestId: t.request_id, taskId: t.id, title: `${t.title}: ${q.question}`, detail: `기본값: ${q.default}`, options: q.options, subjectHash: null, createdAt: q.created_at })
  }
  for (const t of store.tasksByStatus(['blocked'])) {
    items.push({ kind: 'blocked', id: t.id, revision: t.revision, requestId: t.request_id, taskId: t.id, title: `작업 ${t.title}이(가) 막혔어요`, detail: t.note ?? '', options: BLOCKED_OPTIONS, subjectHash: null, createdAt: t.updated_at })
  }
  return items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.createdAt.localeCompare(b.createdAt))
}

export function currentAttempt(store: Store, taskId: string): AttemptRow | null { return store.attempts(taskId).at(-1) ?? null }

export const hqDirOf = (a: AttemptRow) => join(a.dir, 'hq')
export const outDirOf = (a: AttemptRow) => join(a.dir, 'out')

export function taskView(store: Store, t: TaskRow, activity: (a: AttemptRow) => string | null = (a) => lastActivityOf(hqDirOf(a))): TaskView {
  const cur = currentAttempt(store, t.id)
  return {
    id: t.id, key: t.key, requestId: t.request_id, project: t.project, title: t.title, role: t.role, grade: t.grade, model: t.model,
    status: t.status as TaskView['status'], attempts: t.attempts, currentAttemptId: cur?.id ?? null, lastActivity: cur ? activity(cur) : null,
    questions: t.status === 'question' ? store.taskQuestions(t.id).filter((q) => q.revision === t.revision && q.answer === null).map((q) => ({ id: q.id, question: q.question, options: q.options, default: q.default })) : [],
    note: t.note, headSha: t.head_sha, revision: t.revision, reviewModel: t.review_model, updatedAt: t.updated_at,
  }
}

export const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

export function workerViews(store: Store, activity: (a: AttemptRow) => string | null = (a) => lastActivityOf(hqDirOf(a)), holdUntil: string | null = null): WorkerView[] {
  const out: WorkerView[] = []
  for (const a of store.liveAttempts()) {
    const t = store.task(a.task_id)
    if (!t) continue
    const review = a.kind === 'review'
    out.push({ attemptId: a.id, taskId: t.id, requestId: t.request_id, title: t.title, project: t.project, role: t.role, model: a.model,
      kind: review ? 'review' : 'work', state: review ? 'reviewing' : 'running', bubble: activity(a) ?? (review ? '검토 준비 중' : '준비 중'), startedAt: a.started_at ?? t.updated_at })
  }
  for (const t of store.tasksByStatus(['verifying', 'held', 'blocked'])) {
    const last = store.attempts(t.id).at(-1)
    const base = { attemptId: last?.id ?? '', taskId: t.id, requestId: t.request_id, title: t.title, project: t.project, role: t.role, startedAt: t.updated_at }
    if (t.status === 'verifying') out.push({ ...base, attemptId: store.attempts(t.id).filter((x) => x.kind === 'work').at(-1)?.id ?? '', model: 'hq', kind: 'verify', state: 'verifying', bubble: '수용 기준 검사 중' })
    else if (t.status === 'held') out.push({ ...base, model: t.model, kind: 'work', state: 'held', bubble: holdUntil ? `한도 보류 · ${hhmm(holdUntil)}까지` : '한도 보류' })
    else out.push({ ...base, model: t.model, kind: last?.kind === 'review' ? 'review' : 'work', state: 'blocked', bubble: '멈춤 · 사장에게 보고' })
  }
  return out
}

const WINDOW_NAMES: Record<string, string> = { five_hour: '5시간', seven_day: '7일', seven_day_opus: '7일(opus)', seven_day_sonnet: '7일(sonnet)', team: '팀' }

export interface HeadlineInput {
  decisions: DecisionItem[]
  /** Blocked requests without a decision item (§18 장애). */
  failures: { title: string; reason: string }[]
  workers: WorkerView[]
  ceoThinking: boolean
  /** Tasks ready to start but waiting for a slot or the quota. */
  waiting: number
  quota: QuotaState
  /** Request merged within the last 10 minutes. */
  recentMerged: string | null
  /** For a verify worker: whether an LLM review follows. */
  reviewFollows?: (taskId: string) => boolean
}

export function buildHeadline(h: HeadlineInput): Headline {
  const needsYou = h.decisions.length
  if (needsYou) return { text: `회장님 결정 ${needsYou}건: ${h.decisions[0].title}`, needsYou }
  if (h.failures.length) return { text: `${h.failures[0].title}이 막혔어요: ${h.failures[0].reason.split('\n')[0].slice(0, 80)}`, needsYou }
  const active = h.workers.filter((w) => w.state !== 'held' && w.state !== 'blocked')
  if (active.length) {
    const w = active[0]
    const verb = w.kind === 'review' ? '검토' : w.kind === 'verify' ? '검증' : '구현'
    const next = w.kind === 'work' ? (w.role === 'collect' ? '결과 수락' : '검증') : w.kind === 'verify' ? (h.reviewFollows?.(w.taskId) === false ? '통합' : '검토') : '통합'
    return { text: `${w.model}가 ${w.title} ${verb} 중 · 다음: ${next}${active.length > 1 ? ` 외 ${active.length - 1}명` : ''}`, needsYou }
  }
  if (h.ceoThinking) return { text: '사장이 계획 중이에요', needsYou }
  const held = h.workers.some((w) => w.state === 'held')
  if (h.quota.mode === 'hold' && (h.waiting > 0 || held) && h.quota.until) {
    const pct = Math.round((h.quota.pct ?? 1) * 100)
    return { text: `사용 한도 ${WINDOW_NAMES[h.quota.window ?? ''] ?? h.quota.window ?? ''} ${pct}% — ${hhmm(h.quota.until)}까지 쉬어요`, needsYou }
  }
  if (h.waiting > 0) return { text: h.quota.mode === 'unobserved' ? '한도 관측 전이라 하나씩 실행 중' : `빈 자리 기다리는 중 (${h.waiting}건)`, needsYou }
  if (h.recentMerged) return { text: `병합 완료: ${h.recentMerged}`, needsYou }
  return { text: '지금 하실 일은 없어요', needsYou }
}
