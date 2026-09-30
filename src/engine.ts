// Moves chairman requests through CEO judgment turns, one at a time.
// queued → thinking → asking (questions) → queued (all answered) → thinking → planned → (plan card) → executing (runner)
import { createHash, randomUUID } from 'node:crypto'
import type { Bus } from './bus.ts'
import { reviewModelOf, runCeoTurn, validate, type CeoPlan, type Project } from './ceo.ts'
import type { Runner } from './exec/runner.ts'
import type { Store } from './store.ts'

const MAX_TURNS = 6
const MAX_CORRECTIONS = 1
const PLAN_TTL_MS = 7 * 24 * 60 * 60_000
/** Back-off after a limit stop that left no quota observation (the quota table has nothing to hold on). */
const UNOBSERVED_LIMIT_BACKOFF_MS = 5 * 60_000

export class RequestEngine {
  private store: Store
  private bus: Bus
  private projects: Project[]
  private hqRoot: string
  private runner: Runner
  private timer: NodeJS.Timeout | null = null
  private backoffUntil = 0

  constructor(store: Store, bus: Bus, projects: Project[], hqRoot: string, runner: Runner) {
    this.store = store; this.bus = bus; this.projects = projects; this.hqRoot = hqRoot; this.runner = runner
  }

  start(intervalMs = 3_000): void { this.timer = setInterval(() => void this.tick(), intervalMs) }
  stop(): void { if (this.timer) clearInterval(this.timer) }

  submit(text: string, projectId: string): string {
    const id = 'req-' + randomUUID().slice(0, 8)
    this.store.addRequest(id, projectId, text)
    this.bus.emit({ kind: 'request', text: `새 요청: ${text.slice(0, 60)}`, data: { id } })
    void this.tick()
    return id
  }

  /** Records one answer to a question owned by this request; with none left unanswered the request goes back to the CEO. */
  answer(requestId: string, questionId: string, answer: string): string | null {
    const err = this.store.tx(() => {
      const r = this.store.request(requestId)
      if (!r || r.status !== 'asking') return '질문을 기다리는 요청이 아닙니다'
      if (!this.store.answer(requestId, questionId, answer)) return '이 요청의 미답 질문이 아닙니다'
      if (this.store.questions(requestId).every((q) => q.answer !== null)) this.store.updateRequest(requestId, { status: 'queued' })
      return null
    })
    if (err) return err
    this.bus.emit({ kind: 'request', text: `답변: ${answer}`, data: { id: requestId } })
    void this.tick()
    return null
  }

  async tick(): Promise<void> {
    if (Date.now() < this.backoffUntil || !this.runner.canStartCeo()) return
    const r = this.store.nextQueued()
    if (!r || !this.runner.ceoLock.tryAcquire()) return
    try { await this.turn(r.id) } finally { this.runner.ceoLock.release() }
    void this.tick()
  }

  private async turn(id: string): Promise<void> {
    const r = this.store.request(id)!
    const project = this.projects.find((p) => p.id === r.project)
    if (!project) { this.fail(id, `등록되지 않은 프로젝트: ${r.project}`); return }
    if (r.turns >= MAX_TURNS) { this.fail(id, `사장 턴 상한(${MAX_TURNS}) 도달`); return }
    this.store.updateRequest(id, { status: 'thinking', turns: r.turns + 1 })
    this.bus.emit({ kind: 'request', text: '사장이 검토 중', data: { id, state: 'thinking' } })

    const answers = this.store.questions(id).filter((q) => q.answer !== null).map((q) => ({ question: q.question, answer: q.answer! }))
    const base = { request: r.text, answers, project, projects: this.projects, hqRoot: this.hqRoot, claudeBin: this.runner.cfg.claudeBin,
      onLine: (line: Record<string, unknown>) => { if (line.type === 'rate_limit_event') this.runner.observe(line) } }
    let t = await runCeoTurn({ ...base, correction: r.note && r.corrections > 0 ? r.note : null, resumeSessionId: r.session_id })
    // A failed resume falls back once to a fresh session that gets the stored conversation (request + answers).
    if (!t.ok && !t.limited && r.session_id) t = await runCeoTurn({ ...base, correction: null, resumeSessionId: null })
    if (this.store.request(id)?.status !== 'thinking') return // cancelled meanwhile
    this.store.updateRequest(id, { session_id: t.sessionId, cost_usd: r.cost_usd + (t.costUsd ?? 0) })

    if (t.limited) {
      if (this.runner.canStartCeo()) this.backoffUntil = Date.now() + UNOBSERVED_LIMIT_BACKOFF_MS
      this.store.updateRequest(id, { status: 'queued', note: '사용 한도, 대기' })
      this.bus.emit({ kind: 'limit', text: '사장 턴이 사용 한도에 걸림 — 한도가 풀리면 다시 해요' })
      return
    }
    if (!t.ok || !t.output) { this.fail(id, `사장 턴 실패: ${(t.error ?? '').slice(0, 300)}`); return }

    const problem = validate(t.output, this.projects)
    if (problem) {
      if (r.corrections >= MAX_CORRECTIONS) { this.fail(id, `계획을 만들지 못했어요: ${problem}`); return }
      this.store.updateRequest(id, { status: 'queued', corrections: r.corrections + 1, note: problem })
      this.bus.emit({ kind: 'request', text: `사장 출력 정정 요청: ${problem}`, data: { id } })
      return
    }
    if (t.output.questions.length) {
      this.store.tx(() => {
        this.store.addQuestions(id, t.output!.questions.map((q) => ({ id: 'q-' + randomUUID().slice(0, 8), ...q })))
        this.store.updateRequest(id, { status: 'asking', note: null })
      })
      this.bus.emit({ kind: 'request', text: `사장 질문 ${t.output.questions.length}개`, data: { id, state: 'asking' } })
      return
    }
    const p = t.output.plan!
    const plan = JSON.stringify(p)
    const planHash = createHash('sha256').update(plan).digest('hex')
    this.store.tx(() => {
      this.store.updateRequest(id, { status: 'planned', plan, plan_hash: planHash, note: null })
      this.store.putApproval({ id: `plan:${id}`, teamId: 'ceo', subjectId: id, title: `계획 승인: ${p.summary.slice(0, 60)}`, body: planCardBody(p, this.projects),
        options: ['승인', '반려'], subjectHash: planHash, expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString() })
    })
    this.bus.emit({ kind: 'request', text: `계획 완성: 작업 ${p.tasks.length}개`, data: { id, state: 'planned' } })
  }

  /** Called when the chairman decides the plan card. Returns a Korean reason when execution could not start. */
  async planDecided(requestId: string, decision: string): Promise<string | null> {
    if (decision !== '승인') {
      this.store.updateRequest(requestId, { status: 'rejected' })
      this.bus.emit({ kind: 'request', text: `계획 ${decision}`, data: { id: requestId, state: 'rejected' } })
      return null
    }
    this.bus.emit({ kind: 'request', text: '계획 승인', data: { id: requestId } })
    return this.runner.createTasks(requestId)
  }

  private fail(id: string, why: string): void {
    this.runner.failRequest(id, why)
  }
}

/** §3 plan card: every task with role/grade/model/review model, owned paths, the exact check commands, and project setup. */
export function planCardBody(p: CeoPlan, projects: Project[]): string {
  const lines: string[] = []
  for (const t of p.tasks) {
    lines.push(`[${t.id}] ${t.title} · ${t.role}·${t.grade}·${t.model} · 검토 ${reviewModelOf(t)}${t.depends_on.length ? ` · 선행 ${t.depends_on.join(', ')}` : ''}`)
    if (t.owns.length) lines.push(`  소유: ${t.owns.join(', ')}`)
    for (const a of t.acceptance) lines.push(`  - [${a.id}] ${a.text}\n    $ ${a.check}`)
  }
  const setups = [...new Set(p.tasks.map((t) => t.project))].map((id) => projects.find((x) => x.id === id)).filter((x) => x?.setup)
  if (setups.length) lines.push('', '프로젝트 setup (작업 폴더마다 샌드박스에서 실행):', ...setups.map((x) => `  ${x!.id}: $ ${x!.setup}`))
  return lines.join('\n')
}
