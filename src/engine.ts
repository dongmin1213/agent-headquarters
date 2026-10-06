// Moves chairman requests through CEO judgment turns, one at a time.
// queued → thinking → asking (questions) → queued (all answered) → thinking → planned → (plan card) → executing (runner)
import { createHash, randomUUID } from 'node:crypto'
import type { Bus } from './bus.ts'
import { reviewModelOf, runCeoTurn, runJsonTurn, TASK_SCHEMA, validate, type CeoPlan, type PlanTask, type Project } from './ceo.ts'
import type { Runner } from './exec/runner.ts'
import { GAME_ECONOMY_RULES, GAME_PLAYTEST_RULES, gameEnabled, gamePlanProblem, gameWaiting, gameWaitSignature } from './game.ts'
import type { TaskRow } from './store.ts'
import type { Store } from './store.ts'

const MAX_TURNS = 6
const MAX_CORRECTIONS = 1
const PLAN_TTL_MS = 7 * 24 * 60 * 60_000
const OWNER_DECISIONS = ['none', 'payment', 'publication', 'credentials', 'destructive', 'scope_change', 'missing_user_input'] as const
interface GameDecision {
  proceed: boolean; answer: string; revised_task: PlanTask | null
  owner_decision: typeof OWNER_DECISIONS[number]
}
const GAME_DECISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['proceed', 'answer', 'revised_task', 'owner_decision'],
  properties: { proceed: { type: 'boolean' }, answer: { type: 'string' },
    revised_task: { anyOf: [{ type: 'null' }, TASK_SCHEMA] }, owner_decision: { enum: OWNER_DECISIONS } },
}

export class RequestEngine {
  private store: Store
  private bus: Bus
  private projects: Project[]
  private hqRoot: string
  private runner: Runner
  private timer: NodeJS.Timeout | null = null

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
    if (!this.runner.canStartCeo()) return
    if (await this.manageGame()) return
    const r = this.store.requestsByStatus(['queued']).find(r => this.projects.find(p => p.id === r.project)?.workflow !== 'game' || gameEnabled(this.store, r.project))
    if (!r || !this.runner.ceoLock.tryAcquire()) return
    try { await this.turn(r.id) } finally { this.runner.ceoLock.release() }
    void this.tick()
  }

  /** Internal questions and recoverable blocks go to the team leader, not the chairman. */
  private async manageGame(): Promise<boolean> {
    for (const r of this.store.requestsByStatus(['executing', 'blocked', 'planned'])) {
      const p = this.projects.find(p => p.id === r.project)
      if (p?.workflow !== 'game' || !gameEnabled(this.store, p.id)) continue
      if (r.status === 'planned') {
        const card = this.store.approval(`plan:${r.id}`)
        const problem = r.plan ? gamePlanProblem(JSON.parse(r.plan), p.id) : '계획 없음'
        if (problem) { this.fail(r.id, problem); return true }
        if (card?.state === 'open') { await this.runner.decide(card.id, '승인', card.subjectHash); return true }
      }
      const tasks = this.store.tasks(r.id)
      const attempts = tasks.reduce((n, t) => n + this.store.attempts(t.id).length, 0)
      if (attempts >= 100) { this.fail(r.id, '게임팀 실행 상한 100회에 도달했습니다. 완성으로 처리하지 않습니다.'); return true }
      const integration = this.store.openApprovals().find(a => a.id.startsWith(`integration:${r.id}:`))
      if (integration) {
        const key = `game.integration:${r.id}`, rounds = Number(this.store.get(key) ?? 0)
        if (rounds >= 2) { this.fail(r.id, '게임 통합 실패를 자체 복구하지 못했습니다. 출시 후보로 제출하지 않습니다.'); return true }
        this.store.set(key, String(rounds + 1))
        // Never waive a failing check via the "known failure" option.
        const choice = integration.options.includes('해당 작업 재작업') ? '해당 작업 재작업' : '다시 통합'
        await this.runner.decide(integration.id, choice, integration.subjectHash)
        return true
      }
      const t = tasks.find(t => !gameWaiting(this.store, t) && (t.status === 'question' || (t.status === 'blocked' && !t.lingering && t.diagnosis !== null)))
      if (!t || !this.runner.ceoLock.tryAcquire()) continue
      try {
        const rounds = Number(this.store.get(`game.decisions:${t.id}`) ?? 0)
        if (rounds >= 3) { this.waitGameTask(t, `피카츄 내부 복구 상한 도달 · 미해결 상태를 보존합니다: ${t.title} — ${t.note ?? ''}`, false); return true }
        const questions = this.store.taskQuestions(t.id).filter(q => q.answer === null)
        const decisionModel = rounds === 0 ? 'sonnet' : 'opus'
        const supervisor = rounds > 0
        const signature = gameWaitSignature(this.store, t)
        const previous = this.store.get(`game.decision:${t.id}:${rounds}`) ?? '(없음)'
        const result = await runJsonTurn({ codexBin: this.runner.cfg.codexBin, runtimeHome: this.runner.home, model: this.runner.cfg.models[decisionModel],
          cwd: t.worktree ?? p.path, sessionId: randomUUID(), resume: false, addDirs: [], timeoutMs: 5 * 60_000,
          prompt: `너는 ${supervisor ? '피카츄 독립 감독자' : '게임팀장'}이다.\n${GAME_ECONOMY_RULES}\n${GAME_PLAYTEST_RULES}\n사용자에게 세부 기획·구현 판단을 떠넘기지 않고 해결한다. ${supervisor ? '팀장의 판단을 그대로 전달하지 말고 실제 코드·실패 증거·기존 위임 범위를 대조하여 재검토한다.' : '현재 작업 파일과 선행 기획을 확인해 실행 가능한 결정을 내린다.'}\n요청: ${r.text}\n작업: ${t.spec}\n상태: ${t.status}\n문제: ${t.note}\n진단: ${t.diagnosis}\n질문: ${JSON.stringify(questions)}\n전체 작업 계약: ${JSON.stringify(tasks.map(x => ({ key: x.key, status: x.status, project: x.project, role: x.role, owns: JSON.parse(x.spec).owns, depends_on: JSON.parse(x.spec).depends_on })))}\n이전 내부 판단: ${previous}\n
출력 계약:
- answer에 확인한 원인·근거, 선택한 수정, 재검 방법을 구체적으로 기록한다. 실패한 방법을 바꾸지 않은 단순 재시도는 금지한다.
- 현재 범위에서 해결 가능하면 proceed=true, revised_task=null로 구체적인 작업 지시를 낸다.
- 소유 범위 때문에 막혔으면 proceed=true와 현재 작업의 revised_task 전체를 제출한다. API가 실제 재배정과 재실행을 처리한다. 다른 담당자에게 반환한다고 적는 것만으로는 아무 작업도 재배정되지 않는다.
- revised_task는 title/brief/owns만 변경할 수 있다. 완료 기준의 id/text/check/kind, 독립 검토, 작업 id/project/role/department/grade/model, depends_on은 그대로 보존한다. 통과한 선행 분기의 필요한 파일만 추가하고 전체 작업 계약에서 병렬 소유 충돌이 없는지 확인한다. 수정 후 관련 회귀와 독립 검수는 필수다. 기존 결과를 보존한다.
- 등록된 프로젝트 내부의 파일 소유 조정·구현·기획·검수·재작업은 이미 위임된 일이다. 외부 권한 변경으로 분류하지 않는다. 현재 판단 세션은 읽기 전용이며 쓰기는 별도 작업자가 수행한다.
- 결제(payment), 외부 공개(publication), 사용자 로그인(credentials), 위임 밖 파괴적 작업(destructive), 원래 목표의 실질 변경(scope_change), 조사로도 확보할 수 없는 필수 사용자 정보(missing_user_input)만 owner_decision으로 올릴 수 있다. 그 외는 none이다. 이미 승인된 행동에 재승인을 요구하지 않는다.
- owner_decision이 none 이외이면 proceed=false, revised_task=null이어야 한다. answer에는 이미 시도한 방법과 근거, 내부 해결이 안 되는 이유, 사용자가 결정할 정확한 사항과 추천안을 포함한다.
- 기술 문제를 이번 판단에서도 해결 못하면 proceed=false, owner_decision=none으로 미해결을 보고한다. 이를 사용자에게 '재시도/건너뛰기' 선택을 떠넘길 근거로 쓰지 않는다. 완료 기준을 낮추거나 검사를 면제하지 않는다.\n${this.runner.gameTaskEvidence(t.id)}`,
          schema: GAME_DECISION_SCHEMA,
          onLine: line => { if (line.type === 'rate_limit_event') this.runner.observe(line) } })
        if (result.limited) { this.runner.limitBackoff(); return true }
        if (!result.ok && /Not logged in|authentication|unauthorized|401|refresh.token/i.test(result.error ?? '')) { this.runner.requireLogin(result.error ?? 'Not logged in'); return true }
        const current = this.store.task(t.id)
        if (!gameEnabled(this.store, p.id) || !current || gameWaitSignature(this.store, current) !== signature || !['executing', 'blocked'].includes(this.store.request(r.id)?.status ?? '')) return true
        this.store.set(`game.decisions:${t.id}`, String(rounds + 1))
        const o = result.output as GameDecision | null
        const valid = result.ok && o && typeof o.proceed === 'boolean' && typeof o.answer === 'string' && o.answer.trim()
          && OWNER_DECISIONS.includes(o.owner_decision) && (o.revised_task === null || typeof o.revised_task === 'object')
          && (o.owner_decision === 'none' || (!o.proceed && o.revised_task === null)) && (o.proceed || o.revised_task === null)
        this.store.set(`game.decision:${t.id}:${rounds + 1}`, JSON.stringify({ ...o, model: decisionModel, supervisor, error: result.error }))
        if (!valid || !o!.proceed) {
          const reason = valid ? o!.answer : `판단 출력 실패: ${result.error ?? '잘못된 출력 계약'}`
          // Even a lead's escalation must be independently examined before reaching the user.
          if (!supervisor) this.bus.emit({ kind: 'task', text: `피카츄가 팀장 판단을 재검토합니다: ${t.title}`, data: { id: t.id } })
          else this.waitGameTask(t, `피카츄 검토: ${reason}`, !!valid && o!.owner_decision !== 'none')
          return true
        }
        const decision = o!
        let problem: string | null = null
        if (decision.revised_task) problem = this.runner.repairGameTask(t.id, decision.revised_task, signature)
        else if (t.status === 'question') {
          for (const q of questions) {
            problem = this.runner.answerTask(t.id, q.id, `[${supervisor ? '피카츄' : '게임팀장'} 결정] ${decision.answer}`, t.revision)
            if (problem) break
          }
        } else {
          problem = this.runner.decideTask(t.id, 'retry', t.block_count)
          if (!problem) {
            const cur = this.store.task(t.id)!
            this.store.updateTask(t.id, { note: `${cur.note ?? ''}\n내부 수정 방향: ${decision.answer}`.slice(-4000) })
          }
        }
        if (problem) {
          this.store.set(`game.decision:${t.id}:${rounds + 1}`, JSON.stringify({ ...decision, model: decisionModel, supervisor, error: problem }))
          if (rounds >= 2) this.waitGameTask(t, `피카츄 수정안 적용 실패: ${problem}`, false)
          return true
        }
        this.bus.emit({ kind: 'request', text: `${supervisor ? '피카츄' : '게임팀장'}가 해결 지시를 적용했어요: ${t.title}`, data: { id: r.id } })
        return true
      } finally { this.runner.ceoLock.release() }
    }
    return false
  }

  private async turn(id: string): Promise<void> {
    const r = this.store.request(id)!
    const project = this.projects.find((p) => p.id === r.project)
    if (!project) { this.fail(id, `등록되지 않은 프로젝트: ${r.project}`); return }
    if (r.turns >= MAX_TURNS) { this.fail(id, `사장 턴 상한(${MAX_TURNS}) 도달`); return }
    this.store.updateRequest(id, { status: 'thinking', turns: r.turns + 1 })
    this.bus.emit({ kind: 'request', text: project.workflow === 'game' ? '게임팀장이 제작 계획을 세우고 있어요' : '사장이 검토 중', data: { id, state: 'thinking' } })

    const answers = this.store.questions(id).filter((q) => q.answer !== null).map((q) => ({ question: q.question, answer: q.answer! }))
    const base = { request: r.text, answers, project, projects: this.projects, hqRoot: this.hqRoot, codexBin: this.runner.cfg.codexBin, runtimeHome: this.runner.cfg.home, model: this.runner.cfg.models.sonnet,
      onLine: (line: Record<string, unknown>) => { if (line.type === 'rate_limit_event') this.runner.observe(line) } }
    let t = await runCeoTurn({ ...base, correction: r.note && r.corrections > 0 ? r.note : null, resumeSessionId: r.session_id })
    // A failed resume falls back once to a fresh session that gets the stored conversation (request + answers).
    if (!t.ok && !t.limited && r.session_id) t = await runCeoTurn({ ...base, correction: null, resumeSessionId: null })
    if (this.store.request(id)?.status !== 'thinking') return // cancelled meanwhile
    this.store.updateRequest(id, { session_id: t.sessionId, cost_usd: r.cost_usd + (t.costUsd ?? 0) })

    if (!t.ok && /Not logged in|authentication|unauthorized|401|refresh.token/i.test(t.error ?? '')) {
      this.store.updateRequest(id, { status: 'queued', note: 'Codex 로그인 필요, 대기' })
      this.runner.requireLogin(t.error ?? 'Not logged in')
      return
    }
    if (t.limited) {
      if (this.runner.quota().mode !== 'hold') this.runner.limitBackoff()
      this.store.updateRequest(id, { status: 'queued', note: '사용 한도, 대기' })
      this.bus.emit({ kind: 'limit', text: '사장 턴이 사용 한도에 걸림 — 한도가 풀리면 다시 해요' })
      return
    }
    if (!t.ok || !t.output) { this.fail(id, `사장 턴 실패: ${(t.error ?? '').slice(0, 300)}`); return }

    const problem = validate(t.output, this.projects) ?? (project.workflow === 'game' ? (t.output.questions.length ? '세부 기획은 게임팀장이 결정하세요. 질문 대신 가정과 계획을 제출하세요.' : gamePlanProblem(t.output.plan!, project.id)) : null)
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
    if (project.workflow === 'game' && !gameEnabled(this.store, project.id)) { this.store.updateRequest(id, { status: 'queued', note: '게임팀 꺼짐 · 계획은 다시 확인합니다' }); return }
    const p = t.output.plan!
    const plan = JSON.stringify(p)
    const planHash = createHash('sha256').update(plan).digest('hex')
    this.store.tx(() => {
      this.store.updateRequest(id, { status: 'planned', plan, plan_hash: planHash, note: null })
      this.store.putApproval({ id: `plan:${id}`, teamId: 'ceo', subjectId: id, title: `계획 승인: ${p.summary.slice(0, 60)}`, body: planCardBody(p, this.projects),
        options: ['승인', '반려'], subjectHash: planHash, expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString() })
    })
    if (project.workflow === 'game') {
      const decided = await this.runner.decide(`plan:${id}`, '승인', planHash)
      if (decided.status !== 200) { this.fail(id, `게임팀 계획 시작 실패: ${JSON.stringify(decided.body)}`); return }
      this.store.set(`game.started:${id}`, String(this.runner.now()))
      this.bus.emit({ kind: 'request', text: '게임팀 계획 검사 통과 · 직군별 제작 시작', data: { id } })
      return
    }
    this.bus.emit({ kind: 'request', text: `계획 완성: 작업 ${p.tasks.length}개`, data: { id, state: 'planned' } })
  }

  private fail(id: string, why: string): void {
    this.runner.failRequest(id, why)
  }

  /** Preserve the failed criterion and stop repeated decisions, without stopping independent work. */
  private waitGameTask(t: TaskRow, reason: string, needsUser: boolean): void {
    this.store.tx(() => {
      this.store.set(`game.waiting:${t.id}`, JSON.stringify({ signature: gameWaitSignature(this.store, t), reason, needsUser, at: new Date().toISOString() }))
      this.store.updateTask(t.id, { note: reason.slice(0, 4000) })
      if (this.store.request(t.request_id)?.status === 'blocked') this.store.updateRequest(t.request_id, { status: 'executing' })
    })
    this.bus.emit({ kind: 'task', text: `${t.title}: ${needsUser ? '사용자 결정 필요' : '내부 복구 보류 · 미해결 원인 보고'} · 독립 작업은 계속`, data: { id: t.id } })
  }
}

/** §3 plan card: every task with role/grade/model/review model, owned paths, the exact check commands, and project setup. */
export function planCardBody(p: CeoPlan, projects: Project[]): string {
  const lines: string[] = []
  for (const t of p.tasks) {
    lines.push(`[${t.id}] ${t.title} · ${t.role}·${t.grade}·${t.model} · 검토 ${reviewModelOf(t)}${t.depends_on.length ? ` · 선행 ${t.depends_on.join(', ')}` : ''}`)
    if (t.owns.length) lines.push(`  소유: ${t.owns.join(', ')}`)
    for (const a of t.acceptance) lines.push(`  - [${a.id}] (${a.kind === 'new' ? 'new' : 'regression'}) ${a.text}\n    $ ${a.check}`)
  }
  const setups = [...new Set(p.tasks.map((t) => t.project))].map((id) => projects.find((x) => x.id === id)).filter((x) => x?.setup)
  if (setups.length) lines.push('', '프로젝트 setup (작업 폴더마다 샌드박스에서 실행):', ...setups.map((x) => `  ${x!.id}: $ ${x!.setup}`))
  return lines.join('\n')
}
