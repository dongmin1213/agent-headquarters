// Moves chairman requests through CEO judgment turns, one at a time.
// queued → thinking → asking (questions) → queued (all answered) → thinking → planned → (plan approval) → approved
import { createHash, randomUUID } from 'node:crypto'
import type { Bus } from './bus.ts'
import { runCeoTurn, validate, type Project } from './ceo.ts'
import { notify } from './notify.ts'
import type { Store } from './store.ts'

const MAX_TURNS = 6
const MAX_CORRECTIONS = 1
const LIMIT_HOLD_MS = 60 * 60_000

export class RequestEngine {
  private busy = false
  private store: Store
  private bus: Bus
  private projects: Project[]
  private hqRoot: string

  constructor(store: Store, bus: Bus, projects: Project[], hqRoot: string) {
    this.store = store; this.bus = bus; this.projects = projects; this.hqRoot = hqRoot
  }

  start(): void { setInterval(() => void this.tick(), 3_000) }

  submit(text: string, projectId: string): string {
    const id = 'req-' + randomUUID().slice(0, 8)
    this.store.addRequest(id, projectId, text)
    this.bus.emit({ kind: 'request', text: `새 요청: ${text.slice(0, 60)}`, data: { id } })
    void this.tick()
    return id
  }

  /** Records one answer; when the request has no unanswered question left, it goes back to the CEO. */
  answer(requestId: string, questionId: string, answer: string): boolean {
    const r = this.store.request(requestId)
    if (!r || r.status !== 'asking' || !this.store.answer(questionId, answer)) return false
    if (this.store.questions(requestId).every((q) => q.answer !== null)) {
      this.store.updateRequest(requestId, { status: 'queued' })
      void this.tick()
    }
    this.bus.emit({ kind: 'request', text: `답변: ${answer}`, data: { id: requestId } })
    return true
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    const hold = this.store.get('limit.blockedUntil')
    if (hold && Date.parse(hold) > Date.now()) return
    const r = this.store.nextQueued()
    if (!r) return
    this.busy = true
    try { await this.turn(r.id) } finally { this.busy = false }
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
    let t = await runCeoTurn({ request: r.text, answers, correction: r.note && r.status === 'queued' && r.corrections > 0 ? r.note : null,
      project, projects: this.projects, resumeSessionId: r.session_id, hqRoot: this.hqRoot })
    // A failed resume falls back once to a fresh session that gets the stored conversation (request + answers).
    if (!t.ok && !t.limited && r.session_id) {
      t = await runCeoTurn({ request: r.text, answers, correction: null, project, projects: this.projects, resumeSessionId: null, hqRoot: this.hqRoot })
    }
    const cost = r.cost_usd + (t.costUsd ?? 0)
    this.store.updateRequest(id, { session_id: t.sessionId, cost_usd: cost })

    if (t.limited) {
      const until = new Date(Date.now() + LIMIT_HOLD_MS).toISOString()
      this.store.set('limit.blockedUntil', until)
      this.store.updateRequest(id, { status: 'queued', note: '사용 한도, 대기' })
      this.bus.emit({ kind: 'limit', text: `사장 턴이 사용 한도에 걸림 — ${until}까지 대기` })
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
      this.store.addQuestions(id, t.output.questions.map((q) => ({ id: 'q-' + randomUUID().slice(0, 8), ...q })))
      this.store.updateRequest(id, { status: 'asking', note: null })
      this.bus.emit({ kind: 'request', text: `사장 질문 ${t.output.questions.length}개`, data: { id, state: 'asking' } })
      notify('사장이 질문했어요', t.output.questions[0].question)
      return
    }
    const plan = JSON.stringify(t.output.plan)
    const planHash = createHash('sha256').update(plan).digest('hex')
    this.store.updateRequest(id, { status: 'planned', plan, plan_hash: planHash, note: null })
    const p = t.output.plan!
    this.store.upsertApproval({
      id: `plan:${id}`, teamId: 'ceo', title: `계획 승인: ${p.summary.slice(0, 60)}`,
      body: p.tasks.map((x) => `${x.id} [${x.grade}·${x.model}] ${x.title}`).join('\n'),
      options: ['승인', '반려'], subjectHash: planHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), createdAt: new Date().toISOString(),
    })
    this.bus.emit({ kind: 'request', text: `계획 완성: 작업 ${p.tasks.length}개`, data: { id, state: 'planned' } })
    notify('사장이 계획을 올렸어요', p.summary)
  }

  /** Called when the chairman decides the plan approval card. */
  planDecided(requestId: string, decision: string): void {
    this.store.updateRequest(requestId, { status: decision === '승인' ? 'approved' : 'rejected' })
    this.bus.emit({ kind: 'request', text: `계획 ${decision}`, data: { id: requestId } })
  }

  private fail(id: string, why: string): void {
    this.store.updateRequest(id, { status: 'failed', note: why })
    this.bus.emit({ kind: 'request', text: why, data: { id, state: 'failed' } })
    notify('요청 처리 실패', why)
  }
}
