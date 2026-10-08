// Moves chairman requests through CEO judgment turns, one at a time.
// queued → thinking → asking (questions) → queued (all answered) → thinking → planned → (plan card) → executing (runner)
import { createHash, randomUUID } from 'node:crypto'
import type { Bus } from './bus.ts'
import { reviewModelOf, runCeoTurn, runJsonTurn, TASK_SCHEMA, validate, type CeoPlan, type PlanTask, type Project } from './ceo.ts'
import type { Runner } from './exec/runner.ts'
import { GAME_ECONOMY_RULES, GAME_PLAYTEST_RULES, gameEnabled, gamePlanProblem, gameWaiting, gameWaitSignature, gameDecisionReady, transientDecisionFailure } from './game.ts'
import type { TaskRow } from './store.ts'
import type { Store } from './store.ts'
import { flowCandidates, flowDue, flowSignature, FLOW_MAX_TURNS } from './game-flow.ts'

const MAX_TURNS = 6
const MAX_CORRECTIONS = 1
const PLAN_TTL_MS = 7 * 24 * 60 * 60_000
const OWNER_DECISIONS = ['none', 'payment', 'publication', 'credentials', 'destructive', 'scope_change', 'missing_user_input'] as const
interface GameDecision {
  proceed: boolean; answer: string; revised_task: PlanTask | null
  repair_before?: string | null
  owner_decision: typeof OWNER_DECISIONS[number]
}
const GAME_DECISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['proceed', 'answer', 'revised_task', 'repair_before', 'owner_decision'],
  properties: { proceed: { type: 'boolean' }, answer: { type: 'string' },
    revised_task: { anyOf: [{ type: 'null' }, TASK_SCHEMA] }, repair_before: { type: ['string', 'null'] }, owner_decision: { enum: OWNER_DECISIONS } },
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
    if (this.runner.canStartGameSupervisor() && await this.manageGame()) return
    const r = this.store.requestsByStatus(['queued']).find(r => this.projects.find(p => p.id === r.project)?.workflow !== 'game' || gameEnabled(this.store, r.project))
    if (!r) { await this.manageGameFlow(); return }
    if (!this.runner.canStartCeo() || !this.runner.ceoLock.tryAcquire()) return
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
      const t = tasks.find(t => !gameWaiting(this.store, t) && gameDecisionReady(this.store, t, this.runner.now())
        && (t.status === 'question' || (t.status === 'blocked' && !t.lingering)))
      if (!t || !this.runner.ceoLock.tryAcquire()) continue
      try {
        const rounds = Number(this.store.get(`game.decisions:${t.id}`) ?? 0)
        const totalRounds = Number(this.store.get(`game.decisions-total:${t.id}`) ?? rounds)
        const reassess = this.store.get(`game.hold-reassess:${t.id}`) === gameWaitSignature(this.store, t)
        if (totalRounds >= 9) { this.waitGameTask(t, `피카츄 누적 복구 상한 9회 도달 · 미해결 근거를 보존합니다: ${t.title} — ${t.note ?? ''}`, false); return true }
        if (rounds >= 3 && !reassess) { this.waitGameTask(t, `피카츄 내부 복구 상한 도달 · 미해결 상태를 보존합니다: ${t.title} — ${t.note ?? ''}`, false); return true }
        const questions = this.store.taskQuestions(t.id).filter(q => q.answer === null)
        const decisionModel = rounds === 0 && !reassess ? 'sonnet' : 'opus'
        const supervisor = rounds > 0 || reassess
        const signature = gameWaitSignature(this.store, t)
        const previous = this.store.get(`game.decision:${t.id}:${rounds}`) ?? '(없음)'
        const result = await runJsonTurn({ codexBin: this.runner.cfg.codexBin, runtimeHome: this.runner.home, model: this.runner.cfg.models[decisionModel],
          cwd: t.worktree ?? p.path, sessionId: randomUUID(), resume: false, addDirs: [], timeoutMs: 5 * 60_000,
          prompt: `너는 ${supervisor ? '피카츄 독립 감독자' : '게임팀장'}이다.\n${GAME_ECONOMY_RULES}\n${GAME_PLAYTEST_RULES}\n사용자에게 세부 기획·구현 판단을 떠넘기지 않고 해결한다. ${supervisor ? '팀장의 판단을 그대로 전달하지 말고 실제 코드·실패 증거·기존 위임 범위를 대조하여 재검토한다.' : '현재 작업 파일과 선행 기획을 확인해 실행 가능한 결정을 내린다.'}\n요청: ${r.text}\n작업: ${t.spec}\n상태: ${t.status}\n문제: ${t.note}\n진단: ${t.diagnosis}\n질문: ${JSON.stringify(questions)}\n전체 작업 계약: ${JSON.stringify(tasks.map(x => ({ key: x.key, title: x.title, department: JSON.parse(x.spec).department, status: x.status, project: x.project, role: x.role, head_sha: x.head_sha, owns: JSON.parse(x.spec).owns, depends_on: JSON.parse(x.spec).depends_on })))}\n이전 내부 판단: ${previous}\n
출력 계약:
- 검수가 후속 수정 작업의 결과를 요구하여 멈췄다면 같은 검수를 반복하지 않는다. repair_before에 현재 작업을 직접 기다리는 미시작 pending 수정 작업 key를 지정하고 revised_task=null, proceed=true로 반환한다. HQ가 그 작업에 현재 선행 조건을 물려주어 먼저 실행하고 현재 검수는 그 결과를 기다리게 한다. 이미 시작한 작업·순환·검사 삭제는 허용하지 않는다. 순서 변경이 필요 없으면 repair_before=null이다.
- answer에 확인한 원인·근거, 선택한 수정, 재검 방법을 구체적으로 기록한다. 실패한 방법을 바꾸지 않은 단순 재시도는 금지한다.
- 작업자가 failed/blocked로 명시적으로 반려한 경우 같은 작업을 그대로 재시작하지 않는다. 선행 결과의 아트·지형 품질 문제가 원인이면 해당 파일과 담당/소유 범위를 확인하고, 수정 가능한 owns와 구체적인 brief를 revised_task로 재배정한다. 읽기 전용 진단만 남겨도 복구된 것으로 간주하지 않는다. 독립 검수와 원래 품질 기준은 유지한다. 답변은 한국어로 쓴다.
- 현재 범위에서 해결 가능하면 proceed=true, revised_task=null로 구체적인 작업 지시를 낸다.
- 병렬 작업의 자산/코드가 없다고 보고되면 전체 작업 계약의 해당 담당자 상태와 승인된 head_sha를 먼저 확인한다. 이미 완성된 다른 분기의 결과가 현재 checkout에 없는 경우 해당 작업을 depends_on에 추가한다. HQ는 새 기준 커밋을 제공하고 기존 구현을 보존하여 재배치·재검수한다. 이때 자산을 재생성하거나 소유 범위를 빼앗지 않는다. 담당 작업이 아직 실행 중이면 필요 의존을 추가해 완료를 기다리며 같은 검사를 재시도하지 않는다.
- 소유 범위 때문에 막혔으면 proceed=true와 현재 작업의 revised_task 전체를 제출한다. API가 실제 재배정과 재실행을 처리한다. 다른 담당자에게 반환한다고 적는 것만으로는 아무 작업도 재배정되지 않는다.
- revised_task는 title/brief/owns 및 같은 프로젝트의 선행 depends_on 추가만 변경할 수 있다. 기존 의존을 제거하거나 순환 의존을 만들지 않는다. 완료 기준의 id/text/check/kind, 독립 검토, 작업 id/project/role/department/grade/model은 그대로 보존한다. 통과한 선행 분기의 필요한 파일만 추가하고 전체 작업 계약에서 병렬 소유 충돌이 없는지 확인한다. 수정 후 관련 회귀와 독립 검수는 필수다. 기존 결과를 보존한다.
- 등록된 프로젝트 내부의 파일 소유 조정·구현·기획·검수·재작업은 이미 위임된 일이다. 외부 권한 변경으로 분류하지 않는다. 현재 판단 세션은 읽기 전용이며 쓰기는 별도 작업자가 수행한다.
- 결제(payment), 외부 공개(publication), 사용자 로그인(credentials), 위임 밖 파괴적 작업(destructive), 원래 목표의 실질 변경(scope_change), 조사로도 확보할 수 없는 필수 사용자 정보(missing_user_input)만 owner_decision으로 올릴 수 있다. 그 외는 none이다. 이미 승인된 행동에 재승인을 요구하지 않는다.
- owner_decision이 none 이외이면 proceed=false, revised_task=null이어야 한다. answer에는 이미 시도한 방법과 근거, 내부 해결이 안 되는 이유, 사용자가 결정할 정확한 사항과 추천안을 포함한다.
- 기술 문제를 이번 판단에서도 해결 못하면 proceed=false, owner_decision=none으로 미해결을 보고한다. 이를 사용자에게 '재시도/건너뛰기' 선택을 떠넘길 근거로 쓰지 않는다. 완료 기준을 낮추거나 검사를 면제하지 않는다.\n${this.runner.gamePlayTools()}\n${this.runner.gameTaskEvidence(t.id)}`,
          schema: GAME_DECISION_SCHEMA,
          onLine: line => { if (line.type === 'rate_limit_event') this.runner.observe(line) } })
        if (result.limited) { this.runner.limitBackoff(); return true }
        if (!result.ok && /Not logged in|authentication|unauthorized|401|refresh.token/i.test(result.error ?? '')) { this.runner.requireLogin(result.error ?? 'Not logged in'); return true }
        const current = this.store.task(t.id)
        if (!gameEnabled(this.store, p.id) || !current || gameWaitSignature(this.store, current) !== signature || !['executing', 'blocked'].includes(this.store.request(r.id)?.status ?? '')) return true
        if (!result.ok && transientDecisionFailure(result.error)) {
          const key = `game.decision-retry:${t.id}`
          let prior: { signature?: string; failures?: number } | null = null
          try { prior = JSON.parse(this.store.get(key) ?? 'null') } catch {}
          const failures = prior?.signature === signature ? Math.max(0, Number(prior.failures) || 0) + 1 : 1
          const delay = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 4))
          const until = this.runner.now() + delay
          this.store.set(key, JSON.stringify({ signature, failures, until, error: result.error }))
          this.store.updateTask(t.id, { note: `감독자 연결 오류 · ${Math.round(delay / 60_000)}분 후 자동 복구 판단 재시도: ${result.error}` })
          this.bus.emit({ kind: 'task', text: '감독자 연결 복구 대기 · 판단 예산 유지 · 독립 작업은 계속', data: { id: t.id } })
          return true
        }
        this.store.set(`game.decision-retry:${t.id}`, null)
        this.store.set(`game.hold-reassess:${t.id}`, null)
        this.store.set(`game.decisions:${t.id}`, String(rounds + 1))
        this.store.set(`game.decisions-total:${t.id}`, String(totalRounds + 1))
        const o = result.output as GameDecision | null
        const valid = result.ok && o && typeof o.proceed === 'boolean' && typeof o.answer === 'string' && o.answer.trim()
          && OWNER_DECISIONS.includes(o.owner_decision) && (o.revised_task === null || typeof o.revised_task === 'object')
          && (o.repair_before == null || (typeof o.repair_before === 'string' && !!o.repair_before.trim()
            && o.proceed && o.owner_decision === 'none' && o.revised_task === null))
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
        if (decision.repair_before) problem = this.runner.repairGameOrder(t.id, decision.repair_before, signature)
        else if (decision.revised_task) problem = this.runner.repairGameTask(t.id, decision.revised_task, signature)
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

  /** A bounded plan audit can run in a spare slot before any worker reports failure. */
  private async manageGameFlow(): Promise<void> {
    for (const r of this.store.requestsByStatus(['executing'])) {
      const p = this.projects.find(p => p.id === r.project)
      if (p?.workflow !== 'game') continue
      const rows = this.store.tasks(r.id), candidates = flowCandidates(this.store, rows)
      const eligible = gameEnabled(this.store, p.id) && this.runner.canStartGameSupervisor() && this.runner.cfg.maxWorkers > 1
        && this.runner.quota().mode !== 'save' && rows.length < 24 && candidates.length > 0
        && !this.runner.ceoLock.busy && !this.runner.ceoWaiting()
        && !this.runner.readyTasks().length && !this.store.tasksByStatus(['reviewing']).some(t => !this.store.liveAttempts().some(a => a.task_id === t.id))
      if (!flowDue(this.store, r.id, rows, this.runner.now(), eligible) || !this.runner.ceoLock.tryAcquire()) continue
      const signature = flowSignature(rows), count = Number(this.store.get(`game.flow-count:${r.id}`) ?? 0)
      this.store.set(`game.flow-count:${r.id}`, String(count + 1))
      this.store.set(`game.flow-last:${r.id}`, JSON.stringify({ at: this.runner.now(), signature }))
      // Persist before invoking: restart cannot repeat a paid audit whose result was lost.
      this.store.set(`game.flow-seen:${r.id}:${signature}`, 'started')
      this.bus.emit({ kind: 'request', text: '피카츄가 작업 대기 원인과 독립 제작 분리 가능성을 점검합니다', data: { id: r.id } })
      try {
        const result = await runJsonTurn({ codexBin: this.runner.cfg.codexBin, runtimeHome: this.runner.home,
          model: this.runner.cfg.models.sonnet, cwd: p.path, sessionId: randomUUID(), resume: false, addDirs: [], timeoutMs: 3 * 60_000,
          prompt: `너는 피카츄 작업 흐름 감독자다.\n${GAME_ECONOMY_RULES}\n${GAME_PLAYTEST_RULES}\n요청: ${r.text}\n현재는 빈 작업 슬롯이 있지만 승인된 선행 조건으로 즉시 실행할 작업이 없는 상태가 3분 이상 관측됐다. 이것만으로 오류라고 단정하지 말고 실제로 필요한 순서인지 판단한다.\n전체 작업 계약: ${JSON.stringify(rows.map(t => ({ key: t.key, status: t.status, head_sha: t.head_sha, worktree: t.worktree, spec: JSON.parse(t.spec) })))}\n분리 후보 key: ${JSON.stringify(candidates.map(t => t.key))}\n현재 호출은 이 상태에서 한 번뿐이며 요청 전체 최대 ${FLOW_MAX_TURNS}회다.\n출력: reason에 구체적인 선행 결과·충돌 파일·판단 근거를 기록한다. 독립 제작이 없으면 parent_key=null, child=null로 순서를 유지한다. 분리 가능하면 parent_key에 후보 하나, child에 새 PlanTask 전체를 반환한다. 새 child는 원래 작업의 일부 제작을 맡는다. 새 기능, 중복 시장조사, 인원 채우기용 보고서/QA를 만들지 않는다. 승인된 기존 선행 작업에서 분기하고 부모가 기존 의존과 모든 acceptance를 유지하며 child도 기다리게 된다. 현재 실행 중 작업·기존 수용 기준·검토·품질 관문은 변경할 수 없다. child는 부모와 같은 project/role/department/grade/model/review.model이어야 하며 owns는 부모 owns의 부분집합이고 나머지 병렬 작업과 겹치면 안 된다. 미통과 QA 관문 뒤의 콘텐츠 확장을 앞당기지 않는다. 새 id는 기존 key와 달라야 한다. child acceptance는 3~7개이며 독립 제작 결과만 검증하고 전체 게임 통합 판정을 대신하지 않는다. 공용 코드 수정은 부모에게 남긴다. 쓰기는 별도 작업자가 수행하며 현재는 읽기 전용 판단이다. 사용자에게 세부 구현 질문을 전달하지 않는다.`,
          schema: { type: 'object', additionalProperties: false, required: ['reason', 'parent_key', 'child'], properties: {
            reason: { type: 'string' }, parent_key: { type: ['string', 'null'] }, child: { anyOf: [{ type: 'null' }, TASK_SCHEMA] },
          } }, onLine: line => { if (line.type === 'rate_limit_event') this.runner.observe(line) } })
        if (result.limited) this.runner.limitBackoff()
        if (!result.ok && /Not logged in|authentication|unauthorized|401|refresh.token/i.test(result.error ?? '')) this.runner.requireLogin(result.error ?? 'Not logged in')
        const o = result.output as { reason?: string; parent_key?: string | null; child?: PlanTask | null } | null
        let problem: string | null = !result.ok ? result.error ?? '흐름 점검 실패' : null
        if (!problem && (!o || typeof o.reason !== 'string' || !o.reason.trim() || !((o.parent_key === null && o.child === null)
          || (typeof o.parent_key === 'string' && !!o.child && candidates.some(t => t.key === o.parent_key))))) problem = '흐름 점검 출력 계약 위반'
        if (!problem && o?.child && o.parent_key) problem = this.runner.splitPendingGameTask(r.id, o.parent_key, o.child, signature)
        this.store.set(`game.flow-seen:${r.id}:${signature}`, JSON.stringify({ at: this.runner.now(), reason: o?.reason ?? null, error: problem, parent: o?.parent_key ?? null, child: o?.child?.id ?? null }))
        this.bus.emit({ kind: 'request', text: problem ? `작업 흐름 점검: ${problem} · 기존 작업 유지` : o?.child ? '독립 제작 분리 적용 · 통합 품질 기준 유지' : `작업 순서 유지: ${o?.reason?.slice(0, 180)}`, data: { id: r.id } })
      } catch (e) {
        this.store.set(`game.flow-seen:${r.id}:${signature}`, JSON.stringify({ at: this.runner.now(), error: String(e) }))
      } finally { this.runner.ceoLock.release() }
      return
    }
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
      // A new visible hold is a new decision occurrence, including when the worker's state is still "question".
      this.store.updateTask(t.id, { note: reason.slice(0, 4000), block_count: t.block_count + 1 })
      this.store.set(`game.waiting:${t.id}`, JSON.stringify({ signature: gameWaitSignature(this.store, this.store.task(t.id)!), reason, needsUser, at: new Date().toISOString() }))
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
