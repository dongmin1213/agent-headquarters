// Execution scheduler and state machine (execution.md §5-§13, exec-engine-spec.md §C §D).
// The runner is the only writer of task/attempt state. Every transition is one DB transaction and
// intent is recorded before side effects (spawn, git writes, kill). Long work runs in background jobs;
// the 2-second tick only observes and advances state.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Bus } from '../bus.ts'
import { reviewModelOf, validateTasks, type CeoPlan, type PlanTask, type Project } from '../ceo.ts'
import type { HqConfig } from '../config.ts'
import type { ApprovalRow, AttemptRow, RequestRow, Store, TaskRow } from '../store.ts'
import type { DecisionItem, Headline, QuotaView, Verdict, WorkerView } from '../types.ts'
import { baseline, checksProfile, runChecks, runSandboxed, type CheckSpec, type ChecksFile } from './checks.ts'
import { collectGitFacts, DONE_MAX, isLimited, judgeWork, readOut, REPORT_MAX, type WorkOutcome } from './contract.ts'
import { buildHeadline, decisionItems, hqDirOf, outDirOf, workerViews } from './decisions.ts'
import { atomicJson, atomicWrite, readJson, readText, sha256 } from './fsx.ts'
import { addDetachedWorktree, branchExists, changedFiles, currentBranch, ensureWorktree, git, gitCommonDir, gitOk, isRepo, mergeHeads,
  removeWorktree, resetClean, revParse, statusPorcelain, withRepo, worktreeDirtySnapshot } from './git.ts'
import { integrate, integrationRef } from './integration.ts'
import { applyMerge } from './merge.ts'
import { resumePrompt, reviewPrompt, reworkEvidence, workPrompt, type Upstream } from './prompt.ts'
import { quotaState, quotaView, recordRateLimit, type QuotaState } from './quota.ts'
import { canAutoApply, reviseDiff, runReviseTurn } from './revise.ts'
import { checkVerdict, ladderUp, VERDICT_SCHEMA } from './review.ts'
import { real, sandboxProfile, type SandboxOpts } from './sandbox.ts'
import { extractBashRuns, lastActivityOf, StreamTail } from './stream.ts'
import { claudeArgs, findOrphan, killGroup, launch, psLstart, sameProcessAlive, terminateGroup } from './worker.ts'
import { reconcile as reconcileInvariants, recover as recoverState, type Violation } from './reconcile.ts'

export type Notify = (title: string, body: string) => void

/** Serializes CEO turns (plan turns in the engine, revise turns here). */
export class TurnLock {
  private held = false
  tryAcquire(): boolean { if (this.held) return false; this.held = true; return true }
  release(): void { this.held = false }
  get busy(): boolean { return this.held }
}

export interface RunnerDeps {
  store: Store; bus: Bus; cfg: HqConfig; projects: Project[]; hqRoot: string; hqPort: number; notify: Notify; now: () => number
  /** Folder of the daemon token, denied inside the sandbox (default ~/.config/hq). */
  tokenDir?: string
  /** Shared with the engine so CEO turns never overlap. */
  ceoLock?: TurnLock
}

export interface Live {
  tail: StreamTail
  pid: number
  lstart: string | null
  startedAt: string | null
  /** Set for processes spawned by this daemon; recovered ones are probed by pid + start time. */
  child: ChildProcess | null
  exited: boolean
  killAt: number | null
  killed9: boolean
}

const KILL_GRACE_MS = 10_000
const MAX_START_FAILURES = 3
const MAX_QUESTION_ROUNDS = 3
const MAX_REVISE_TURNS = 2
const MAX_LIMITED_STREAK = 3
const PLAN_TTL_MS = 7 * 24 * 60 * 60_000
const RECONCILE_MS = 60_000
const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000
export const TERMINAL_REQUEST = new Set(['merged', 'rejected', 'failed', 'cancelled', 'expired'])
const UNCOUNTED_PREV = new Set(['limited', 'transient', 'start_failed', 'brief_blocked'])

export const specOf = (t: TaskRow) => JSON.parse(t.spec) as PlanTask
export const nonManual = (t: PlanTask) => t.acceptance.filter((a) => a.check.trim() && a.check.trim() !== 'manual')

export class Runner {
  readonly store: Store
  readonly bus: Bus
  readonly cfg: HqConfig
  readonly projects: Project[]
  readonly hqRoot: string
  readonly hqPort: number
  readonly notify: Notify
  readonly now: () => number
  readonly home: string
  readonly tokenDir: string
  readonly ceoLock: TurnLock
  readonly live = new Map<string, Live>()
  readonly launching = new Set<string>()
  readonly checking = new Set<string>()
  private integrating = new Set<string>()
  private revising = new Set<string>()
  private gitDirs = new Map<string, string | null>()
  private ticking = false
  private again = false
  private timer: NodeJS.Timeout | null = null
  private lastReconcile = 0
  lastViolations: Violation[] = []

  constructor(d: RunnerDeps) {
    this.store = d.store; this.bus = d.bus; this.cfg = d.cfg; this.projects = d.projects; this.hqRoot = d.hqRoot; this.hqPort = d.hqPort
    this.notify = d.notify; this.now = d.now; this.ceoLock = d.ceoLock ?? new TurnLock()
    mkdirSync(d.cfg.home, { recursive: true })
    this.home = real(d.cfg.home)
    this.tokenDir = d.tokenDir ?? join(homedir(), '.config/hq')
    this.lastReconcile = this.now()
  }

  /** Call recover() first (main.ts start order: recover → runner → engine → server). */
  start(intervalMs = 2_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  /** Stops ticking only; worker processes keep running and are re-adopted on the next start (§F). */
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  recover(): Promise<void> { return recoverState(this) }

  // ----- paths & helpers -----
  worktreeDir(requestId: string, key: string): string { return join(this.home, 'worktrees', requestId, key) }
  integrationDir(requestId: string, project: string): string { return join(this.home, 'worktrees', requestId, `_integration-${project}`) }
  runDir(requestId: string, key: string, attemptId: string): string { return join(this.home, 'runs', requestId, key, attemptId) }
  project(id: string): Project | undefined { return this.projects.find((p) => p.id === id) }
  iso(): string { return new Date(this.now()).toISOString() }

  async sandboxFor(worktree: string, out: string | null, repo: string | null): Promise<SandboxOpts> {
    let gitDir: string | null = null
    if (repo) {
      if (!this.gitDirs.has(repo)) this.gitDirs.set(repo, await gitCommonDir(repo))
      gitDir = this.gitDirs.get(repo) ?? null
    }
    return { worktree, out, repoGitDir: gitDir, hqHome: this.home, tokenDir: this.tokenDir, hqPort: this.hqPort, extraWritable: this.cfg.sandbox.extraWritable, claudeDir: join(homedir(), '.claude') }
  }

  quota(): QuotaState { return quotaState(this.store.quotaRows(), this.cfg.quota, this.now()) }
  quotaView(): QuotaView | null { return quotaView(this.store.quotaRows(), this.quota(), this.now()) }
  /** CEO turns and teams may start unless the quota is on hold (§13). */
  canStartCeo(): boolean { return this.quota().mode !== 'hold' }
  holdUntil(): string | null { const q = this.quota(); return q.mode === 'hold' ? q.until : null }

  observe(line: Record<string, unknown>): void {
    const before = this.quota().mode
    if (recordRateLimit(this.store, line, this.now())) {
      const after = this.quota().mode
      if (after !== before) this.bus.emit({ kind: 'quota', text: `사용 한도 모드: ${after}`, data: { mode: after } })
    }
  }

  emitTask(t: { id: string; request_id: string }, text: string): void {
    this.bus.emit({ kind: 'task', text, data: { id: t.id, requestId: t.request_id, status: this.store.task(t.id)?.status } })
  }

  emitRequest(id: string, text: string): void {
    this.bus.emit({ kind: 'request', text, data: { id, state: this.store.request(id)?.status } })
  }

  // ----- plan approval (§D createTasks) -----
  /** Creates task rows for an approved plan and moves the request to executing. Returns a Korean reason on refusal. */
  async createTasks(requestId: string): Promise<string | null> {
    const r = this.store.request(requestId)
    if (!r || !r.plan) return '계획이 없는 요청입니다'
    if (this.store.tasks(requestId).length) return null
    const plan = JSON.parse(r.plan) as CeoPlan
    const problem = validateTasks(plan.tasks, this.projects)
    if (problem) return this.failRequest(requestId, `계획 검증 실패: ${problem}`)
    const heads = new Map<string, string>()
    for (const pid of new Set(plan.tasks.map((t) => t.project))) {
      const p = this.project(pid)!
      if (!(await isRepo(p.path))) return this.failRequest(requestId, `프로젝트 ${p.name}(${p.path})가 커밋이 있는 git 저장소가 아니라서 실행할 수 없어요`)
      heads.set(pid, (await revParse(p.path))!)
    }
    const ok = this.store.tx(() => {
      const cur = this.store.request(requestId)
      if (!cur || !['planned', 'approved'].includes(cur.status)) return false
      for (const t of plan.tasks) this.store.insertTask({ id: `${requestId}.${t.id}`, request_id: requestId, key: t.id, project: t.project, title: t.title,
        role: t.role, grade: t.grade, model: t.model, review_model: reviewModelOf(t), spec: JSON.stringify(t), status: 'pending',
        branch: t.role === 'implement' ? `hq/${requestId}/${t.id}` : null, base_sha: heads.get(t.project)! })
      this.store.updateRequest(requestId, { status: 'executing', note: null })
      return true
    })
    if (!ok) return '요청이 계획 승인 상태가 아닙니다'
    this.emitRequest(requestId, `실행 시작: 작업 ${plan.tasks.length}개`)
    this.kick()
    return null
  }

  failRequest(requestId: string, why: string): string {
    this.store.updateRequest(requestId, { status: 'failed', note: why })
    this.emitRequest(requestId, why)
    this.notify('요청 실행 실패', why)
    return why
  }

  // ----- tick (§C order) -----
  kick(): void { void this.tick() }

  async tick(): Promise<void> {
    if (this.ticking) { this.again = true; return }
    this.ticking = true
    try {
      do {
        this.again = false
        await this.step('live', () => this.pollLive())
        await this.step('verify', () => this.startVerifications())
        await this.step('integrate', () => this.startIntegrations())
        await this.step('dispatch', () => this.dispatch())
        await this.step('complete', () => this.completeRequests())
        await this.step('revise', () => this.reviseOne())
        await this.step('notify', () => this.notifyDecisions())
        if (this.now() - this.lastReconcile >= RECONCILE_MS) { this.lastReconcile = this.now(); await this.step('reconcile', () => this.reconcile()) }
      } while (this.again)
    } finally { this.ticking = false }
  }

  private async step(name: string, fn: () => unknown): Promise<void> {
    try { await fn() } catch (e) { console.error(`[hq runner] ${name}:`, e) }
  }

  async reconcile(): Promise<Violation[]> {
    this.lastViolations = reconcileInvariants(this)
    this.cleanupOldLogs()
    return this.lastViolations
  }

  // ----- live process supervision (§7 §13) -----
  track(att: AttemptRow, pid: number, lstart: string | null, startedAt: string | null, child: ChildProcess | null, exited = false): Live {
    const l: Live = { tail: new StreamTail(hqDirOf(att)), pid, lstart, startedAt, child, exited, killAt: null, killed9: false }
    if (child) child.once('exit', () => { l.exited = true; this.kick() })
    this.live.set(att.id, l)
    return l
  }

  private async pollLive(): Promise<void> {
    for (const att of this.store.liveAttempts()) {
      if (this.launching.has(att.id)) continue
      const l = this.live.get(att.id)
      if (!l) continue // not adopted (reconcile reports it)
      const task = this.store.task(att.task_id)
      l.tail.poll((line, s) => {
        if (s.sessionId && s.sessionId !== att.session_id && att.kind === 'work') { this.store.updateAttempt(att.id, { session_id: s.sessionId }); att.session_id = s.sessionId }
        if (s.rateLimit) this.observe(line)
      })
      const alive = l.child ? !l.exited : await sameProcessAlive(l.pid, l.lstart, l.startedAt)
      if (alive) {
        const now = this.now()
        const wall = (this.cfg.attemptWallMinutes[(task?.grade ?? 'L1') as keyof HqConfig['attemptWallMinutes']] ?? 45) * 60_000
        const elapsed = now - Date.parse(att.started_at ?? new Date(now).toISOString())
        if (!att.outcome && (elapsed > wall || l.tail.sameErrorCount >= 3)) {
          const why = elapsed > wall ? `시간 초과 (${Math.round(elapsed / 60_000)}분 > ${wall / 60_000}분)` : `같은 도구 오류 3회 연속: ${l.tail.lastActivity ?? ''}`
          this.store.updateAttempt(att.id, { outcome: 'runaway', reason: why })
          att.outcome = 'runaway'
          this.bus.emit({ kind: 'attempt', text: `폭주 감시: ${why}`, data: { id: att.id } })
        }
        if (att.outcome === 'runaway' || att.outcome === 'cancelled' || att.outcome === 'superseded') {
          if (l.killAt === null) { killGroup(l.pid, 'SIGTERM'); l.killAt = Date.now() }
          else if (!l.killed9 && Date.now() - l.killAt >= KILL_GRACE_MS) { killGroup(l.pid, 'SIGKILL'); l.killed9 = true }
        }
        continue
      }
      l.tail.poll((line, s) => { if (s.rateLimit) this.observe(line) })
      this.live.delete(att.id)
      terminateGroup(l.pid, KILL_GRACE_MS) // background processes the worker left behind (§7.4)
      const fresh = this.store.attempt(att.id)!
      try {
        if (fresh.kind === 'review') await this.finalizeReview(fresh, l)
        else await this.finalizeWork(fresh, l)
      } catch (e) {
        console.error('[hq runner] finalize', e)
        this.store.tx(() => {
          this.store.updateAttempt(att.id, { status: 'unverifiable', ended_at: this.iso(), reason: `판정 중 오류: ${String(e).slice(0, 300)}` })
          const t = this.store.task(att.task_id)
          if (t && ['running', 'reviewing'].includes(t.status)) this.block(t, `판정 중 오류: ${String(e).slice(0, 300)}`)
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

  private requestStopped(t: TaskRow): boolean {
    const r = this.store.request(t.request_id)
    return !r || r.status === 'cancelled' || t.status === 'cancelled'
  }

  // ----- work attempt judgement (§8, §C table) -----
  async finalizeWork(att: AttemptRow, l: Live): Promise<void> {
    const task = this.store.task(att.task_id)!
    const result = l.tail.finalResult()
    const endedAt = this.iso()
    if (['cancelled', 'superseded'].includes(att.outcome ?? '') || this.requestStopped(task)) {
      this.store.updateAttempt(att.id, { status: 'failed', ended_at: endedAt, reason: att.outcome === 'superseded' ? '선행 작업 변경으로 폐기' : '요청 중단', ...this.usage(result) })
      return
    }
    const spec = specOf(task)
    const role = task.role === 'collect' ? 'collect' : 'implement'
    const out = outDirOf(att), hq = hqDirOf(att)
    const report = readOut(out, 'report.md', REPORT_MAX)
    const j = judgeWork({
      role, token: att.attempt_token, owns: spec.owns, protectedPaths: this.cfg.protectedPaths, base: task.base_sha ?? '',
      runaway: att.outcome === 'runaway', result, stderr: (readText(join(hq, 'stderr.log'), 200_000) ?? '').slice(-20_000), rejectedSeen: l.tail.rejectedSeen,
      doneRaw: readOut(out, 'done.json', DONE_MAX), report,
      git: task.worktree && task.base_sha ? await collectGitFacts(task.worktree, task.base_sha) : null,
    })
    const reason = j.reasons.join('\n') || null
    atomicJson(join(hq, 'result.json'), { outcome: j.outcome, reasons: j.reasons, summary: j.done?.summary ?? null, protectedChanges: j.protectedChanges, at: endedAt })
    if (j.outcome === 'succeeded' && role === 'collect' && report !== null) atomicWrite(join(hq, 'report.sealed.md'), report)
    const status: WorkOutcome = j.outcome
    this.store.tx(() => {
      this.store.updateAttempt(att.id, { status, ended_at: endedAt, reason: att.outcome === 'runaway' ? att.reason : reason, ...this.usage(result),
        ...(att.outcome ? {} : { outcome: j.done?.outcome ?? j.outcome }) })
      const t = this.store.task(att.task_id)!
      if (t.status !== 'running') return
      switch (j.outcome) {
        case 'succeeded':
          if (role === 'collect') this.store.updateTask(t.id, { status: 'passed', head_sha: t.base_sha, report_sha: report === null ? null : sha256(report), limited_streak: 0, note: null })
          else this.store.updateTask(t.id, { status: 'verifying', head_sha: j.done!.head_sha, report_sha: report === null ? null : sha256(report), limited_streak: 0, review_invalid: 0, checks_state: null, note: null })
          break
        case 'brief_blocked':
          if (t.revise_turns >= MAX_REVISE_TURNS) this.block(t, `지시서를 ${t.revise_turns}번 고쳤는데도 작업자가 멈췄어요: ${reason}`)
          else this.store.updateTask(t.id, { status: 'revising', note: reason })
          break
        case 'question': {
          const rounds = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'question').length
          if (rounds > MAX_QUESTION_ROUNDS) { this.block(t, `작업자 질문이 ${MAX_QUESTION_ROUNDS}라운드를 넘었어요`); break }
          this.store.addTaskQuestions(t.id, att.id, t.revision, j.done!.questions.map((q) => ({ id: 'tq-' + randomUUID().slice(0, 8), ...q })))
          this.store.updateTask(t.id, { status: 'question', resume_session: att.session_id, note: j.done!.summary || null })
          break
        }
        case 'limited': {
          const streak = t.limited_streak + 1
          if (streak >= MAX_LIMITED_STREAK) { this.store.updateTask(t.id, { limited_streak: streak }); this.block(t, `사용 한도로 ${streak}번 연속 중단됐어요`) }
          else this.store.updateTask(t.id, { status: 'held', limited_streak: streak, resume_session: att.session_id, note: '사용 한도로 보류' })
          break
        }
        case 'transient': {
          const prev = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.id !== att.id).at(-1)
          if (prev?.status === 'transient') this.rework(t, `일시 오류가 2번 연속: ${reason}`)
          else this.store.updateTask(t.id, { status: 'pending', note: reason })
          break
        }
        case 'unverifiable':
          this.block(t, `완료를 확인할 수 없어요: ${reason}`)
          break
        default: // failed, runaway
          this.rework(t, j.outcome === 'runaway' ? `폭주로 중단: ${att.reason ?? ''}` : reason ?? '실패')
      }
      this.emitTask(t, `${t.title}: 시도 판정 ${j.outcome}`)
    })
  }

  /** §C rework(): back for another attempt, or blocked after maxAttempts. Invalidates dependents if it had passed. Call inside a tx. */
  rework(t: TaskRow, reason: string): void {
    const cur = this.store.task(t.id)!
    const wasPassed = cur.status === 'passed'
    if (cur.attempts >= this.cfg.maxAttempts) this.block(cur, `${cur.attempts}번 실패했어요: ${reason}`)
    else this.store.updateTask(cur.id, { status: 'rework', note: reason.slice(0, 2000), model: cur.attempts + 1 >= 3 ? ladderUp(this.cfg.ladder, cur.model) : cur.model })
    if (wasPassed) this.invalidateDependents(cur)
  }

  /** Circuit break: the chairman decides (§9). Call inside a tx. */
  block(t: TaskRow, reason: string): void {
    this.store.updateTask(t.id, { status: 'blocked', note: reason.slice(0, 2000) })
    const r = this.store.request(t.request_id)
    if (r && r.status === 'executing') this.store.updateRequest(r.id, { status: 'blocked', note: `작업 ${t.title} 판단 필요` })
    this.emitTask(t, `작업 차단: ${t.title}`)
  }

  /** §11: every transitive dependent starts over from a fresh worktree; old branches are archived as -v<n>. Call inside a tx. */
  invalidateDependents(t: TaskRow): void {
    const all = this.store.tasks(t.request_id)
    const gone = new Set<string>([t.key])
    for (let changed = true; changed;) {
      changed = false
      for (const x of all) if (!gone.has(x.key) && specOf(x).depends_on.some((d) => gone.has(d))) { gone.add(x.key); changed = true }
    }
    const kill: number[] = []
    for (const d of all) {
      if (d.id === t.id || !gone.has(d.key) || d.status === 'cancelled') continue
      for (const a of this.store.liveAttempts()) if (a.task_id === d.id) { this.store.updateAttempt(a.id, { outcome: 'superseded' }); if (a.pid) kill.push(a.pid) }
      const sameProjectDep = specOf(d).depends_on.some((k) => all.find((x) => x.key === k)?.project === d.project)
      this.store.updateTask(d.id, { status: 'pending', attempts: 0, head_sha: null, worktree: null, base_sha: sameProjectDep ? null : d.base_sha, limited_streak: 0,
        review_invalid: 0, resume_session: null, checks_state: null, report_sha: null, note: `선행 작업 ${t.key}이(가) 바뀌어 처음부터 다시 해요` })
      if (d.worktree || d.branch) queueMicrotask(() => void this.archiveTask(this.store.task(d.id)!, d.worktree))
    }
    this.store.supersede(`accept:${t.request_id}`)
    for (const pid of kill) queueMicrotask(() => killGroup(pid, 'SIGTERM'))
  }

  /** Removes a stale worktree and renames its branch to `<branch>-v<n>` (kept, never deleted). Idempotent. */
  async archiveTask(t: TaskRow, oldWorktree: string | null = null): Promise<void> {
    const p = this.project(t.project)
    if (!p) return
    await withRepo(p.path, async () => {
      const wt = oldWorktree ?? this.worktreeDir(t.request_id, t.key)
      if (existsSync(wt)) await removeWorktree(p.path, wt)
      if (t.branch && await branchExists(p.path, t.branch)) {
        let n = 1
        while (await branchExists(p.path, `${t.branch}-v${n}`)) n++
        await gitOk(p.path, ['branch', '-m', t.branch, `${t.branch}-v${n}`])
      }
    })
  }

  // ----- dispatch (§C 배정, §13) -----
  private liveCount(): number { return this.store.liveAttempts().length }

  depsPassed(t: TaskRow, all: TaskRow[]): boolean {
    return specOf(t).depends_on.every((d) => all.find((x) => x.key === d)?.status === 'passed')
  }

  /** Tasks that could start now if there were a free slot (for the headline and the invariant check). */
  readyTasks(): TaskRow[] {
    const out: TaskRow[] = []
    for (const r of this.store.requestsByStatus(['executing'])) {
      const all = this.store.tasks(r.id)
      for (const t of all) if (['pending', 'rework', 'held'].includes(t.status) && this.depsPassed(t, all)) out.push(t)
    }
    return out
  }

  private async dispatch(): Promise<void> {
    const q = this.quota()
    if (q.mode === 'hold') return
    const cap = q.mode === 'save' || q.mode === 'unobserved' ? 1 : this.cfg.maxWorkers
    let free = cap - this.liveCount()
    for (const t of this.store.tasksByStatus(['reviewing'])) {
      if (free <= 0) return
      const r = this.store.request(t.request_id)
      if (!r || !['executing', 'blocked'].includes(r.status)) continue
      if (this.store.liveAttempts().some((a) => a.task_id === t.id)) continue
      if (this.claimReview(t)) free--
    }
    for (const t of this.readyTasks()) {
      if (free <= 0) return
      if (this.claimWork(t)) free--
    }
  }

  // ----- work attempts (§7 start protocol) -----
  private claimWork(t: TaskRow): boolean {
    const prev = this.store.attempts(t.id).filter((a) => a.kind === 'work').at(-1)
    const resume = t.resume_session
    const counted = !resume && !(prev && UNCOUNTED_PREV.has(prev.status))
    const n = this.store.attempts(t.id).filter((a) => a.kind === 'work').length + 1
    const id = `${t.id}~a${n}`
    const sessionId = resume ?? randomUUID()
    const claimed = this.store.tx(() => {
      const cur = this.store.task(t.id)!
      if (!['pending', 'rework', 'held'].includes(cur.status)) return false
      this.store.insertAttempt({ id, task_id: t.id, kind: 'work', n, model: cur.model, status: 'starting', attempt_token: randomBytes(16).toString('hex'),
        dir: this.runDir(t.request_id, t.key, id), session_id: sessionId })
      this.store.updateTask(t.id, { status: 'running', attempts: cur.attempts + (counted ? 1 : 0) })
      return true
    })
    if (!claimed) return false
    this.launching.add(id)
    void this.prepareAndLaunch(id, !!resume, prev ?? null).finally(() => { this.launching.delete(id); this.kick() })
    this.emitTask(t, `${t.model}가 ${t.title} 시작`)
    return true
  }

  /** Base commit (§11): request base, a single same-project dependency's head, or hq's merge of several. */
  private depHeads(t: TaskRow): TaskRow[] {
    const all = this.store.tasks(t.request_id)
    return specOf(t).depends_on.map((k) => all.find((x) => x.key === k)!).filter((d) => d && d.project === t.project && d.role === 'implement' && d.head_sha)
  }

  private upstream(t: TaskRow): Upstream[] {
    const all = this.store.tasks(t.request_id)
    return specOf(t).depends_on.map((k) => all.find((x) => x.key === k)!).filter((d) => d && d.status === 'passed').map((d) => {
      const work = this.store.attempts(d.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
      const sealed = work ? readText(join(hqDirOf(work), d.role === 'collect' ? 'report.sealed.md' : '__none__'), 200_000) : null
      return { key: d.key, title: d.title, project: d.project, headSha: d.role === 'implement' ? d.head_sha : null, reportSha: d.report_sha, report: sealed }
    })
  }

  private async prepareAndLaunch(attemptId: string, resume: boolean, prev: AttemptRow | null): Promise<void> {
    const att = this.store.attempt(attemptId)!
    let t = this.store.task(att.task_id)!
    const project = this.project(t.project)
    const hq = hqDirOf(att), out = outDirOf(att)
    try {
      if (!project) throw new Setup(`등록되지 않은 프로젝트: ${t.project}`)
      mkdirSync(hq, { recursive: true }); mkdirSync(out, { recursive: true })
      const repo = project.path
      const wt = this.worktreeDir(t.request_id, t.key)
      if (!t.worktree) {
        await this.archiveTask(t)
        const deps = this.depHeads(t)
        let base = deps.length ? deps[0].head_sha! : t.base_sha!
        if (t.role === 'collect') await withRepo(repo, () => addDetachedWorktree(repo, wt, base))
        else {
          await withRepo(repo, () => ensureWorktree(repo, wt, t.branch!, base))
          if (deps.length > 1) {
            const m = await withRepo(repo, () => mergeHeads(wt, deps.slice(1).map((d) => d.head_sha!), `hq: ${t.key}의 선행 작업 합치기 (${deps.map((d) => d.key).join(', ')})`))
            if (!m.ok) throw new Setup(`선행 작업(${deps.map((d) => d.key).join(', ')})의 결과를 합치다 충돌: ${m.files.join(', ')}`)
            base = m.sha
          }
        }
        if (project.setup) {
          const sb = await this.sandboxFor(wt, null, repo)
          const prof = join(hq, 'setup.sb')
          atomicWrite(prof, sandboxProfile(sb))
          const s = await runSandboxed(project.setup, wt, this.cfg.checkTimeoutMinutes * 60_000, prof, 'setup')
          atomicJson(join(hq, 'setup.json'), s)
          if (!s.pass) throw new Setup(`setup 명령 실패 (종료 코드 ${s.exitCode ?? '시간 초과'}): ${s.outputTail.split('\n').slice(-5).join(' ').slice(0, 300)}`)
        }
        this.store.updateTask(t.id, { worktree: wt, base_sha: base })
        t = this.store.task(t.id)!
      }
      if (t.role === 'implement') await this.ensureBaseline(t, hq)
      let dirtyNotice: string | null = null
      if (t.role === 'implement' && existsSync(wt)) {
        const snap = await worktreeDirtySnapshot(wt)
        if (snap) {
          atomicWrite(join(hq, 'dirty.patch'), snap)
          await resetClean(wt)
          dirtyNotice = '이전 시도가 남긴 커밋되지 않은 변경을 hq가 저장(hq/dirty.patch)한 뒤 지웠다. 마지막 커밋에서 이어서 한다.'
        }
      }
      const spec = specOf(t)
      const role = t.role === 'collect' ? 'collect' : 'implement'
      let prompt: string
      if (resume) {
        const answers = prev ? this.store.taskQuestions(t.id, prev.id).filter((q) => q.answer !== null).map((q) => ({ question: q.question, answer: q.answer! })) : []
        prompt = resumePrompt({ answers, out, token: att.attempt_token, role, base: t.base_sha! })
      } else {
        const request = this.store.request(t.request_id)!
        prompt = workPrompt({ task: spec, requestText: request.text, projectName: project.name, cwd: wt, branch: role === 'implement' ? t.branch : null, base: t.base_sha!,
          out, token: att.attempt_token, rework: t.status === 'running' && t.note ? this.reworkText(t, prev) : null, dirtyNotice, upstream: this.upstream(t) })
      }
      const argv = claudeArgs(this.cfg, { role, model: att.model, sessionId: att.session_id, resume, out })
      const { info, child } = await launch({ claudeBin: this.cfg.claudeBin, argv, cwd: wt, hqDir: hq, outDir: out, prompt, sessionId: att.session_id,
        sandbox: await this.sandboxFor(wt, out, repo),
        spec: { attemptId, kind: 'work', role, model: att.model, base: t.base_sha, branch: t.branch, attempt_token: att.attempt_token, resume, startedAt: this.iso() } })
      const startedAt = this.iso()
      this.store.tx(() => {
        this.store.updateAttempt(attemptId, { status: 'running', pid: info.pid, lstart: info.lstart, started_at: startedAt })
        this.store.updateTask(t.id, { resume_session: null })
      })
      this.track({ ...att, status: 'running' }, info.pid, info.lstart, info.startedAt, child)
    } catch (e) {
      this.startFailed(att, e instanceof Setup ? e.message : `시작 실패: ${String(e)}`, e instanceof Setup)
    }
  }

  private reworkText(t: TaskRow, prev: AttemptRow | null): string {
    const works = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded')
    const lastOk = works.at(-1)
    const checks = lastOk ? readJson<ChecksFile>(join(hqDirOf(lastOk), 'checks.json')) : null
    const lastReview = this.store.attempts(t.id).filter((a) => a.kind === 'review' && a.outcome === 'blocking').at(-1)
    const verdict = lastReview ? readJson<Verdict>(join(hqDirOf(lastReview), 'verdict.json')) : null
    // Only evidence that belongs to the failure being reworked: checks/verdict of the last succeeded attempt.
    const fresh = !prev || prev.status === 'succeeded'
    return reworkEvidence({ reasons: t.note ? [t.note] : [], checks: fresh ? checks : null, verdict: fresh ? verdict : null })
  }

  /** §9 baseline: run each check once on this base (cached per repo/base/command). */
  private async ensureBaseline(t: TaskRow, hq: string): Promise<void> {
    const project = this.project(t.project)!
    const specs = nonManual(specOf(t))
    const key = (cmd: string) => `baseline:${project.path}:${t.base_sha}:${sha256(cmd)}`
    const missing = specs.filter((a) => this.store.get(key(a.check)) === null)
    if (!missing.length) return
    const res = await baseline({ repo: project.path, base: t.base_sha!, path: `${this.worktreeDir(t.request_id, t.key)}.baseline`,
      checks: missing.map((a) => ({ id: a.id, command: a.check })), setup: project.setup ?? null, timeoutMs: this.cfg.checkTimeoutMinutes * 60_000,
      sandbox: (wt) => ({ worktree: wt, out: null, repoGitDir: this.gitDirs.get(project.path) ?? null, hqHome: this.home, tokenDir: this.tokenDir, hqPort: this.hqPort, extraWritable: this.cfg.sandbox.extraWritable, claudeDir: join(homedir(), '.claude') }),
      profilePath: join(hq, 'baseline.sb') })
    for (const a of missing) this.store.set(key(a.check), res[a.id] ? 'pass' : 'fail')
  }

  baselineFailed(t: TaskRow, prefix = ''): Set<string> {
    const project = this.project(t.project)
    const out = new Set<string>()
    if (!project) return out
    for (const a of nonManual(specOf(t))) if (this.store.get(`baseline:${project.path}:${t.base_sha}:${sha256(a.check)}`) === 'fail') out.add(prefix + a.id)
    return out
  }

  private startFailed(att: AttemptRow, why: string, setupProblem: boolean): void {
    this.store.tx(() => {
      this.store.updateAttempt(att.id, { status: 'start_failed', ended_at: this.iso(), reason: why.slice(0, 2000) })
      const t = this.store.task(att.task_id)!
      if (att.kind === 'work' && t.status === 'running') this.store.updateTask(t.id, { status: 'pending' })
      const recent = this.store.attempts(t.id).filter((a) => a.kind === att.kind).slice(-MAX_START_FAILURES)
      const cur = this.store.task(t.id)!
      if (!['pending', 'reviewing'].includes(cur.status)) return
      if (setupProblem) this.block(cur, why)
      else if (recent.length >= MAX_START_FAILURES && recent.every((a) => a.status === 'start_failed')) this.block(cur, `${att.kind === 'work' ? '작업자' : '검토자'}를 ${MAX_START_FAILURES}번 연속 시작하지 못했어요: ${why.slice(0, 300)}`)
    })
    this.bus.emit({ kind: 'attempt', text: why.slice(0, 200), data: { id: att.id } })
  }

  // ----- verification (§9) -----
  private startVerifications(): void {
    for (const t of this.store.tasksByStatus(['verifying'])) {
      if (this.checking.has(t.id)) continue
      this.checking.add(t.id)
      void this.verify(t).finally(() => { this.checking.delete(t.id); this.kick() })
    }
  }

  private async verify(t: TaskRow): Promise<void> {
    const att = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
    this.store.updateTask(t.id, { checks_state: 'running' })
    try {
      if (!att || !t.worktree || !t.base_sha || !t.head_sha) throw new Error('성공한 시도·worktree·커밋 정보가 없음')
      const project = this.project(t.project)!
      const hq = hqDirOf(att)
      const file = await runChecks({ cwd: t.worktree, base: t.base_sha, head: t.head_sha, checks: nonManual(specOf(t)).map((a) => ({ id: a.id, command: a.check })),
        timeoutMs: this.cfg.checkTimeoutMinutes * 60_000, sandbox: await this.sandboxFor(t.worktree, null, project.path), profilePath: checksProfile(hq), baselineFailed: this.baselineFailed(t) })
      atomicJson(join(hq, 'checks.json'), file)
      const failed = file.checks.filter((c) => !c.pass && !c.baselineFailed).map((c) => `[${c.id}] ${c.command} → ${c.exitCode ?? '시간 초과'}`)
      if (file.error) failed.unshift(file.error)
      if (file.secrets.length) failed.push(`비밀값 패턴·금지 파일: ${file.secrets.map((s) => `${s.file}:${s.line}(${s.pattern})`).join(', ')}`)
      this.store.tx(() => {
        const cur = this.store.task(t.id)
        if (!cur || cur.status !== 'verifying' || cur.head_sha !== t.head_sha) return
        if (file.pass) this.store.updateTask(cur.id, { status: cur.review_model === 'none' ? 'passed' : 'reviewing', checks_state: 'passed' })
        else { this.store.updateTask(cur.id, { checks_state: 'failed' }); this.rework(cur, `기계 검증 실패: ${failed.join('; ')}`) }
        this.emitTask(cur, `${cur.title}: 검증 ${file.pass ? '통과' : '실패'}`)
      })
    } catch (e) {
      this.store.tx(() => {
        const cur = this.store.task(t.id)
        if (cur?.status === 'verifying') { this.store.updateTask(cur.id, { checks_state: 'error' }); this.block(cur, `검증을 실행할 수 없어요: ${String(e).slice(0, 300)}`) }
      })
    }
  }

  // ----- cross review (§10) -----
  private reviewWorktree(t: TaskRow, n: number): string { return `${this.worktreeDir(t.request_id, t.key)}.r${n}` }

  private claimReview(t: TaskRow): boolean {
    const n = this.store.attempts(t.id).filter((a) => a.kind === 'review').length + 1
    const id = `${t.id}~r${n}`
    this.store.insertAttempt({ id, task_id: t.id, kind: 'review', n, model: t.review_model, status: 'starting', attempt_token: randomBytes(16).toString('hex'),
      dir: this.runDir(t.request_id, t.key, id), session_id: randomUUID() })
    this.launching.add(id)
    void this.launchReview(id).finally(() => { this.launching.delete(id); this.kick() })
    this.emitTask(t, `${t.review_model}가 ${t.title} 검토 시작`)
    return true
  }

  private async launchReview(attemptId: string): Promise<void> {
    const att = this.store.attempt(attemptId)!
    const t = this.store.task(att.task_id)!
    const project = this.project(t.project)!
    const wt = this.reviewWorktree(t, att.n)
    const hq = hqDirOf(att)
    try {
      mkdirSync(hq, { recursive: true })
      await withRepo(project.path, () => addDetachedWorktree(project.path, wt, t.head_sha!))
      if (project.setup) {
        atomicWrite(join(hq, 'setup.sb'), sandboxProfile(await this.sandboxFor(wt, null, project.path)))
        const s = await runSandboxed(project.setup, wt, this.cfg.checkTimeoutMinutes * 60_000, join(hq, 'setup.sb'), 'setup')
        if (!s.pass) throw new Setup(`검토 worktree setup 실패 (종료 코드 ${s.exitCode ?? '시간 초과'})`)
      }
      const stat = await git(wt, ['diff', '--stat', t.base_sha!, t.head_sha!])
      const work = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
      const result = work ? readJson<{ protectedChanges?: string[] }>(join(hqDirOf(work), 'result.json')) : null
      const prompt = reviewPrompt({ task: specOf(t), requestText: this.store.request(t.request_id)!.text, base: t.base_sha!, head: t.head_sha!, diffStat: stat.stdout,
        checks: work ? readJson<ChecksFile>(join(hqDirOf(work), 'checks.json')) : null, protectedChanges: result?.protectedChanges ?? [] })
      const argv = claudeArgs(this.cfg, { role: 'review', model: att.model, sessionId: att.session_id, resume: false, out: null, schema: VERDICT_SCHEMA })
      const { info, child } = await launch({ claudeBin: this.cfg.claudeBin, argv, cwd: wt, hqDir: hq, outDir: null, prompt, sessionId: att.session_id,
        sandbox: await this.sandboxFor(wt, null, project.path),
        spec: { attemptId, kind: 'review', model: att.model, head_sha: t.head_sha, base_sha: t.base_sha, worktree: wt, startedAt: this.iso() } })
      const startedAt = this.iso()
      this.store.updateAttempt(attemptId, { status: 'running', pid: info.pid, lstart: info.lstart, started_at: startedAt })
      this.track({ ...att, status: 'running' }, info.pid, info.lstart, info.startedAt, child)
    } catch (e) {
      await withRepo(project.path, () => removeWorktree(project.path, wt)).catch(() => {})
      this.startFailed(att, e instanceof Setup ? e.message : `검토 시작 실패: ${String(e)}`, e instanceof Setup)
    }
  }

  async finalizeReview(att: AttemptRow, l: Live): Promise<void> {
    const task = this.store.task(att.task_id)!
    const project = this.project(task.project)
    const result = l.tail.finalResult()
    const endedAt = this.iso()
    if (project) await withRepo(project.path, () => removeWorktree(project.path, this.reviewWorktree(task, att.n))).catch(() => {})
    if (['cancelled', 'superseded'].includes(att.outcome ?? '') || this.requestStopped(task)) {
      this.store.updateAttempt(att.id, { status: 'failed', ended_at: endedAt, reason: '요청 중단', ...this.usage(result) })
      return
    }
    const hq = hqDirOf(att)
    if (att.outcome !== 'runaway' && isLimited(result, (readText(join(hq, 'stderr.log'), 200_000) ?? '').slice(-20_000), l.tail.rejectedSeen)) {
      this.store.updateAttempt(att.id, { status: 'limited', ended_at: endedAt, reason: '사용 한도', ...this.usage(result) })
      return // task stays reviewing; dispatch restarts the review when the hold ends
    }
    const codeChanged = task.base_sha && task.head_sha && project ? (await changedFiles(project.path, task.base_sha, task.head_sha).catch(() => ['?'])).length > 0 : true
    const spec = specOf(task)
    const check = att.outcome === 'runaway' ? { kind: 'invalid' as const, reason: `검토 폭주: ${att.reason ?? ''}`, verdict: null }
      : result?.is_error || !result ? { kind: 'invalid' as const, reason: `검토 실행 오류: ${String(result?.result ?? result?.subtype ?? '결과 없음').slice(0, 300)}`, verdict: null }
      : checkVerdict(result.structured_output, { acceptanceIds: spec.acceptance.map((a) => a.id), codeChanged, bashRuns: extractBashRuns(join(hq, 'stream.jsonl')) })
    const work = this.store.attempts(task.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
    const prot = work ? readJson<{ protectedChanges?: string[] }>(join(hqDirOf(work), 'result.json'))?.protectedChanges ?? [] : []
    const binding = { task: task.id, head_sha: task.head_sha ?? undefined, base_sha: task.base_sha ?? undefined, reviewer_model: att.model, implementer_model: task.model, sameFamily: true, protectedChanges: prot }
    atomicJson(join(hq, 'verdict.json'), check.verdict ? { ...check.verdict, ...binding, ...(check.kind === 'invalid' ? { invalid: check.reason } : {}) }
      : { invalid: check.kind === 'invalid' ? check.reason : null, raw: result?.structured_output ?? null, ...binding })
    this.store.tx(() => {
      const status = check.kind === 'pass' ? 'succeeded' : check.kind === 'blocking' ? 'failed' : 'unverifiable'
      this.store.updateAttempt(att.id, { status, ended_at: endedAt, outcome: check.kind, ...this.usage(result),
        reason: check.kind === 'invalid' ? check.reason : check.kind === 'blocking' ? check.verdict.blocking.map((b) => b.summary).join('; ').slice(0, 2000) : null })
      const t = this.store.task(att.task_id)!
      if (t.status !== 'reviewing' || t.head_sha !== task.head_sha) return
      if (check.kind === 'pass') this.store.updateTask(t.id, { status: 'passed', note: null })
      else if (check.kind === 'blocking') this.rework(t, `검토 blocking: ${check.verdict.blocking.map((b) => `[${b.id}] ${b.summary}`).join('; ')}`)
      else {
        const cnt = t.review_invalid + 1
        this.store.updateTask(t.id, { review_invalid: cnt, note: `검토 무효: ${check.reason}` })
        if (cnt >= 2) this.block(this.store.task(t.id)!, `검토가 ${cnt}번 무효였어요: ${check.reason}`)
      }
      this.emitTask(t, `${t.title}: 검토 ${check.kind}`)
    })
  }

  // ----- integration (§12) -----
  private projectsToIntegrate(requestId: string): string[] {
    return [...new Set(this.store.tasks(requestId).filter((t) => t.role === 'implement' && t.status === 'passed').map((t) => t.project))]
  }

  private startIntegrations(): void {
    for (const r of this.store.requestsByStatus(['executing', 'accepted'])) {
      for (const m of this.store.mergeRows(r.id)) {
        if (m.state !== 'pending') continue
        const k = `${r.id}:${m.project}`
        if (this.integrating.has(k)) continue
        this.integrating.add(k)
        void this.runIntegration(r.id, m.project).finally(() => { this.integrating.delete(k); this.kick() })
      }
    }
  }

  private async runIntegration(requestId: string, projectId: string): Promise<void> {
    const project = this.project(projectId)!
    this.store.putMerge(requestId, projectId, { state: 'integrating' })
    const prevNote = this.store.mergeRow(requestId, projectId)?.note ?? null
    const tasks = this.store.tasks(requestId).filter((t) => t.project === projectId && t.role === 'implement' && t.status === 'passed')
    const hq = join(this.home, 'runs', requestId, `_integration-${projectId}`, 'hq')
    mkdirSync(hq, { recursive: true })
    const target = await currentBranch(project.path)
    const fail = (state: string, note: string, body: string) => this.store.tx(() => {
      this.store.putMerge(requestId, projectId, { state, note })
      const r = this.store.request(requestId)!
      if (!TERMINAL_REQUEST.has(r.status)) this.store.updateRequest(requestId, { status: 'blocked', note })
      this.store.putApproval({ id: `integration:${requestId}:${projectId}`, teamId: 'hq', subjectId: requestId, title: `통합 실패: ${project.name}`,
        body, options: ['다시 통합', '요청 중단'], subjectHash: sha256(`${requestId}:${projectId}:${note}:${this.now()}`) })
    })
    if (!target) { fail('failed', `프로젝트 ${project.name} checkout이 브랜치가 아니라서(detached HEAD) 통합할 대상이 없어요`, '프로젝트 checkout을 브랜치로 되돌린 뒤 다시 통합하세요.'); return }
    const checks: CheckSpec[] = tasks.flatMap((t) => nonManual(specOf(t)).map((a) => ({ id: `${t.key}.${a.id}`, command: a.check })))
    const bf = new Set<string>(tasks.flatMap((t) => [...this.baselineFailed(t, `${t.key}.`)]))
    const path = this.integrationDir(requestId, projectId)
    const res = await integrate({ repo: project.path, requestId, project: projectId, path, target, heads: tasks.map((t) => ({ taskId: t.id, title: t.title, sha: t.head_sha! })),
      setup: project.setup ?? null, checks, baselineFailed: bf, timeoutMs: this.cfg.checkTimeoutMinutes * 60_000,
      sandbox: await this.sandboxFor(path, null, project.path), profilePath: join(hq, 'checks.sb') })
    if (res.kind !== 'conflict' && res.checks) atomicJson(join(hq, 'checks.json'), res.checks)
    if (res.kind === 'conflict') {
      const who = tasks.find((t) => t.id === res.taskId)
      fail('conflict', `통합 충돌 (${who?.key ?? res.taskId}): ${res.files.join(', ')}`, `작업 ${who?.title ?? res.taskId}을(를) ${target}(${res.targetSha.slice(0, 10)}) 위에 합치다 충돌했어요.\n충돌 파일:\n${res.files.map((f) => `- ${f}`).join('\n')}`)
      this.notify('통합 충돌', `${project.name}: ${res.files.slice(0, 3).join(', ')}`)
      return
    }
    if (res.kind === 'failed') { fail('failed', res.reason, res.reason); return }
    this.store.tx(() => {
      this.store.putMerge(requestId, projectId, { state: 'integrated', target, target_sha: res.targetSha, integration_sha: res.sha, note: prevNote })
      if (this.store.request(requestId)?.status === 'accepted') this.offerMerge(requestId, projectId)
    })
  }

  /** Called after the chairman decides an integration card. */
  integrationDecided(requestId: string, projectId: string, decision: string): string | null {
    if (decision === '요청 중단') return this.cancelRequest(requestId)
    return this.store.tx(() => {
      const m = this.store.mergeRow(requestId, projectId)
      if (!m || !['conflict', 'failed'].includes(m.state)) return '다시 통합할 수 있는 상태가 아닙니다'
      this.store.putMerge(requestId, projectId, { state: 'pending', note: null })
      const accepted = this.store.approval(`accept:${requestId}`)?.decision === '수락'
      const r = this.store.request(requestId)!
      if (r.status === 'blocked' && !this.store.tasks(requestId).some((t) => t.status === 'blocked')) this.store.updateRequest(requestId, { status: accepted ? 'accepted' : 'executing', note: null })
      this.kick()
      return null
    })
  }

  // ----- request completion (§C step 5, §12) -----
  private acceptSubject(requestId: string): string {
    const lines = this.store.tasks(requestId).filter((t) => t.status === 'passed').map((t) => {
      const work = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
      const checks = work ? readText(join(hqDirOf(work), 'checks.json')) ?? '' : ''
      return `${t.id}|${t.head_sha}|${t.report_sha ?? ''}|${sha256(checks)}`
    }).sort()
    const ints = this.store.mergeRows(requestId).map((m) => `${m.project}|${m.integration_sha}`).sort()
    return sha256([...lines, ...ints].join('\n'))
  }

  private putAcceptCard(requestId: string): void {
    const r = this.store.request(requestId)!
    const tasks = this.store.tasks(requestId)
    const body: string[] = []
    for (const t of tasks) {
      if (t.status === 'cancelled') { body.push(`${t.key} ${t.title} — 취소됨`); continue }
      const work = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
      const done = work ? readJson<{ summary?: string; files_modified?: string[] }>(join(outDirOf(work), 'done.json')) : null
      const checks = work ? readJson<ChecksFile>(join(hqDirOf(work), 'checks.json')) : null
      const result = work ? readJson<{ protectedChanges?: string[] }>(join(hqDirOf(work), 'result.json')) : null
      const review = this.store.attempts(t.id).filter((a) => a.kind === 'review' && a.outcome === 'pass').at(-1)
      const verdict = review ? readJson<Verdict>(join(hqDirOf(review), 'verdict.json')) : null
      const parts = [`변경 파일 ${done?.files_modified?.length ?? 0}개`,
        checks ? `검사 ${checks.checks.filter((c) => c.pass).length}/${checks.checks.length} 통과` : '검사 없음',
        t.role === 'collect' ? '조사(검토 없음)' : t.review_model === 'none' ? '검토 없음(기계 검증만)' : verdict ? `검토 통과(${review!.model}${verdict.advisory.length ? `, 참고 ${verdict.advisory.length}건` : ''})` : '검토 기록 없음']
      const bf = checks?.checks.filter((c) => c.baselineFailed).map((c) => c.id) ?? []
      if (bf.length) parts.push(`기존 실패: ${bf.join(', ')}`)
      if (result?.protectedChanges?.length) parts.push(`보호 경로 변경: ${result.protectedChanges.join(', ')}`)
      body.push(`${t.key} [${t.model}] ${t.title} — ${done?.summary ?? ''}\n  ${parts.join(' · ')}`)
    }
    for (const m of this.store.mergeRows(requestId)) body.push(`통합 ${m.project}: ${m.target} ${m.target_sha?.slice(0, 10)} → ${m.integration_sha?.slice(0, 10)}`)
    this.store.putApproval({ id: `accept:${requestId}`, teamId: 'hq', subjectId: requestId, title: `결과 수락: ${r.text.replace(/\s+/g, ' ').slice(0, 60)}`,
      body: body.join('\n'), options: ['수락', '반려'], subjectHash: this.acceptSubject(requestId) })
  }

  /** Call inside a tx. */
  private offerMerge(requestId: string, projectId: string): void {
    const m = this.store.mergeRow(requestId, projectId)!
    const project = this.project(projectId)!
    const tasks = this.store.tasks(requestId).filter((t) => t.project === projectId && t.role === 'implement' && t.status === 'passed')
    const body = [...(m.note ? [m.note, ''] : []), `대상: ${project.name} ${m.target} (${m.target_sha?.slice(0, 10)})`, `병합할 통합 커밋: ${m.integration_sha?.slice(0, 10)} (fast-forward)`,
      ...tasks.map((t) => `- ${t.key} ${t.title}`)].join('\n')
    this.store.putApproval({ id: `merge:${requestId}:${projectId}`, teamId: 'hq', subjectId: requestId, title: `병합 승인: ${project.name} ${m.target}`, body,
      options: ['병합', '보류'], subjectHash: sha256(`${m.target}|${m.target_sha}|${m.integration_sha}`) })
    this.store.putMerge(requestId, projectId, { state: 'offered' })
  }

  private async completeRequests(): Promise<void> {
    for (const a of this.store.expiredApprovals(this.now())) {
      if (a.kind !== 'plan') continue
      const id = a.subjectId ?? a.id.slice(5)
      this.store.tx(() => { this.store.supersede(a.id); if (this.store.request(id)?.status === 'planned') this.store.updateRequest(id, { status: 'expired', note: '계획 승인 기한(7일)이 지남' }) })
    }
    for (const r of this.store.requestsByStatus(['executing'])) {
      this.store.tx(() => {
        const all = this.store.tasks(r.id)
        if (!all.length) return
        const live = all.filter((t) => t.status !== 'cancelled')
        if (!live.length) { this.store.updateRequest(r.id, { status: 'cancelled', note: '모든 작업이 취소됨' }); this.emitRequest(r.id, '모든 작업이 취소됨'); return }
        if (!live.every((t) => t.status === 'passed')) return
        const projects = this.projectsToIntegrate(r.id)
        for (const p of projects) if (!this.store.mergeRow(r.id, p)) this.store.putMerge(r.id, p, { state: 'pending' })
        const rows = this.store.mergeRows(r.id)
        if (rows.some((m) => m.state !== 'integrated')) return
        this.store.updateRequest(r.id, { status: 'awaiting_acceptance', note: null })
        this.putAcceptCard(r.id)
        this.emitRequest(r.id, '모든 작업 통과 — 결과 수락을 기다려요')
      })
    }
    for (const r of this.store.requestsByStatus(['accepted'])) {
      this.store.tx(() => {
        for (const m of this.store.mergeRows(r.id)) if (m.state === 'integrated') this.offerMerge(r.id, m.project)
      })
    }
    for (const r of this.store.requestsByStatus(['cancelled'])) await this.cleanupCancelled(r.id)
  }

  // ----- chairman actions (§D) -----
  /** Routes a decided approval card (server calls this after store.decide succeeded). */
  async onApproval(a: ApprovalRow): Promise<string | null> {
    const d = a.decision!
    if (a.kind === 'accept') return d === '수락' ? this.accept(a.id.slice(7)) : this.rejectResult(a.id.slice(7), '(사유 없음)', undefined, true)
    if (a.kind === 'merge') {
      const [, req, project] = a.id.split(':')
      if (d === '병합') return this.merge(req, project)
      this.store.putMerge(req, project, { state: 'held' })
      return null
    }
    if (a.kind === 'integration') { const [, req, project] = a.id.split(':'); return this.integrationDecided(req, project, d) }
    if (a.kind === 'revise') {
      const taskId = a.id.slice('revise:'.length)
      const raw = this.store.get(`revise:${taskId}`)
      if (d === '승인' && raw) return this.applyRevision(taskId, JSON.parse(raw) as PlanTask)
      return this.store.tx(() => { const t = this.store.task(taskId); if (t?.status === 'revising') this.block(t, '회장이 지시서 수정안을 반려했어요'); return null })
    }
    return null
  }

  accept(requestId: string): string | null {
    const err = this.store.tx(() => {
      const r = this.store.request(requestId)
      if (r?.status !== 'awaiting_acceptance') return '결과 수락을 기다리는 요청이 아닙니다'
      this.store.updateRequest(requestId, { status: 'accepted', note: null })
      for (const m of this.store.mergeRows(requestId)) if (m.state === 'integrated') this.offerMerge(requestId, m.project)
      return null
    })
    if (!err) { this.emitRequest(requestId, this.store.mergeRows(requestId).length ? '결과 수락 — 병합 승인을 기다려요' : '결과 수락 — 완료'); this.kick() }
    return err
  }

  async merge(requestId: string, projectId: string): Promise<string | null> {
    const project = this.project(projectId)
    const m = this.store.mergeRow(requestId, projectId)
    if (!project || !m || m.state !== 'offered' || !m.target || !m.target_sha || !m.integration_sha) return '병합할 수 있는 상태가 아닙니다'
    const ok = this.store.tx(() => {
      if (this.store.request(requestId)?.status !== 'accepted') return false
      this.store.updateRequest(requestId, { status: 'merging' })
      this.store.putMerge(requestId, projectId, { state: 'merging' })
      return true
    })
    if (!ok) return '수락된 요청이 아닙니다'
    const res = await applyMerge({ repo: project.path, target: m.target, targetSha: m.target_sha, integrationSha: m.integration_sha })
    if (res.kind === 'merged') {
      const all = this.store.tx(() => {
        this.store.putMerge(requestId, projectId, { state: 'merged', result_sha: res.sha })
        const done = this.store.mergeRows(requestId).every((x) => x.state === 'merged')
        this.store.updateRequest(requestId, { status: done ? 'merged' : 'accepted', note: null })
        return done
      })
      this.emitRequest(requestId, `병합 완료: ${project.name} ${m.target}`)
      if (all) await this.cleanupMerged(requestId)
      if (real(project.path) === real(this.hqRoot)) this.notify('hq 재시작 필요', `hq 자신의 코드가 병합됐어요 (${res.sha.slice(0, 10)}). 데몬을 다시 시작하세요.`)
      return null
    }
    this.store.tx(() => {
      if (res.kind === 'stale') this.store.putMerge(requestId, projectId, { state: 'pending', note: `다시 통합한 이유: ${res.why}` })
      else this.store.putMerge(requestId, projectId, { state: 'detached', note: `${project.name} checkout이 detached HEAD라서 병합하지 않았어요` })
      this.store.updateRequest(requestId, { status: 'accepted', note: res.kind === 'stale' ? res.why : `${project.name} checkout이 detached HEAD — 브랜치로 돌린 뒤 병합을 다시 요청하세요` })
    })
    if (res.kind === 'detached') this.notify('병합 대기', `${project.name} checkout이 detached HEAD예요. 브랜치로 돌린 뒤 병합을 다시 요청하세요.`)
    this.emitRequest(requestId, res.kind === 'stale' ? `병합 전 확인 실패, 다시 통합: ${res.why}` : '병합 대기: detached HEAD')
    this.kick()
    return null
  }

  /** POST /api/requests/:id/merge — re-offer held or detached merges after re-checking the integration. */
  reofferMerge(requestId: string): string | null {
    return this.store.tx(() => {
      if (this.store.request(requestId)?.status !== 'accepted') return '수락된 요청이 아닙니다'
      const rows = this.store.mergeRows(requestId).filter((m) => ['held', 'detached', 'offered'].includes(m.state))
      if (!rows.length) return '다시 제시할 병합이 없습니다'
      for (const m of rows) { this.store.supersede(`merge:${requestId}:${m.project}`); this.store.putMerge(requestId, m.project, { state: 'pending' }) }
      this.kick()
      return null
    })
  }

  private async cleanupMerged(requestId: string): Promise<void> {
    for (const t of this.store.tasks(requestId)) {
      const p = this.project(t.project)
      if (!p) continue
      await withRepo(p.path, async () => {
        if (t.worktree) await removeWorktree(p.path, t.worktree)
        if (t.branch && await branchExists(p.path, t.branch)) await git(p.path, ['branch', '-d', t.branch])
      }).catch(() => {})
    }
    for (const m of this.store.mergeRows(requestId)) { const p = this.project(m.project); if (p) await git(p.path, ['update-ref', '-d', integrationRef(requestId, m.project)]) }
  }

  /** §D rejectResult: rework the named (or all passed) tasks; dependents are invalidated by rework(). */
  rejectResult(requestId: string, reason: string, keys?: string[], cardDecided = false): string | null {
    const err = this.store.tx(() => {
      const r = this.store.request(requestId)
      if (r?.status !== 'awaiting_acceptance') return '결과 수락을 기다리는 요청이 아닙니다'
      const all = this.store.tasks(requestId)
      if (keys) for (const k of keys) if (!all.some((t) => t.key === k && t.status === 'passed')) return `통과한 작업이 아닙니다: ${k}`
      if (!cardDecided) this.store.supersede(`accept:${requestId}`)
      this.store.updateRequest(requestId, { status: 'executing', note: `결과 반려: ${reason}` })
      for (const t of all) if (t.status === 'passed' && (!keys || keys.includes(t.key))) this.rework(t, `결과 반려: ${reason}`)
      this.store.raw().prepare('delete from merges where request_id = ?').run(requestId)
      if (this.store.tasks(requestId).some((t) => t.status === 'blocked')) this.store.updateRequest(requestId, { status: 'blocked' })
      return null
    })
    if (!err) { this.emitRequest(requestId, `결과 반려: ${reason}`); this.kick() }
    return err
  }

  cancelRequest(requestId: string): string | null {
    const kill: number[] = []
    const err = this.store.tx(() => {
      const r = this.store.request(requestId)
      if (!r) return '요청이 없습니다'
      if (TERMINAL_REQUEST.has(r.status) || r.status === 'merging') return '이미 끝났거나 병합 중인 요청입니다'
      if (r.status === 'accepted' && !this.store.mergeRows(requestId).length) return '이미 끝난 요청입니다'
      this.store.updateRequest(requestId, { status: 'cancelled', note: '회장이 중단' })
      const tasks = this.store.tasks(requestId)
      for (const t of tasks) if (t.status !== 'passed' && t.status !== 'cancelled') this.store.updateTask(t.id, { status: 'cancelled' })
      for (const a of this.store.liveAttempts()) if (tasks.some((t) => t.id === a.task_id)) { this.store.updateAttempt(a.id, { outcome: 'cancelled', reason: '요청 중단' }); if (a.pid) kill.push(a.pid) }
      for (const a of this.store.openApprovals(Number.MAX_SAFE_INTEGER - 1)) {
        if (a.id === `plan:${requestId}` || a.id === `accept:${requestId}` || a.id.startsWith(`merge:${requestId}:`) || a.id.startsWith(`integration:${requestId}:`)
          || (a.kind === 'revise' && tasks.some((t) => a.id === `revise:${t.id}`))) this.store.supersede(a.id)
      }
      return null
    })
    if (err) return err
    for (const pid of kill) { killGroup(pid, 'SIGTERM'); setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS).unref() }
    this.emitRequest(requestId, '요청 중단')
    this.kick()
    return null
  }

  private async cleanupCancelled(requestId: string): Promise<void> {
    if (this.store.get(`cleaned:${requestId}`)) return
    const tasks = this.store.tasks(requestId)
    if (this.store.liveAttempts().some((a) => tasks.some((t) => t.id === a.task_id))) return
    for (const t of tasks) {
      const p = this.project(t.project)
      if (p && t.worktree) await withRepo(p.path, () => removeWorktree(p.path, t.worktree!)).catch(() => {})
    }
    this.store.set(`cleaned:${requestId}`, this.iso())
  }

  /** §D decideTask: retry once more on the top model, skip (with dependents), or stop the request. */
  decideTask(taskId: string, decision: string, revision: number): string | null {
    const t = this.store.task(taskId)
    if (!t || t.status !== 'blocked') return '차단된 작업이 아닙니다'
    if (t.revision !== revision) return `오래된 revision입니다 (현재 ${t.revision})`
    if (decision === 'stop') return this.cancelRequest(t.request_id)
    if (decision !== 'retry' && decision !== 'skip') return 'decision은 retry | skip | stop 중 하나여야 합니다'
    this.store.tx(() => {
      if (decision === 'retry') {
        this.store.updateTask(t.id, { status: 'rework', attempts: this.cfg.maxAttempts - 1, model: this.cfg.ladder[this.cfg.ladder.length - 1], limited_streak: 0,
          review_invalid: 0, resume_session: null, note: `회장: 한 번 더 (최상위 모델)\n이전 사유: ${t.note ?? ''}`.slice(0, 2000) })
      } else {
        const all = this.store.tasks(t.request_id)
        const gone = new Set([t.key])
        for (let changed = true; changed;) {
          changed = false
          for (const x of all) if (!gone.has(x.key) && specOf(x).depends_on.some((d) => gone.has(d))) { gone.add(x.key); changed = true }
        }
        for (const x of all) if (gone.has(x.key) && x.status !== 'passed' && x.status !== 'cancelled') this.store.updateTask(x.id, { status: 'cancelled', note: x.id === t.id ? '회장: 이 작업 건너뛰기' : `선행 작업 ${t.key} 건너뜀` })
      }
      this.unblockRequest(t.request_id)
    })
    this.emitTask(t, `회장 결정: ${t.title} → ${decision}`)
    this.kick()
    return null
  }

  /** A blocked request goes back to executing once nothing in it needs the chairman any more. Call inside a tx. */
  private unblockRequest(requestId: string): void {
    const r = this.store.request(requestId)!
    if (r.status !== 'blocked') return
    if (this.store.tasks(requestId).some((x) => x.status === 'blocked')) return
    if (this.store.mergeRows(requestId).some((m) => ['conflict', 'failed'].includes(m.state))) return
    this.store.updateRequest(requestId, { status: 'executing', note: null })
  }

  /** §D answerTask: only a question owned by this task at its current revision. All answered → resume the same session. */
  answerTask(taskId: string, questionId: string, answer: string, revision: number): string | null {
    const err = this.store.tx(() => {
      const t = this.store.task(taskId)
      if (!t || t.status !== 'question') return '질문을 기다리는 작업이 아닙니다'
      if (t.revision !== revision) return `오래된 revision입니다 (현재 ${t.revision})`
      const qs = this.store.taskQuestions(taskId)
      const q = qs.find((x) => x.id === questionId)
      if (!q || q.revision !== t.revision) return '이 작업의 현재 질문이 아닙니다'
      if (!this.store.answerTaskQuestion(questionId, answer)) return '이미 답한 질문입니다'
      const open = this.store.taskQuestions(taskId, q.attempt_id).filter((x) => x.answer === null)
      if (!open.length) this.store.updateTask(taskId, { status: 'pending' })
      return null
    })
    if (!err) { this.bus.emit({ kind: 'task', text: `작업자 질문 답변: ${answer.slice(0, 60)}`, data: { id: taskId } }); this.kick() }
    return err
  }

  // ----- brief revision (§10a) -----
  private async reviseOne(): Promise<void> {
    if (this.quota().mode === 'hold') return
    const t = this.store.tasksByStatus(['revising']).find((x) => !this.revising.has(x.id) && this.store.approval(`revise:${x.id}`)?.state !== 'open'
      && this.store.request(x.request_id)?.status === 'executing')
    if (!t || !this.ceoLock.tryAcquire()) return
    this.revising.add(t.id)
    void this.runRevise(t).finally(() => { this.revising.delete(t.id); this.ceoLock.release(); this.kick() })
  }

  private async runRevise(t: TaskRow): Promise<void> {
    const project = this.project(t.project)!
    const r = this.store.request(t.request_id)!
    const spec = specOf(t)
    const att = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'brief_blocked').at(-1)
    const report = att ? readOut(outDirOf(att), 'report.md', REPORT_MAX) : null
    const stat = t.worktree && t.base_sha && existsSync(t.worktree) ? (await git(t.worktree, ['diff', '--stat', t.base_sha, 'HEAD'])).stdout : ''
    this.store.updateTask(t.id, { revise_turns: t.revise_turns + 1 })
    const res = await runReviseTurn({ claudeBin: this.cfg.claudeBin, hqRoot: this.hqRoot, project, projects: this.projects, requestText: r.text, task: spec, report, diffStat: stat,
      onLine: (line) => { if (line.type === 'rate_limit_event') this.observe(line) } })
    if (res.limited) { this.store.updateTask(t.id, { revise_turns: t.revise_turns }); return } // retried when the hold ends; not counted
    const cur = this.store.task(t.id)
    if (!cur || cur.status !== 'revising') return
    if (!res.ok || !res.output) { this.store.tx(() => this.block(cur, `지시서 수정 턴 실패: ${res.error ?? ''}`)); return }
    if (!res.output.revised_task) {
      this.store.tx(() => this.block(cur, `사장이 지시서를 고치려면 회장님 답이 필요해요:\n${res.output!.questions.map((q) => `- ${q.question} (기본: ${q.default})`).join('\n')}`))
      return
    }
    const rev = res.output.revised_task
    const plan = this.store.tasks(t.request_id).map((x) => (x.id === t.id ? rev : specOf(x)))
    const problem = rev.id !== spec.id ? '작업 id가 바뀜' : validateTasks(plan, this.projects)
    if (problem) { this.store.tx(() => this.block(cur, `지시서 수정안이 유효하지 않아요: ${problem}`)); return }
    if (canAutoApply(spec, rev)) { this.applyRevision(t.id, rev); return }
    this.store.tx(() => {
      this.store.set(`revise:${t.id}`, JSON.stringify(rev))
      this.store.putApproval({ id: `revise:${t.id}`, teamId: 'hq', subjectId: t.request_id, title: `지시서 수정 승인: ${t.title}`, body: reviseDiff(spec, rev),
        options: ['승인', '반려'], subjectHash: sha256(JSON.stringify(rev)) })
    })
    this.emitTask(t, `지시서 수정안 승인 필요: ${t.title}`)
  }

  /** §D applyRevision: new spec, revision+1, rework keeping attempts, no resume, dependents invalidated. */
  applyRevision(taskId: string, rev: PlanTask): string | null {
    return this.store.tx(() => {
      const t = this.store.task(taskId)
      if (!t || t.status !== 'revising') return '지시서 수정을 기다리는 작업이 아닙니다'
      this.store.updateTask(taskId, { spec: JSON.stringify(rev), title: rev.title, grade: rev.grade, model: rev.model, review_model: reviewModelOf(rev),
        revision: t.revision + 1, status: 'rework', resume_session: null, note: '지시서 수정 적용' })
      this.store.set(`revise:${taskId}`, null)
      this.invalidateDependents(this.store.task(taskId)!)
      this.emitTask(t, `지시서 수정 적용: ${rev.title} (revision ${t.revision + 1})`)
      this.kick()
      return null
    })
  }

  // ----- notifications (§17: once per decision id + revision) -----
  private notifyDecisions(): void {
    const titles: Record<DecisionItem['kind'], string> = { plan: '사장이 계획을 올렸어요', ceo_question: '사장이 질문했어요', worker_question: '작업자가 질문했어요',
      revise: '지시서 수정안 승인이 필요해요', blocked: '작업이 막혔어요 — 판단이 필요해요', integration: '통합에 실패했어요', accept: '결과 수락을 기다려요', merge: '병합 승인을 기다려요' }
    for (const d of decisionItems(this.store, this.now())) {
      const k = `notified:${d.id}:${d.revision}`
      if (this.store.get(k)) continue
      this.store.set(k, this.iso())
      this.notify(titles[d.kind], d.title)
    }
  }

  // ----- screen data -----
  views(): { workers: WorkerView[]; headline: Headline; quota: QuotaView | null; decisions: DecisionItem[] } {
    const decisions = decisionItems(this.store, this.now())
    const workers = workerViews(this.store, (a) => this.live.get(a.id)?.tail.lastActivity ?? lastActivityOf(hqDirOf(a)))
    const q = this.quota()
    const failures = this.store.requestsByStatus(['blocked']).map((r) => ({ title: r.text.replace(/\s+/g, ' ').slice(0, 30), reason: r.note ?? '' }))
    const merged = this.store.requestsByStatus(['merged']).filter((r) => this.now() - Date.parse(r.updated_at) < 10 * 60_000).at(-1)
    const waiting = this.readyTasks().length + this.store.tasksByStatus(['reviewing']).filter((t) => !this.store.liveAttempts().some((a) => a.task_id === t.id)).length
    const headline = buildHeadline({ decisions, failures, workers, ceoThinking: this.store.requestsByStatus(['thinking']).length > 0, waiting, quota: q,
      recentMerged: merged ? merged.text.replace(/\s+/g, ' ').slice(0, 40) : null, reviewFollows: (id) => this.store.task(id)?.review_model !== 'none' })
    return { workers, headline, quota: this.quotaView(), decisions }
  }

  private cleanupOldLogs(): void {
    for (const r of this.store.requestsByStatus([...TERMINAL_REQUEST])) {
      if (this.now() - Date.parse(r.updated_at) < LOG_RETENTION_MS || this.store.get(`logsPurged:${r.id}`)) continue
      rmSync(join(this.home, 'runs', r.id), { recursive: true, force: true })
      this.store.set(`logsPurged:${r.id}`, this.iso())
    }
  }

  /** Adopts a recovered process (used by reconcile.recover). */
  async adopt(att: AttemptRow, pid: number): Promise<void> {
    const lstart = await psLstart(pid)
    this.store.updateAttempt(att.id, { status: 'running', pid, lstart, started_at: att.started_at ?? this.iso() })
    this.track(this.store.attempt(att.id)!, pid, lstart, att.started_at ?? this.iso(), null)
  }

  findOrphan(sessionId: string): Promise<number | null> { return findOrphan(sessionId) }

  requestRow(id: string): RequestRow | null { return this.store.request(id) }
}

/** A preparation failure that blocks the task instead of counting as a start failure (setup, dependency merge). */
class Setup extends Error {}

