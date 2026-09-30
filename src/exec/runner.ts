// Execution scheduler and state machine (docs/design/execution.md §4 §7-§12).
// Every state change is one DB transaction; intent is recorded before spawning or merging.
// Long work (claude processes, checks) runs outside the tick; the tick only observes and advances state.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Bus } from '../bus.ts'
import type { Project, PlanTask, CeoPlan } from '../ceo.ts'
import type { HqConfig } from '../config.ts'
import type { AttemptRow, Store, TaskRow } from '../store.ts'
import type { Approval, Verdict } from '../types.ts'
import { runChecks, type CheckSpec, type ChecksFile } from './checks.ts'
import { collectGitFacts, judgeWork, limitSignal, reportProblem, type WorkerQuestion } from './contract.ts'
import { atomicJson, readJson, readText, sha256 } from './fsx.ts'
import { addDetachedWorktree, changedFiles, ensureWorktree, git, isAncestor, isRepo, removeWorktree, revParse } from './git.ts'
import { MergeService } from './merge.ts'
import { resumePrompt, reviewPrompt, reworkEvidence, workPrompt } from './prompt.ts'
import { quotaFromEvent, quotaState, type QuotaState } from './quota.ts'
import { checkVerdict, ladderUp, reviewerModel, VERDICT_SCHEMA } from './review.ts'
import { killGroup, launch, readProcessInfo, reviewArgs, sameProcessAlive, StreamTail, workArgs, type ProcessInfo } from './worker.ts'
import type { ChildProcess } from 'node:child_process'

export type Notify = (title: string, body: string) => void

interface Live {
  tail: StreamTail
  info: ProcessInfo | null
  /** Set for processes spawned by this daemon; recovered ones are probed by pid + start time. */
  child: ChildProcess | null
  exited: boolean
  killAt: number | null
  killed9: boolean
}

interface TaskQuestions { sessionId: string | null; questions: WorkerQuestion[]; answers: (string | null)[] }

const KILL_GRACE_MS = 10_000
const LIMIT_HOLD_MS = 60 * 60_000
const MAX_START_FAILURES = 3
const CARD_TTL_MS = 7 * 24 * 60 * 60_000
const REVIEW_INVALID_LIMIT = 2
const TERMINAL = new Set(['merged', 'rejected', 'failed', 'cancelled'])

export const specOf = (t: TaskRow) => JSON.parse(t.spec) as PlanTask

export class Runner {
  readonly store: Store
  readonly bus: Bus
  readonly cfg: HqConfig
  readonly projects: Project[]
  readonly notify: Notify
  readonly merge: MergeService
  private live = new Map<string, Live>()
  private checking = new Set<string>()
  private activity = new Map<string, string>()
  private ticking = false
  private again = false
  private timer: NodeJS.Timeout | null = null

  constructor(o: { store: Store; bus: Bus; cfg: HqConfig; projects: Project[]; notify?: Notify }) {
    this.store = o.store; this.bus = o.bus; this.cfg = o.cfg; this.projects = o.projects; this.notify = o.notify ?? (() => {})
    this.merge = new MergeService(this)
  }

  async start(intervalMs = 2_000): Promise<void> {
    await this.recover()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  // ----- paths -----
  worktreeDir(requestId: string, key: string): string { return join(this.cfg.home, 'worktrees', requestId, key) }
  runDir(requestId: string, key: string, tag: string): string { return join(this.cfg.home, 'runs', requestId, key, tag) }
  project(id: string): Project | undefined { return this.projects.find((p) => p.id === id) }

  // ----- quota -----
  quota(): QuotaState { return quotaState(this.store.quota(), this.cfg.quota, this.store.get('limit.blockedUntil')) }
  /** CEO turns are allowed unless the quota is on hold (§10). */
  canStartCeo(): boolean { return this.quota().mode !== 'hold' }

  lastActivity(attemptId: string): string | null { return this.activity.get(attemptId) ?? null }

  emitTask(t: { id: string; request_id: string }, text: string, status?: string): void {
    this.bus.emit({ kind: 'task', text, data: { id: t.id, requestId: t.request_id, status } })
  }

  // ----- plan approval (§5) -----
  /** Creates tasks for an approved plan and moves the request to executing. Returns an error string on refusal. */
  async approvePlan(requestId: string): Promise<string | null> {
    const r = this.store.request(requestId)
    if (!r || !r.plan) return '계획 없음'
    if (this.store.tasks(requestId).length) return null
    const plan = JSON.parse(r.plan) as CeoPlan
    const heads = new Map<string, string>()
    for (const pid of new Set(plan.tasks.map((t) => t.project))) {
      const p = this.project(pid)
      if (!p) return this.failRequest(requestId, `등록되지 않은 프로젝트: ${pid}`)
      if (!(await isRepo(p.path))) return this.failRequest(requestId, `프로젝트 ${p.name}(${p.path})가 커밋이 있는 git 저장소가 아니라서 실행할 수 없어요`)
      heads.set(pid, (await revParse(p.path))!)
    }
    // verify tasks are not run on their own: their brief becomes the review brief of what they depend on.
    const briefs = new Map<string, string[]>()
    for (const v of plan.tasks.filter((t) => t.role === 'verify')) for (const d of v.depends_on) {
      const target = plan.tasks.find((t) => t.id === d)
      if (target?.role !== 'implement') continue
      briefs.set(d, [...(briefs.get(d) ?? []), `### ${v.id}: ${v.title}\n${v.brief}\n수용 기준:\n${v.acceptance.map((a) => `- [${a.id}] ${a.text} (${a.check})`).join('\n')}`])
    }
    const ok = this.store.tx(() => {
      const cur = this.store.request(requestId)
      if (!cur || !['approved', 'planned'].includes(cur.status)) return false
      for (const t of plan.tasks) {
        const model = t.model === 'none' && t.role !== 'verify' ? this.cfg.ladder[0] : t.model
        this.store.insertTask({ id: `${requestId}/${t.id}`, request_id: requestId, task_key: t.id, project: t.project, title: t.title, role: t.role,
          grade: t.grade, model, spec: JSON.stringify(t), review_brief: briefs.get(t.id)?.join('\n\n') ?? null, status: 'pending',
          branch: t.role === 'implement' ? `hq/${requestId}/${t.id}` : null, worktree: null, base_sha: heads.get(t.project)!, note: null })
      }
      this.store.updateRequest(requestId, { status: 'executing', note: null })
      return true
    })
    if (!ok) return '요청이 승인 상태가 아님'
    this.bus.emit({ kind: 'request', text: `실행 시작: 작업 ${plan.tasks.length}개`, data: { id: requestId, state: 'executing' } })
    this.kick()
    return null
  }

  failRequest(requestId: string, why: string): string {
    this.store.updateRequest(requestId, { status: 'failed', note: why })
    this.bus.emit({ kind: 'request', text: why, data: { id: requestId, state: 'failed' } })
    this.notify('요청 실행 실패', why)
    return why
  }

  // ----- tick -----
  kick(): void { void this.tick() }

  async tick(): Promise<void> {
    if (this.ticking) { this.again = true; return }
    this.ticking = true
    try {
      do {
        this.again = false
        await this.step('poll', () => this.pollLive())
        await this.step('reconcile', () => this.reconcile())
        await this.step('verify', () => this.startVerifications())
        await this.step('dispatch', () => this.dispatch())
      } while (this.again)
    } finally { this.ticking = false }
  }

  private async step(name: string, fn: () => unknown): Promise<void> {
    try { await fn() } catch (e) { console.error(`[hq runner] ${name}:`, e) }
  }

  // ----- live process supervision (§10 runaway, §13 activity) -----
  private async pollLive(): Promise<void> {
    for (const att of this.store.liveAttempts()) {
      const l = this.live.get(att.id)
      if (!l) continue // still being launched by dispatch in this tick, or handled by recover()
      const task = this.store.task(att.task_id)
      l.tail.poll((line, s) => {
        if (s.sessionId && s.sessionId !== att.session_id) { this.store.updateAttempt(att.id, { session_id: s.sessionId }); att.session_id = s.sessionId }
        if (s.rateLimit) {
          const prevMode = this.quota().mode
          const q = quotaFromEvent(line, this.store.quota())
          if (q) this.store.setQuota(q)
          const mode = this.quota().mode
          if (mode !== prevMode) this.bus.emit({ kind: 'quota', text: `사용 한도 모드: ${mode}`, data: { mode } })
        }
      })
      if (l.tail.lastActivity) this.activity.set(att.id, l.tail.lastActivity)
      const alive = l.child ? !l.exited : l.info ? await sameProcessAlive(l.info) : false
      if (alive) {
        const now = Date.now()
        const wall = (this.cfg.attemptWallMinutes[(task?.grade ?? 'L1') as keyof HqConfig['attemptWallMinutes']] ?? 45) * 60_000
        const elapsed = now - Date.parse(att.started_at ?? new Date().toISOString())
        if (!att.outcome && (elapsed > wall || l.tail.sameErrorCount >= 3)) {
          const why = elapsed > wall ? `시간 초과 (${Math.round(elapsed / 60_000)}분)` : `같은 도구 오류 3회 연속: ${l.tail.lastActivity ?? ''}`
          this.store.updateAttempt(att.id, { outcome: 'runaway', reason: why })
          att.outcome = 'runaway'
          this.bus.emit({ kind: 'attempt', text: `폭주 감시: ${why}`, data: { id: att.id } })
        }
        if (att.outcome === 'runaway' || att.outcome === 'cancelled') {
          const pid = l.info?.pid ?? att.pid
          if (pid && l.killAt === null) { killGroup(pid, 'SIGTERM'); l.killAt = now }
          else if (pid && !l.killed9 && l.killAt !== null && now - l.killAt >= KILL_GRACE_MS) { killGroup(pid, 'SIGKILL'); l.killed9 = true }
        }
        continue
      }
      l.tail.poll()
      this.live.delete(att.id)
      const fresh = this.store.attempt(att.id)!
      try {
        if (fresh.kind === 'review') await this.finalizeReview(fresh, l)
        else await this.finalizeWork(fresh, l)
      } catch (e) {
        console.error('[hq runner] finalize', e)
        this.store.tx(() => {
          this.store.updateAttempt(att.id, { status: 'unverifiable', ended_at: new Date().toISOString(), reason: `판정 중 오류: ${String(e).slice(0, 300)}` })
          const t = this.store.task(att.task_id)
          if (t && ['running', 'reviewing'].includes(t.status)) this.blockTask(t, `판정 중 오류: ${String(e).slice(0, 300)}`, fresh.kind === 'review' ? 'review' : 'work')
        })
      }
    }
  }

  private usage(result: Record<string, unknown> | null) {
    const u = (result?.usage ?? {}) as Record<string, unknown>
    return {
      cost_usd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
      input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
      output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
    }
  }

  /** Records a usage-limit stop: without a quota rejection on record, hold new starts for an hour. */
  private holdForLimit(): void {
    if (this.quota().mode === 'hold') return
    this.store.set('limit.blockedUntil', new Date(Date.now() + LIMIT_HOLD_MS).toISOString())
    this.bus.emit({ kind: 'limit', text: '사용 한도 — 새 시작을 잠시 멈춥니다' })
  }

  // ----- work attempt judgement (§6) -----
  private async finalizeWork(att: AttemptRow, l: Live): Promise<void> {
    const task = this.store.task(att.task_id)!
    const result = l.tail.finalResult()
    const endedAt = new Date().toISOString()
    const cancelled = att.outcome === 'cancelled' || task.status === 'cancelled'
    if (cancelled) {
      this.store.updateAttempt(att.id, { status: 'failed', ended_at: endedAt, reason: '요청 중단', ...this.usage(result) })
      return
    }
    const spec = specOf(task)
    const role = task.role === 'collect' ? 'collect' : 'implement'
    const stderr = (readText(join(att.dir, 'stderr.log'), 200_000) ?? '').slice(-20_000)
    const facts = {
      role, limited: limitSignal(result, stderr, l.tail.rejectedSeen), runaway: att.outcome === 'runaway',
      doneRaw: readText(join(att.dir, 'done.json'), 1_000_000), token: att.attempt_token, owns: spec.owns,
      report: readText(join(att.dir, 'report.md'), 1_000_000),
      git: role === 'implement' && task.worktree && task.base_sha ? await collectGitFacts(task.worktree, task.base_sha) : null,
    } as const
    const j = judgeWork(facts)
    const reason = j.reasons.join('\n') || null
    atomicJson(join(att.dir, 'result.json'), { outcome: j.outcome, reasons: j.reasons, summary: j.done?.summary ?? null, at: endedAt })
    this.store.tx(() => {
      this.store.updateAttempt(att.id, { status: j.outcome, ended_at: endedAt, reason: att.outcome === 'runaway' ? att.reason : reason, ...this.usage(result),
        ...(att.outcome ? {} : { outcome: j.done?.outcome ?? j.outcome }) })
      const t = this.store.task(att.task_id)!
      if (t.status !== 'running') return
      switch (j.outcome) {
        case 'limited':
          this.store.updateTask(t.id, { status: 'held', attempts: Math.max(0, t.attempts - 1), note: '사용 한도로 보류' })
          this.holdForLimit()
          break
        case 'runaway':
          this.failTask(t, `폭주로 중단: ${att.reason ?? ''}`)
          break
        case 'failed':
          this.failTask(t, reason ?? '실패')
          break
        case 'unverifiable':
          this.blockTask(t, `완료를 확인할 수 없음: ${reason}`, 'work')
          break
        case 'question': {
          const qs: TaskQuestions = { sessionId: att.session_id, questions: j.done!.questions!, answers: j.done!.questions!.map(() => null) }
          this.store.set(`taskq:${t.id}`, JSON.stringify(qs))
          this.store.updateTask(t.id, { status: 'question', attempts: Math.max(0, t.attempts - 1), note: j.done!.summary || null })
          this.notify('작업자가 질문했어요', `${t.title}: ${qs.questions[0].question}`)
          break
        }
        case 'succeeded':
          this.store.set(`reviewInvalid:${t.id}`, null)
          this.store.updateTask(t.id, { status: 'verifying', head_sha: role === 'implement' ? j.done!.head_sha : t.base_sha, note: null })
          break
      }
      this.emitTask(t, `${t.title}: 시도 판정 ${j.outcome}`, this.store.task(t.id)!.status)
    })
  }

  /** A failed attempt goes back for rework, or blocks after maxAttempts (§9). Call inside a transaction. */
  failTask(t: TaskRow, reason: string): void {
    const cur = this.store.task(t.id)!
    if (cur.attempts >= this.cfg.maxAttempts) { this.blockTask(cur, `작업 ${cur.title}이(가) ${cur.attempts}번 실패했어요: ${reason}`, 'work'); return }
    this.store.updateTask(t.id, { status: 'rework', note: reason.slice(0, 4000) })
  }

  /** Circuit break: the task needs the chairman's decision (§9). Call inside a transaction. */
  blockTask(t: TaskRow, reason: string, kind: 'work' | 'review'): void {
    this.store.updateTask(t.id, { status: 'blocked', note: reason.slice(0, 4000) })
    this.store.set(`blockKind:${t.id}`, kind)
    const r = this.store.request(t.request_id)
    if (r && r.status === 'executing') this.store.updateRequest(r.id, { status: 'blocked', note: `작업 ${t.title} 판단 필요` })
    this.emitTask(t, `작업 차단: ${t.title}`, 'blocked')
    this.notify('작업이 막혔어요 — 판단이 필요해요', `${t.title}: ${reason.slice(0, 150)}`)
  }

  // ----- mechanical verification (§7) -----
  /** Checks that apply to a task: its own non-manual acceptance checks plus those of verify tasks pointing at it. */
  checkSpecs(t: TaskRow): CheckSpec[] {
    const own = specOf(t).acceptance.filter((a) => a.check.trim() && a.check.trim() !== 'manual').map((a) => ({ id: a.id, command: a.check }))
    const extra = this.store.tasks(t.request_id).filter((v) => v.role === 'verify' && specOf(v).depends_on.includes(t.task_key))
      .flatMap((v) => specOf(v).acceptance.filter((a) => a.check.trim() && a.check.trim() !== 'manual').map((a) => ({ id: `${v.task_key}.${a.id}`, command: a.check })))
    return [...own, ...extra]
  }

  private latest(taskId: string, kind: 'work' | 'review', status?: string): AttemptRow | null {
    const all = this.store.attempts(taskId).filter((a) => a.kind === kind && (!status || a.status === status))
    return all.at(-1) ?? null
  }

  private startVerifications(): void {
    for (const t of this.store.tasksByStatus(['verifying'])) {
      if (this.checking.has(t.id)) continue
      this.checking.add(t.id)
      void this.verify(t).finally(() => { this.checking.delete(t.id); this.kick() })
    }
  }

  private async verify(t: TaskRow): Promise<void> {
    const att = this.latest(t.id, 'work', 'succeeded')
    try {
      if (!att) throw new Error('성공한 시도가 없음')
      let file: ChecksFile, why: string | null = null
      if (t.role === 'collect') {
        why = reportProblem(readText(join(att.dir, 'report.md'), 1_000_000))
        file = { checks: [], secrets: [], pass: !why }
      } else {
        if (!t.worktree || !existsSync(t.worktree) || !t.base_sha || !t.head_sha) throw new Error('worktree 또는 커밋 정보 없음')
        file = await runChecks({ cwd: t.worktree, base: t.base_sha, head: t.head_sha, checks: this.checkSpecs(t), timeoutMs: this.cfg.checkTimeoutMinutes * 60_000 })
        const failed = file.checks.filter((c) => !c.pass).map((c) => `[${c.id}] ${c.command} → ${c.exitCode ?? '시간 초과'}`)
        if (file.secrets.length) failed.push(`비밀값 패턴: ${file.secrets.map((s) => `${s.file}:${s.line}(${s.pattern})`).join(', ')}`)
        if (failed.length) why = `기계 검증 실패: ${failed.join('; ')}`
      }
      atomicJson(join(att.dir, 'checks.json'), file)
      this.store.tx(() => {
        const cur = this.store.task(t.id)
        if (!cur || cur.status !== 'verifying' || cur.head_sha !== t.head_sha) return
        if (why) this.failTask(cur, why)
        else this.store.updateTask(cur.id, { status: cur.role === 'collect' ? 'passed' : 'reviewing' })
        this.emitTask(cur, `${cur.title}: 검증 ${why ? '실패' : '통과'}`, this.store.task(cur.id)!.status)
      })
    } catch (e) {
      this.store.tx(() => {
        const cur = this.store.task(t.id)
        if (cur?.status === 'verifying') this.blockTask(cur, `검증을 실행할 수 없음: ${String(e).slice(0, 300)}`, 'work')
      })
    }
  }

  // ----- dispatch (§10) -----
  private depsPassed(t: TaskRow, all: TaskRow[]): boolean {
    return specOf(t).depends_on.every((d) => all.find((x) => x.task_key === d)?.status === 'passed')
  }

  private async dispatch(): Promise<void> {
    const q = this.quota()
    if (q.mode === 'hold') return
    let cap = q.mode === 'save' || !q.observed ? 1 : this.cfg.maxWorkers
    let live = this.store.liveAttempts().length
    if (live >= cap) return
    // Reviews first: they finish work already paid for.
    for (const t of this.store.tasksByStatus(['reviewing'])) {
      if (live >= cap) return
      const r = this.store.request(t.request_id)
      if (!r || TERMINAL.has(r.status)) continue
      if (this.store.liveAttempts().some((a) => a.task_id === t.id)) continue
      if (await this.startReview(t)) live++
      if (!q.observed) cap = 0 // wait for the first rate_limit_event before starting more
    }
    if (q.mode === 'review_only') return
    for (const r of this.store.requestsByStatus(['executing'])) {
      const all = this.store.tasks(r.id)
      for (const t of all) {
        if (live >= cap) return
        if (!['pending', 'rework', 'held'].includes(t.status) || t.role === 'verify' || !this.depsPassed(t, all)) continue
        if (await this.startWork(t, all)) live++
        if (!q.observed) cap = 0
      }
    }
  }

  /** Base commit: the request base, or the head of same-project dependencies (must form one line of history). */
  private async baseFor(t: TaskRow, all: TaskRow[]): Promise<{ base: string } | { error: string }> {
    const deps = specOf(t).depends_on.map((d) => all.find((x) => x.task_key === d)!).filter((d) => d.project === t.project && d.role === 'implement' && d.head_sha)
    if (!deps.length) return { base: t.base_sha! }
    const repo = this.project(t.project)!.path
    for (const cand of deps) {
      let ok = true
      for (const o of deps) if (o !== cand && !(await isAncestor(repo, o.head_sha!, cand.head_sha!))) { ok = false; break }
      if (ok) return { base: cand.head_sha! }
    }
    return { error: `선행 작업들(${deps.map((d) => d.task_key).join(', ')})의 결과가 한 줄의 이력이 아니라서 시작 지점을 정할 수 없음` }
  }

  private async startWork(t: TaskRow, all: TaskRow[]): Promise<boolean> {
    const project = this.project(t.project)
    const request = this.store.request(t.request_id)!
    if (!project) { this.store.tx(() => this.blockTask(t, `등록되지 않은 프로젝트: ${t.project}`, 'work')); return false }
    const spec = specOf(t)
    const resumeRaw = this.store.get(`resume:${t.id}`)
    const resume = resumeRaw ? JSON.parse(resumeRaw) as { sessionId: string; answers: { question: string; answer: string }[] } : null
    const k = t.attempts + 1
    const model = k === 3 && !resume && t.status === 'rework' ? ladderUp(this.cfg.ladder, t.model) : t.model
    const n = this.store.attempts(t.id).filter((a) => a.kind === 'work').length + 1
    const id = `${t.id}#a${n}`
    const dir = this.runDir(t.request_id, t.task_key, `a${n}`)
    const token = randomBytes(16).toString('hex')
    const sessionId = resume?.sessionId ?? randomUUID()
    const wt = this.worktreeDir(t.request_id, t.task_key)
    let base = t.base_sha!
    if (!t.worktree) {
      const b = await this.baseFor(t, all)
      if ('error' in b) { this.store.tx(() => this.blockTask(t, b.error, 'work')); return false }
      base = b.base
    }
    // Intent first: attempt row + task state, then side effects.
    this.store.tx(() => {
      this.store.insertAttempt({ id, task_id: t.id, kind: 'work', n, model, status: 'starting', attempt_token: token, dir, session_id: sessionId })
      this.store.updateTask(t.id, { status: 'running', attempts: k, model, worktree: wt, base_sha: base })
      if (resume) this.store.set(`resume:${t.id}`, null)
    })
    this.emitTask(t, `${model}가 ${t.title} 시작 (시도 ${k})`, 'running')
    try {
      if (t.role === 'collect') { if (!existsSync(wt)) await addDetachedWorktree(project.path, wt, base) }
      else await ensureWorktree(project.path, wt, t.branch!, base)
      const role = t.role === 'collect' ? 'collect' : 'implement'
      const prompt = resume
        ? resumePrompt({ answers: resume.answers, dir, token, role, base })
        : workPrompt({ task: spec, requestText: request.text, projectName: project.name, cwd: wt, branch: t.role === 'implement' ? t.branch : null, base, dir, token,
          rework: t.attempts > 0 || t.note ? this.reworkText(t) : null })
      const argv = workArgs(this.cfg, { model, sessionId, resume: !!resume, role, dir })
      const { info, child } = await launch({ claudeBin: this.cfg.claudeBin, argv, cwd: wt, dir, prompt, sessionId,
        spec: { attemptId: id, kind: 'work', model, modelArg: this.cfg.models[model as keyof HqConfig['models']] ?? model, base, branch: t.branch, startedAt: new Date().toISOString(), attempt_token: token } })
      this.track(id, dir, info, child)
      this.store.updateAttempt(id, { status: 'running', pid: info.pid, started_at: info.startedAt })
      return true
    } catch (e) {
      this.startFailed(id, t.id, 'work', String(e))
      return false
    }
  }

  private reworkText(t: TaskRow): string {
    const works = this.store.attempts(t.id).filter((a) => a.kind === 'work' && ['failed', 'succeeded', 'runaway'].includes(a.status))
    const last = works.at(-1)
    const checks = last ? readJson<ChecksFile>(join(last.dir, 'checks.json')) : null
    const reviews = this.store.attempts(t.id).filter((a) => a.kind === 'review' && a.outcome === 'blocking')
    const lastReview = reviews.at(-1)
    const verdict = lastReview && last && this.store.attempts(t.id).indexOf(this.store.attempts(t.id).find((a) => a.id === lastReview.id)!) > this.store.attempts(t.id).findIndex((a) => a.id === last.id)
      ? readJson<Verdict>(join(lastReview.dir, 'verdict.json')) : null
    return reworkEvidence({ reasons: t.note ? [t.note] : [], checks, verdict })
  }

  private track(id: string, dir: string, info: ProcessInfo, child: ChildProcess | null): void {
    const l: Live = { tail: new StreamTail(dir), info, child, exited: false, killAt: null, killed9: false }
    if (child) child.once('exit', () => { l.exited = true; this.kick() })
    this.live.set(id, l)
  }

  private startFailed(attemptId: string, taskId: string, kind: 'work' | 'review', why: string): void {
    this.store.tx(() => {
      this.store.updateAttempt(attemptId, { status: 'start_failed', ended_at: new Date().toISOString(), reason: why.slice(0, 1000) })
      const t = this.store.task(taskId)!
      const fails = this.store.attempts(taskId).filter((a) => a.kind === kind && a.status === 'start_failed').length
      if (kind === 'work' && t.status === 'running') this.store.updateTask(taskId, { status: 'pending', attempts: Math.max(0, t.attempts - 1) })
      if (fails >= MAX_START_FAILURES && ['pending', 'reviewing'].includes(this.store.task(taskId)!.status))
        this.blockTask(this.store.task(taskId)!, `${kind === 'work' ? '작업자' : '검토자'}를 ${fails}번 시작하지 못했어요: ${why.slice(0, 300)}`, kind)
    })
    this.bus.emit({ kind: 'attempt', text: `시작 실패: ${why.slice(0, 200)}`, data: { id: attemptId } })
  }

  // ----- cross review (§8) -----
  private reviewWorktree(t: TaskRow, n: number): string { return `${this.worktreeDir(t.request_id, t.task_key)}.review-a${n}` }

  private async startReview(t: TaskRow): Promise<boolean> {
    const project = this.project(t.project)!
    const request = this.store.request(t.request_id)!
    const n = this.store.attempts(t.id).filter((a) => a.kind === 'review').length + 1
    const id = `${t.id}#r${n}`
    const dir = this.runDir(t.request_id, t.task_key, `r${n}`)
    const wt = this.reviewWorktree(t, n)
    const model = reviewerModel(this.cfg.ladder, t.model)
    const sessionId = randomUUID()
    this.store.insertAttempt({ id, task_id: t.id, kind: 'review', n, model, status: 'starting', attempt_token: randomBytes(16).toString('hex'), dir, session_id: sessionId })
    this.emitTask(t, `${model}가 ${t.title} 검토 시작`, 'reviewing')
    try {
      await addDetachedWorktree(project.path, wt, t.head_sha!)
      const stat = await git(wt, ['diff', '--stat', t.base_sha!, t.head_sha!])
      const work = this.latest(t.id, 'work', 'succeeded')
      const prompt = reviewPrompt({ task: specOf(t), requestText: request.text, base: t.base_sha!, head: t.head_sha!, diffStat: stat.stdout,
        checks: work ? readJson<ChecksFile>(join(work.dir, 'checks.json')) : null, reviewBrief: t.review_brief })
      const argv = reviewArgs(this.cfg, { model, sessionId, schema: VERDICT_SCHEMA })
      const { info, child } = await launch({ claudeBin: this.cfg.claudeBin, argv, cwd: wt, dir, prompt, sessionId,
        spec: { attemptId: id, kind: 'review', model, modelArg: this.cfg.models[model as keyof HqConfig['models']] ?? model, head_sha: t.head_sha, base_sha: t.base_sha, worktree: wt, startedAt: new Date().toISOString() } })
      this.track(id, dir, info, child)
      this.store.updateAttempt(id, { status: 'running', pid: info.pid, started_at: info.startedAt })
      return true
    } catch (e) {
      await removeWorktree(project.path, wt).catch(() => {})
      this.startFailed(id, t.id, 'review', String(e))
      return false
    }
  }

  private async finalizeReview(att: AttemptRow, l: Live): Promise<void> {
    const task = this.store.task(att.task_id)!
    const project = this.project(task.project)
    const result = l.tail.finalResult()
    const endedAt = new Date().toISOString()
    if (project) await removeWorktree(project.path, this.reviewWorktree(task, att.n)).catch(() => {})
    if (att.outcome === 'cancelled' || task.status === 'cancelled') {
      this.store.updateAttempt(att.id, { status: 'failed', ended_at: endedAt, reason: '요청 중단', ...this.usage(result) })
      return
    }
    const stderr = (readText(join(att.dir, 'stderr.log'), 200_000) ?? '').slice(-20_000)
    if (att.outcome !== 'runaway' && limitSignal(result, stderr, l.tail.rejectedSeen)) {
      this.store.tx(() => { this.store.updateAttempt(att.id, { status: 'limited', ended_at: endedAt, reason: '사용 한도', ...this.usage(result) }); this.holdForLimit() })
      return
    }
    const codeChanged = task.base_sha && task.head_sha && project ? (await changedFiles(project.path, task.base_sha, task.head_sha).catch(() => ['?'])).length > 0 : true
    const check = att.outcome === 'runaway' ? { kind: 'invalid' as const, reason: `검토 폭주: ${att.reason ?? ''}`, verdict: null }
      : result?.is_error ? { kind: 'invalid' as const, reason: `검토 실행 오류: ${String(result.result ?? '').slice(0, 300)}`, verdict: null }
      : checkVerdict(result?.structured_output, codeChanged)
    const binding = { task: task.id, head_sha: task.head_sha ?? undefined, base_sha: task.base_sha ?? undefined, reviewer_model: att.model, implementer_model: task.model, sameFamily: true }
    atomicJson(join(att.dir, 'verdict.json'), check.verdict ? { ...check.verdict, ...binding } : { invalid: check.kind === 'invalid' ? check.reason : null, raw: result?.structured_output ?? null, ...binding })
    this.store.tx(() => {
      const status = check.kind === 'pass' ? 'succeeded' : check.kind === 'blocking' ? 'failed' : 'unverifiable'
      this.store.updateAttempt(att.id, { status, ended_at: endedAt, outcome: check.kind, reason: check.kind === 'invalid' ? check.reason : check.kind === 'blocking' ? check.verdict.blocking.map((b) => b.summary).join('; ').slice(0, 2000) : null, ...this.usage(result) })
      const t = this.store.task(att.task_id)!
      if (t.status !== 'reviewing' || t.head_sha !== task.head_sha) return
      if (check.kind === 'pass') this.store.updateTask(t.id, { status: 'passed', note: null })
      else if (check.kind === 'blocking') this.failTask(t, `검토 blocking: ${check.verdict.blocking.map((b) => `[${b.id}] ${b.summary}`).join('; ')}`)
      else {
        const cnt = Number(this.store.get(`reviewInvalid:${t.id}`) ?? 0) + 1
        this.store.set(`reviewInvalid:${t.id}`, String(cnt))
        if (cnt >= REVIEW_INVALID_LIMIT) this.blockTask(t, `검토가 ${cnt}번 무효: ${check.reason}`, 'review')
        else this.store.updateTask(t.id, { note: `검토 무효, 재검토: ${check.reason}` })
      }
      this.emitTask(t, `${t.title}: 검토 ${check.kind}`, this.store.task(t.id)!.status)
    })
  }

  // ----- request-level progress (§9 §11) -----
  private async reconcile(): Promise<void> {
    for (const r of this.store.requestsByStatus(['executing', 'blocked'])) {
      this.store.tx(() => {
        const all = this.store.tasks(r.id)
        for (const v of all) if (v.role === 'verify' && v.status === 'pending' && this.depsPassed(v, all)) {
          this.store.updateTask(v.id, { status: 'passed', note: '교차 검토에 합쳐짐' })
          v.status = 'passed'
        }
        const cur = this.store.request(r.id)!
        if (cur.status !== 'executing') return
        const active = all.filter((t) => t.status !== 'cancelled')
        if (!active.length) { this.store.updateRequest(r.id, { status: 'cancelled', note: '모든 작업이 취소됨' }); return }
        if (active.every((t) => t.status === 'passed')) {
          this.store.updateRequest(r.id, { status: 'awaiting_acceptance', note: null })
          this.putAcceptCard(r.id)
          this.bus.emit({ kind: 'request', text: '모든 작업 통과 — 결과 수락을 기다려요', data: { id: r.id, state: 'awaiting_acceptance' } })
          this.notify('결과 수락을 기다려요', cur.text.slice(0, 100))
        }
      })
    }
    for (const r of this.store.requestsByStatus(['awaiting_acceptance'])) {
      const a = this.store.approval(`accept:${r.id}`)
      if (!a || (a.decision === null && Date.parse(a.expiresAt) <= Date.now())) this.store.tx(() => this.putAcceptCard(r.id))
    }
    for (const r of this.store.requestsByStatus(['accepted'])) await this.merge.ensureCards(r.id)
    for (const r of this.store.requestsByStatus(['cancelled'])) await this.cleanupCancelled(r.id)
  }

  acceptHash(requestId: string): string {
    return sha256(this.store.tasks(requestId).filter((t) => t.status === 'passed' && t.role !== 'verify').map((t) => `${t.id}:${t.head_sha}`).join('\n'))
  }

  /** Call inside a transaction. */
  private putAcceptCard(requestId: string): void {
    const r = this.store.request(requestId)!
    const lines = this.store.tasks(requestId).filter((t) => t.status === 'passed' && t.role !== 'verify').map((t) => {
      const work = this.latest(t.id, 'work', 'succeeded')
      const done = work ? readJson<{ summary?: string; files_modified?: string[] }>(join(work.dir, 'done.json')) : null
      const checks = work ? readJson<ChecksFile>(join(work.dir, 'checks.json')) : null
      const review = this.store.attempts(t.id).filter((a) => a.kind === 'review' && a.outcome === 'pass').at(-1)
      const verdict = review ? readJson<Verdict>(join(review.dir, 'verdict.json')) : null
      const parts = [`변경 파일 ${done?.files_modified?.length ?? 0}개`,
        checks ? `검사 ${checks.checks.filter((c) => c.pass).length}/${checks.checks.length} 통과` : '검사 없음',
        t.role === 'collect' ? '수집(검토 없음)' : verdict ? `검토 통과(${review!.model}${verdict.advisory.length ? `, 참고 ${verdict.advisory.length}건` : ''})` : '검토 없음']
      return `${t.task_key} [${t.model}] ${t.title} — ${done?.summary ?? ''}\n  ${parts.join(' · ')}`
    })
    this.store.putApproval({ id: `accept:${requestId}`, teamId: 'hq', title: `결과 수락: ${r.text.replace(/\s+/g, ' ').slice(0, 60)}`, body: lines.join('\n'),
      options: ['수락', '반려'], subjectHash: this.acceptHash(requestId), expiresAt: new Date(Date.now() + CARD_TTL_MS).toISOString(), createdAt: new Date().toISOString() })
  }

  private async cleanupCancelled(requestId: string): Promise<void> {
    if (this.store.get(`cleaned:${requestId}`)) return
    const tasks = this.store.tasks(requestId)
    if (this.store.liveAttempts().some((a) => tasks.some((t) => t.id === a.task_id))) return
    for (const t of tasks) if (t.worktree) { const p = this.project(t.project); if (p) await removeWorktree(p.path, t.worktree).catch(() => {}) }
    this.store.set(`cleaned:${requestId}`, new Date().toISOString())
  }

  // ----- chairman actions -----
  /** plan:/accept:/merge: cards after the store recorded the decision. */
  async onDecision(a: Approval): Promise<void> {
    if (a.id.startsWith('accept:')) {
      const id = a.id.slice(7)
      if (a.decision === '수락') {
        const ok = this.store.tx(() => {
          const r = this.store.request(id)
          if (r?.status !== 'awaiting_acceptance') return false
          this.store.updateRequest(id, { status: 'accepted', note: null })
          return true
        })
        if (ok) this.bus.emit({ kind: 'request', text: '결과 수락 — 병합 승인을 준비해요', data: { id, state: 'accepted' } })
        this.kick()
      } else this.reject(id, '(사유 없음)', true)
    } else if (a.id.startsWith('merge:')) {
      const [, reqId, project] = a.id.split(':')
      await this.merge.decided(reqId, project, a.decision!)
    }
  }

  /** Result rejection: every task goes back for rework with the reason attached (§11). */
  reject(requestId: string, reason: string, cardDecided = false): boolean {
    const ok = this.store.tx(() => {
      const r = this.store.request(requestId)
      if (r?.status !== 'awaiting_acceptance') return false
      if (!cardDecided) this.store.closeApproval(`accept:${requestId}`, '반려')
      this.store.updateRequest(requestId, { status: 'executing', note: `결과 반려: ${reason}` })
      for (const t of this.store.tasks(requestId)) {
        if (t.status !== 'passed') continue
        if (t.role === 'verify') this.store.updateTask(t.id, { status: 'pending', note: null })
        else this.failTask(t, `결과 반려: ${reason}`)
      }
      return true
    })
    if (ok) { this.bus.emit({ kind: 'request', text: `결과 반려: ${reason}`, data: { id: requestId, state: 'executing' } }); this.kick() }
    return ok
  }

  /** Stops a request: running attempts get SIGTERM (then SIGKILL), open cards close, worktrees are removed (branches kept). */
  cancel(requestId: string): boolean {
    const ok = this.store.tx(() => {
      const r = this.store.request(requestId)
      if (!r || TERMINAL.has(r.status) || r.status === 'merging') return false
      this.store.updateRequest(requestId, { status: 'cancelled', note: '회장이 중단' })
      const tasks = this.store.tasks(requestId)
      for (const t of tasks) if (t.status !== 'passed' && t.status !== 'cancelled') this.store.updateTask(t.id, { status: 'cancelled' })
      for (const a of this.store.liveAttempts()) if (tasks.some((t) => t.id === a.task_id)) this.store.updateAttempt(a.id, { outcome: 'cancelled', reason: '요청 중단' })
      for (const a of this.store.openApprovals()) if (a.id === `plan:${requestId}` || a.id === `accept:${requestId}` || a.id.startsWith(`merge:${requestId}:`)) this.store.closeApproval(a.id, '취소')
      return true
    })
    if (!ok) return false
    for (const a of this.store.liveAttempts()) {
      const l = this.live.get(a.id)
      if (a.outcome === 'cancelled' && l && a.pid) { killGroup(a.pid, 'SIGTERM'); l.killAt = Date.now() }
    }
    this.bus.emit({ kind: 'request', text: '요청 중단', data: { id: requestId, state: 'cancelled' } })
    this.kick()
    return true
  }

  /** Circuit-break decision (§9): retry once more on the top model, skip the task (and its dependents), or stop. */
  decideTask(taskId: string, decision: string): string | null {
    const t = this.store.task(taskId)
    if (!t || t.status !== 'blocked') return '차단된 작업이 아님'
    if (decision === 'stop') return this.cancel(t.request_id) ? null : '요청을 중단할 수 없음'
    if (decision !== 'retry' && decision !== 'skip') return 'decision은 retry | skip | stop'
    this.store.tx(() => {
      if (decision === 'retry') {
        if (this.store.get(`blockKind:${t.id}`) === 'review' && t.head_sha) {
          this.store.set(`reviewInvalid:${t.id}`, null)
          this.store.updateTask(t.id, { status: 'reviewing', note: '회장: 재검토' })
        } else {
          this.store.updateTask(t.id, { status: 'rework', attempts: this.cfg.maxAttempts - 1, model: this.cfg.ladder[this.cfg.ladder.length - 1], note: `회장: 한 번 더 (최상위 모델)\n이전 사유: ${t.note ?? ''}` })
        }
      } else {
        const all = this.store.tasks(t.request_id)
        const gone = new Set([t.task_key])
        for (let changed = true; changed;) {
          changed = false
          for (const x of all) if (!gone.has(x.task_key) && specOf(x).depends_on.some((d) => gone.has(d))) { gone.add(x.task_key); changed = true }
        }
        for (const x of all) if (gone.has(x.task_key) && x.status !== 'passed') this.store.updateTask(x.id, { status: 'cancelled', note: x.id === t.id ? '회장: 이 작업 취소' : `선행 작업 ${t.task_key} 취소` })
      }
      this.store.set(`blockKind:${t.id}`, null)
      const r = this.store.request(t.request_id)!
      if (r.status === 'blocked' && !this.store.tasks(r.id).some((x) => x.status === 'blocked')) this.store.updateRequest(r.id, { status: 'executing', note: null })
    })
    this.emitTask(t, `회장 결정: ${t.title} → ${decision}`)
    this.kick()
    return null
  }

  taskQuestions(taskId: string): TaskQuestions | null {
    const raw = this.store.get(`taskq:${taskId}`)
    return raw ? JSON.parse(raw) as TaskQuestions : null
  }

  /** Worker question answer; when every question has an answer the same session resumes (§14). */
  answerTask(taskId: string, index: number, answer: string): string | null {
    const res = this.store.tx(() => {
      const t = this.store.task(taskId)
      const q = this.taskQuestions(taskId)
      if (!t || t.status !== 'question' || !q) return '질문 대기 중인 작업이 아님'
      if (!Number.isInteger(index) || index < 0 || index >= q.questions.length) return 'questionIndex 범위 밖'
      q.answers[index] = answer
      this.store.set(`taskq:${taskId}`, JSON.stringify(q))
      if (q.answers.every((a) => a !== null)) {
        const answers = q.questions.map((x, i) => ({ question: x.question, answer: q.answers[i]! }))
        if (q.sessionId) this.store.set(`resume:${taskId}`, JSON.stringify({ sessionId: q.sessionId, answers }))
        else this.store.updateTask(taskId, { note: `회장 답변: ${answers.map((a) => `${a.question} → ${a.answer}`).join('; ')}` })
        this.store.set(`taskq:${taskId}`, null)
        this.store.updateTask(taskId, { status: 'pending' })
      }
      return null
    })
    if (!res) { this.bus.emit({ kind: 'task', text: `작업자 질문 답변: ${answer.slice(0, 60)}`, data: { id: taskId } }); this.kick() }
    return res
  }

  // ----- restart recovery (§12) -----
  async recover(): Promise<void> {
    for (const att of this.store.liveAttempts()) {
      const info = readProcessInfo(att.dir)
      if (!info) {
        this.store.tx(() => {
          this.store.updateAttempt(att.id, { status: 'start_failed', ended_at: new Date().toISOString(), reason: 'process.json 없음 (재시작 복구)' })
          const t = this.store.task(att.task_id)
          if (att.kind === 'work' && t?.status === 'running') this.store.updateTask(t.id, { status: 'pending', attempts: Math.max(0, t.attempts - 1) })
        })
        const t = this.store.task(att.task_id)
        if (att.kind === 'review' && t) { const p = this.project(t.project); if (p) await removeWorktree(p.path, this.reviewWorktree(t, att.n)).catch(() => {}) }
        continue
      }
      const alive = await sameProcessAlive(info)
      if (att.status === 'starting') this.store.updateAttempt(att.id, { status: 'running', pid: info.pid, started_at: info.startedAt })
      const l: Live = { tail: new StreamTail(att.dir), info, child: null, exited: !alive, killAt: null, killed9: false }
      this.live.set(att.id, l)
    }
    await this.merge.recover()
  }

  /** For tests and shutdown: live attempt ids this runner is following. */
  liveIds(): string[] { return [...this.live.keys()] }
}
