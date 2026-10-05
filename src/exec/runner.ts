// Execution scheduler and state machine (execution.md v3 §5-§13, exec-engine-spec.md §C §D + v3 change orders).
// The runner is the only writer of task/attempt state. Every transition is one DB transaction, guarded by the task
// generation (§7.7), and intent is recorded before side effects (spawn, git writes, kill). Long work runs in
// background jobs; the 2-second tick only observes and advances state.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Bus } from '../bus.ts'
import { reviewModelOf, validateTasks, type Acceptance, type CeoPlan, type PlanTask, type Project } from '../ceo.ts'
import type { HqConfig } from '../config.ts'
import type { ApprovalRow, AttemptRow, RequestRow, Store, TaskRow } from '../store.ts'
import type { DecisionItem, Headline, QuotaView, Verdict, WorkerView } from '../types.ts'
import { baseline, checksProfile, envFailure, runChecks, runSandboxed, setupChangedReason, trackedChanges, type BaseResult, type CheckSpec, type ChecksFile, type OnSpawn } from './checks.ts'
import { DONE_MAX, isLimited, isNotLoggedIn, judgeWork, mirrorFacts, readOut, REPORT_MAX, type GitFacts, type WorkOutcome } from './contract.ts'
import { BLOCKED_OPTIONS, buildHeadline, decisionItems, hqDirOf, lingeringOf, lingeringPsKey, lingeringWait, outDirOf, RELEASE, workerViews, type HeadlineInput, type Lingering, type LingeringPs } from './decisions.ts'
import { runDiagnoseTurn } from './diagnose.ts'
import { atomicJson, atomicWrite, readJson, readText, sha256 } from './fsx.ts'
import { currentBranch, isRepo, revParse, withRepo } from './git.ts'
import { integrate, integrationRef } from './integration.ts'
import { applyMerge } from './merge.ts'
import { resumePrompt, reviewPrompt, reworkEvidence, workPrompt, type Upstream } from './prompt.ts'
import { isAllowedEvent, quotaState, quotaView, recordRateLimit, rejectedWithoutReset, type QuotaState } from './quota.ts'
import { ensureMirror, fetchWork, hqGit, hqGitOk, mirrorChanged, mirrorPath, mirrorRev, newWorkClone, removeMirrorWorktree, verifyWorktree, wtGit, wtMerge, wtStatus } from './repos.ts'
import { canAutoApply, reviseDiff, reviseProblem, runReviseTurn } from './revise.ts'
import { checkVerdict, ladderUp, VERDICT_SCHEMA } from './review.ts'
import { codexBinReadable, real, sandboxProfile, type SandboxOpts } from './sandbox.ts'
import { extractBashRuns, lastActivityOf, StreamTail } from './stream.ts'
import { codexArgs, defaultProbe, findOrphan, identify, killGroup, launch, LaunchAborted, looksLikeWorker, pidAlive, psInfo, readProcessInfo, removeCacheDir, terminateGroup, type ExitWatch, type Identity, type Probe } from './worker.ts'
import { reconcile as reconcileInvariants, recover as recoverState, type Violation } from './reconcile.ts'

export type Notify = (title: string, body: string) => void

/** Serializes CEO turns (plan turns in the engine, revise and diagnosis turns here). */
export class TurnLock {
  private held = false
  tryAcquire(): boolean { if (this.held) return false; this.held = true; return true }
  release(): void { this.held = false }
  get busy(): boolean { return this.held }
}

export interface RunnerDeps {
  store: Store; bus: Bus; cfg: HqConfig; projects: Project[]; hqRoot: string; hqPort: number; notify: Notify; now: () => number
  /** Folder of the daemon token, denied inside the sandbox (dirname of HQ_TOKEN_FILE; default ~/.config/hq). */
  tokenDir?: string
  /** Shared with the engine so CEO turns never overlap. */
  ceoLock?: TurnLock
  /** Team id → display name, for team decision titles. */
  teamNames?: Record<string, string>
  /** How process identity is observed (tests inject failing or swapped ps). */
  probe?: Partial<Probe>
}

export interface Live {
  tail: StreamTail
  pid: number
  lstart: string | null
  startedAt: string | null
  /** Set for processes spawned by this daemon; recovered ones are probed by pid + start time. */
  child: ChildProcess | null
  /** Exit observed since spawn (null for recovered processes). */
  exit: ExitWatch | null
  exited: boolean
  killAt: number | null
  killed9: boolean
  /** Seen as `same` at least once: only then may the leftover group be cleaned up after the leader is gone (§7.4). */
  confirmed: boolean
  /** Consecutive `unknown` identities and when the streak began (runner clock); any `same` resets both. */
  unknownPolls: number
  unknownSince: number | null
}

/** Result of a chairman decision; replays of the same decision return the stored one (§D). */
export interface DecideResult { status: number; body: Record<string, unknown> }

const KILL_GRACE_MS = 10_000
const MAX_QUESTION_ROUNDS = 3
const MAX_REVISE_TURNS = 2
const MAX_LIMITED_STREAK = 3
const RECONCILE_MS = 60_000
const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000
const BACKOFF_MIN = [15, 30, 60]
/** Background job retry: 1s → 2s → … → 60s; the 5th failure in a row stops its task. */
const JOB_BACKOFF_MIN_MS = 1_000
const JOB_BACKOFF_MAX_MS = 60_000
const JOB_MAX_FAILURES = 5
const JOB_FAILING = '내부 작업이 계속 실패해요 · hq logs를 확인해 주세요'
/** `unknown` must last this many polls and this long before the task stops (one failed ps is not enough). */
const UNKNOWN_POLLS = 5
const UNKNOWN_MS = 30_000
const identityUnknown = (pid: number) => `작업자 프로세스를 확인할 수 없어 멈췄어요 · 이전 작업자(pid ${pid})가 아직 돌 수 있어요`
export const TERMINAL_REQUEST = new Set(['merged', 'rejected', 'failed', 'cancelled', 'expired'])
const UNCOUNTED_PREV = new Set(['limited', 'transient', 'start_failed', 'brief_blocked'])
export const INTEGRATION_OPTIONS = ['다시 통합', '해당 작업 재작업', '요청 중단']
/** Extra integration option (wire value = label, like the other integration options): accept known base failures for one integration SHA. */
export const ACCEPT_KNOWN = '기존 실패로 인정하고 진행'
/** kv key of the acknowledgment an integration card offers: `{ sha, target, targetSha, items: [{ id, command }] }`. */
export const knownKey = (requestId: string, project: string) => `integration.known:${requestId}:${project}`
export interface KnownOffer { sha: string; target: string; targetSha: string; items: { id: string; command: string }[] }
export const LOGIN_CARD = 'system:login'

export const specOf = (t: TaskRow) => JSON.parse(t.spec) as PlanTask
export const nonManual = (t: PlanTask) => t.acceptance.filter((a) => a.check.trim() && a.check.trim() !== 'manual')
/** Acceptance items only a person (the reviewer) can judge: explicit `manual` checks (F03). */
export const manualIds = (t: PlanTask) => t.acceptance.filter((a) => !a.check.trim() || a.check.trim() === 'manual').map((a) => a.id)
/** Revise-turn questions are task questions whose attempt id carries this prefix (F16). */
export const REVISE_Q = 'ceo-revise:'
const JUDGE_ADDED = '사람 확인이 필요한 기준이 있어 검토를 추가해요 · sonnet'
const kindOf = (a: Acceptance) => (a.kind === 'new' ? 'new' : 'regression')

class Setup extends Error {}
/** A start path found its attempt cancelled or superseded after an await: stop without spawning (F08). */
class StartAborted extends Error {
  readonly outcome: 'cancelled' | 'superseded'
  constructor(outcome: 'cancelled' | 'superseded', why: string) { super(why); this.outcome = outcome }
}
/** A start path found an earlier worker of the task that may still run: nothing is spawned and the task waits. */
class StartWaiting extends Error {}
class DecisionRefused extends Error {}

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
  readonly teamNames: Record<string, string>
  readonly live = new Map<string, Live>()
  readonly launching = new Set<string>()
  readonly checking = new Set<string>()
  readonly integrating = new Set<string>()
  private revising = new Set<string>()
  private diagnosing = new Set<string>()
  private ticking = false
  private again = false
  private timer: NodeJS.Timeout | null = null
  private lastReconcile = 0
  private stopped = false
  private jobs = new Set<Promise<unknown>>()
  private current: Promise<void> | null = null
  lastViolations: Violation[] = []
  readonly probe: Probe
  /** Consecutive failures of keyed background jobs and when they may run again (this.now() clock). */
  private failures = new Map<string, { n: number; until: number }>()

  constructor(d: RunnerDeps) {
    this.store = d.store; this.bus = d.bus; this.cfg = d.cfg; this.projects = d.projects; this.hqRoot = d.hqRoot; this.hqPort = d.hqPort
    this.notify = d.notify; this.now = d.now; this.ceoLock = d.ceoLock ?? new TurnLock()
    this.teamNames = d.teamNames ?? {}
    this.probe = { ...defaultProbe, ...d.probe }
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
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.stopped = true }

  /**
   * Runs a background job and remembers it so shutdown (and tests) can wait for it. A keyed job that throws is not
   * retried at once: jobReady(key) stays false for 1s → 2s → … → 60s (reset on success), and after JOB_MAX_FAILURES
   * failures in a row `giveUp` stops its task.
   */
  private bg(p: Promise<unknown>, key?: string, giveUp?: (e: unknown) => void): void {
    const j = p.then(() => { if (key) this.failures.delete(key) }, (e) => {
      if (key) this.jobFailed(key, e, giveUp)
      else console.error('[hq runner] job', e)
    }).finally(() => { this.jobs.delete(j); this.kick() })
    this.jobs.add(j)
  }

  /** False while a keyed job is backing off after a failure. */
  jobReady(key: string): boolean {
    const f = this.failures.get(key)
    return !f || this.now() >= f.until
  }

  private jobFailed(key: string, e: unknown, giveUp?: (e: unknown) => void): void {
    const n = (this.failures.get(key)?.n ?? 0) + 1
    if (n >= JOB_MAX_FAILURES && giveUp) {
      console.error(`[hq runner] job ${key} failed ${n} times in a row, stopping it:`, e)
      this.failures.delete(key)
      try { giveUp(e) } catch (e2) { console.error(`[hq runner] job ${key} give-up`, e2) }
      return
    }
    const delay = Math.min(JOB_BACKOFF_MAX_MS, JOB_BACKOFF_MIN_MS * 2 ** (n - 1))
    this.failures.set(key, { n, until: this.now() + delay })
    console.error(`[hq runner] job ${key} failed (${n} in a row), retry in ${delay / 1000}s:`, e)
    setTimeout(() => this.kick(), delay).unref()
  }

  /** giveUp for a task's job: the task stops for the chairman (not while it is already stopped or finished). */
  private blockOnFailure(taskId: string, generation: number): (e: unknown) => void {
    return () => this.store.tx(() => {
      const t = this.store.task(taskId)
      if (t && t.generation === generation && !['blocked', 'passed', 'cancelled'].includes(t.status)) this.block(t, JOB_FAILING)
    })
  }

  /** Resolves when no background job and no tick is running. */
  async drain(): Promise<void> {
    while (this.jobs.size || this.current) await Promise.allSettled([...this.jobs, ...(this.current ? [this.current] : [])])
  }

  recover(): Promise<void> { return recoverState(this) }

  // ----- paths & helpers -----
  workDir(requestId: string, key: string): string { return join(this.home, 'work', requestId, key) }
  worktreeDir(requestId: string, name: string): string { return join(this.home, 'worktrees', requestId, name) }
  integrationDir(requestId: string, project: string): string { return this.worktreeDir(requestId, `_integration-${project}`) }
  runDir(requestId: string, key: string, attemptId: string): string { return join(this.home, 'runs', requestId, key, attemptId) }
  mirror(projectId: string): string { return mirrorPath(this.home, projectId) }
  project(id: string): Project | undefined { return this.projects.find((p) => p.id === id) }
  iso(): string { return new Date(this.now()).toISOString() }
  /** Mirror ref of a fetched work result. Git ref names cannot contain `~`, so the attempt id's suffix (a<n>) is used. */
  resultRef(t: TaskRow, attemptId: string): string { return `refs/hq/${t.request_id}/${t.key}/${attemptId.split('~').pop()}` }

  /** `projectId` names the mirror the worktree borrows objects from — the only part of $HQ_HOME it may read. */
  sandboxFor(worktree: string, out: string | null, projectId: string): SandboxOpts {
    return { worktree, out, hqHome: this.home, tokenDir: this.tokenDir, hqPort: this.hqPort, extraWritable: this.cfg.sandbox.extraWritable,
      projects: this.projects.map((p) => p.path), mirror: this.mirror(projectId), readable: codexBinReadable(this.cfg.codexBin) }
  }

  /**
   * Check/integration processes are recorded so a restart can kill leftover groups (§9) — only when pid + start time
   * still match (the start time is added as soon as ps answers; without it the group is never signalled).
   */
  procTracker(what: string): { onSpawn: OnSpawn; done: () => void } {
    const pids = new Set<number>()
    return {
      onSpawn: (pid) => {
        pids.add(pid)
        const row = { pid, what, startedAt: new Date().toISOString() }
        this.store.set(`proc:${pid}`, JSON.stringify(row))
        void Promise.resolve().then(() => this.probe.lstart(pid)).catch(() => null).then((lstart) => {
          if (lstart && pids.has(pid)) this.store.set(`proc:${pid}`, JSON.stringify({ ...row, lstart }))
        }).catch(() => { /* store closed */ })
      },
      done: () => { for (const p of pids) this.store.set(`proc:${p}`, null); pids.clear() },
    }
  }

  // ----- quota (§13) -----
  quota(): QuotaState {
    return quotaState(this.store.quotaRows(), this.cfg.quota, this.now(), { backoffUntil: this.store.get('limit.backoffUntil'), loginRequired: !!this.store.get('login.required') })
  }
  quotaView(): QuotaView | null { return quotaView(this.store.quotaRows(), this.quota(), this.now()) }
  holdUntil(): string | null { const q = this.quota(); return q.mode === 'hold' ? q.until : null }

  /** CEO turns (plan, revise, diagnosis): never on hold; in save/unobserved mode only when nothing else runs (§13). */
  canStartCeo(): boolean {
    const m = this.quota().mode
    return m !== 'hold' && (m === 'normal' || this.store.liveAttempts().length === 0)
  }

  /** Something the CEO should do before any worker in save/unobserved mode (§13 "CEO 턴이 우선"). */
  ceoWaiting(): boolean {
    if (this.store.nextQueued()) return true
    if (this.store.tasksByStatus(['revising']).some((t) => this.store.approval(`revise:${t.id}`)?.state !== 'open')) return true
    return this.store.tasksByStatus(['blocked']).some((t) => t.diagnosis === null)
  }

  observe(line: Record<string, unknown>): void {
    const before = this.quota().mode
    if (!recordRateLimit(this.store, line, this.now())) return
    if (rejectedWithoutReset(line)) this.limitBackoff()
    else if (isAllowedEvent(line)) this.store.set('limit.backoffLevel', null)
    const after = this.quota().mode
    if (after !== before) this.bus.emit({ kind: 'quota', text: `사용 한도 모드: ${after}`, data: { mode: after } })
  }

  /** A limit without a reset time: wait 15, then 30, then 60 minutes (timer, §13). */
  limitBackoff(): void {
    const cur = this.store.get('limit.backoffUntil')
    if (cur && Date.parse(cur) > this.now()) return
    const level = Number(this.store.get('limit.backoffLevel') ?? 0)
    const until = new Date(this.now() + BACKOFF_MIN[Math.min(level, BACKOFF_MIN.length - 1)] * 60_000).toISOString()
    this.store.set('limit.backoffUntil', until)
    this.store.set('limit.backoffLevel', String(level + 1))
    this.bus.emit({ kind: 'limit', text: `사용 한도 — ${until}까지 새 시작을 멈춰요` })
  }

  /** "Not logged in": one global hold and one system card instead of per-task failures (§13). */
  requireLogin(reason: string): void {
    if (this.store.get('login.required')) return
    this.store.tx(() => {
      this.store.set('login.required', this.iso())
      this.store.putApproval({ id: LOGIN_CARD, teamId: 'hq', subjectId: '', kind: 'system', title: 'Codex 로그인 필요', body: reason.slice(0, 500),
        options: ['다시 확인'], subjectHash: sha256(`login:${this.iso()}`) })
    })
    this.bus.emit({ kind: 'limit', text: 'Codex CLI 로그인이 필요해요 — 모든 시작을 멈췄어요' })
  }

  emitTask(t: { id: string; request_id: string }, text: string): void {
    this.bus.emit({ kind: 'task', text, data: { id: t.id, requestId: t.request_id, status: this.store.task(t.id)?.status } })
  }

  emitRequest(id: string, text: string): void {
    this.bus.emit({ kind: 'request', text, data: { id, state: this.store.request(id)?.status } })
  }

  failRequest(requestId: string, why: string): string {
    this.store.updateRequest(requestId, { status: 'failed', note: why })
    this.emitRequest(requestId, why)
    this.notify('요청 실행 실패', why)
    return why
  }

  // ----- chairman decisions (§D: card consumption and transition in one transaction) -----
  /**
   * Decides a card and applies its transition atomically. Replaying the same decision returns the same response.
   * Async work that cannot sit inside the transaction (git preparation, the merge itself) happens before or after it.
   */
  async decide(id: string, decision: string, subjectHash: string): Promise<DecideResult> {
    const a = this.store.approval(id)
    if (!a) return { status: 404, body: { error: '카드가 없습니다' } }
    const replayKey = `decided:${a.id}:${a.revision}`
    if (a.state === 'decided') {
      const prev = this.store.get(replayKey)
      if (a.decision === decision && a.subjectHash === subjectHash && prev) return JSON.parse(prev) as DecideResult
      return { status: 409, body: { error: '이미 결정된 카드입니다' } }
    }
    if (a.state !== 'open' || !a.options.includes(decision) || a.subjectHash !== subjectHash || Date.parse(a.expiresAt) <= this.now())
      return { status: 409, body: { error: '카드가 만료·교체됐거나, 내용이 바뀌었거나, 없는 선택지입니다' } }
    if (a.kind === 'accept' && decision === '반려') return { status: 409, body: { error: '사유와 함께 반려 버튼을 써 주세요' } }
    const requestId = a.subjectId ?? ''
    // Preparation outside the transaction: nothing here changes state.
    let prep: { heads: Map<string, string> } | { error: string } | null = null
    if (a.kind === 'plan' && decision === '승인') prep = await this.preparePlan(requestId)
    let first = false
    let res: DecideResult
    try {
      res = this.store.tx((): DecideResult => {
      const d = this.store.decide(id, decision, subjectHash, this.now())
      if (!d) {
        // A concurrent identical decision won the race: answer with its recorded response.
        const cur = this.store.approval(id)
        const prev = cur ? this.store.get(`decided:${cur.id}:${cur.revision}`) : null
        if (cur?.state === 'decided' && cur.decision === decision && cur.subjectHash === subjectHash && prev) return JSON.parse(prev) as DecideResult
        return { status: 409, body: { error: '카드를 방금 다른 곳에서 결정했거나 내용이 바뀌었습니다' } }
      }
      const err = this.applyDecision(d, decision, prep)
      if (err) throw new DecisionRefused(err) // roll back the card consumption as well
      const ok: DecideResult = { status: 200, body: { ...d, note: null } }
      this.store.set(replayKey, JSON.stringify(ok))
      first = true
      return ok
      })
    } catch (e) {
      if (e instanceof DecisionRefused) return { status: 409, body: { error: e.message } }
      throw e
    }
    if (first && a.kind === 'merge' && decision === '병합') {
      const [, req, project] = a.id.split(':')
      res.body.note = await this.runMerge(req, project)
      this.store.set(replayKey, JSON.stringify(res))
    }
    if (first) {
      this.bus.emit({ kind: 'approval', teamId: a.teamId, text: `결정: ${a.title} → ${decision}`, data: { id } })
      this.kick()
    }
    return res
  }

  /** Transition for a just-consumed card. Call inside the decide transaction. Returns a Korean reason on refusal. */
  private applyDecision(a: ApprovalRow, decision: string, prep: { heads: Map<string, string> } | { error: string } | null): string | null {
    const requestId = a.subjectId ?? ''
    switch (a.kind) {
      case 'system':
        this.store.set('login.required', null)
        return null
      case 'plan':
        if (decision !== '승인') { this.store.updateRequest(requestId, { status: 'rejected', note: '계획 반려' }); return null }
        if (!prep || 'error' in prep) { this.store.updateRequest(requestId, { status: 'failed', note: prep && 'error' in prep ? prep.error : '계획 준비 실패' }); return null }
        return this.createTasksTx(requestId, prep.heads)
      case 'accept':
        return this.acceptTx(requestId)
      case 'merge': {
        const [, req, project] = a.id.split(':')
        const m = this.store.mergeRow(req, project)
        if (!m || m.state !== 'offered') return '병합할 수 있는 상태가 아닙니다'
        if (decision === '보류') { this.store.putMerge(req, project, { state: 'held' }); return null }
        if (this.store.request(req)?.status !== 'accepted') return '수락된 요청이 아닙니다'
        this.store.updateRequest(req, { status: 'merging' })
        this.store.putMerge(req, project, { state: 'merging' }) // intent: expected result = integration_sha (recovery checks HEAD)
        return null
      }
      case 'integration': {
        const [, req, project] = a.id.split(':')
        return this.integrationDecidedTx(req, project, decision)
      }
      case 'revise': {
        const taskId = a.id.slice('revise:'.length)
        const raw = this.store.get(`revise:${taskId}`)
        if (decision === '승인' && raw) return this.applyRevision(taskId, JSON.parse(raw) as PlanTask)
        const t = this.store.task(taskId)
        if (t?.status === 'revising') this.block(t, '회장이 지시서 수정안을 반려했어요')
        return null
      }
      default:
        return null
    }
  }

  // ----- plan approval (§D createTasks) -----
  /** Git-side preparation of a plan approval: every project must be a git repo; mirrors are fetched; base = project HEAD. */
  async preparePlan(requestId: string): Promise<{ heads: Map<string, string> } | { error: string }> {
    const r = this.store.request(requestId)
    if (!r?.plan) return { error: '계획이 없는 요청입니다' }
    const plan = JSON.parse(r.plan) as CeoPlan
    const problem = validateTasks(plan.tasks, this.projects)
    if (problem) return { error: `계획 검증 실패: ${problem}` }
    const heads = new Map<string, string>()
    for (const pid of new Set(plan.tasks.map((t) => t.project))) {
      const p = this.project(pid)!
      if (!(await isRepo(p.path))) return { error: `프로젝트 ${p.name}(${p.path})가 커밋이 있는 git 저장소가 아니라서 실행할 수 없어요` }
      const head = (await revParse(p.path))!
      try { await ensureMirror(p, this.mirror(pid)) } catch (e) { return { error: `프로젝트 ${p.name}의 hq 미러를 만들지 못했어요: ${String(e).slice(0, 200)}` } }
      if (!(await mirrorRev(this.mirror(pid), head))) return { error: `프로젝트 ${p.name}의 HEAD를 미러에서 찾을 수 없어요` }
      heads.set(pid, head)
    }
    return { heads }
  }

  /** Creates task rows and moves the request to executing. Call inside a transaction. */
  private createTasksTx(requestId: string, heads: Map<string, string>): string | null {
    const cur = this.store.request(requestId)
    if (!cur?.plan || !['planned', 'approved'].includes(cur.status)) return '요청이 계획 승인 상태가 아닙니다'
    if (this.store.tasks(requestId).length) return null
    const plan = JSON.parse(cur.plan) as CeoPlan
    for (const t of plan.tasks) this.store.insertTask({ id: `${requestId}.${t.id}`, request_id: requestId, key: t.id, project: t.project, title: t.title,
      role: t.role, grade: t.grade, model: t.model, review_model: reviewModelOf(t), spec: JSON.stringify(t), status: 'pending', branch: null, base_sha: heads.get(t.project)! })
    for (const [pid, sha] of heads) this.store.set(`base:${requestId}:${pid}`, sha)
    this.store.updateRequest(requestId, { status: 'executing', note: null })
    this.emitRequest(requestId, `실행 시작: 작업 ${plan.tasks.length}개`)
    return null
  }

  /** Programmatic plan approval (tests, CLI): same path as the card. */
  async createTasks(requestId: string): Promise<string | null> {
    const prep = await this.preparePlan(requestId)
    if ('error' in prep) return this.failRequest(requestId, prep.error)
    const err = this.store.tx(() => this.createTasksTx(requestId, prep.heads))
    this.kick()
    return err
  }

  // ----- tick (§C order) -----
  kick(): void { void this.tick() }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.ticking) { this.again = true; return this.current ?? Promise.resolve() }
    this.current = this.runTick().finally(() => { this.current = null })
    return this.current
  }

  private async runTick(): Promise<void> {
    this.ticking = true
    try {
      do {
        this.again = false
        if (this.stopped) break
        await this.step('live', () => this.pollLive())
        await this.step('lingering', () => this.checkLingering())
        await this.step('verify', () => this.startVerifications())
        await this.step('integrate', () => this.startIntegrations())
        await this.step('dispatch', () => this.dispatch())
        await this.step('complete', () => this.completeRequests())
        await this.step('revise', () => this.reviseOne())
        await this.step('diagnose', () => this.diagnoseOne())
        await this.step('notify', () => this.notifyDecisions())
        // The reconciler runs inside the same tick lock (§5).
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
  /** `spawned`: the child and its exit watch from launch() (exit observed since spawn, F09); null for recovered processes. */
  track(att: AttemptRow, pid: number, lstart: string | null, startedAt: string | null, spawned: { child: ChildProcess; exit: ExitWatch } | null): Live {
    const l: Live = { tail: new StreamTail(hqDirOf(att)), pid, lstart, startedAt, child: spawned?.child ?? null, exit: spawned?.exit ?? null,
      exited: false, killAt: null, killed9: false, confirmed: !!spawned, unknownPolls: 0, unknownSince: null }
    if (spawned) spawned.exit.onExit(() => { l.exited = true; this.kick() })
    this.live.set(att.id, l)
    return l
  }

  /**
   * Identity of a tracked worker (§7, §22). A child of this daemon that has not exited is `same` (its pid cannot be
   * reused before it is reaped); one that has exited is `gone`. A recovered process is probed by pid + start time.
   */
  private async identityOf(l: Live): Promise<Identity> {
    if (l.child) {
      const running = !l.exited && !l.exit?.exited && l.child.exitCode === null && l.child.signalCode === null
      return running ? 'same' : 'gone'
    }
    return identify(l.pid, l.lstart, this.probe.lstart)
  }

  private wallMs(t: TaskRow | null): number {
    return (this.cfg.attemptWallMinutes[(t?.grade ?? 'L1') as keyof HqConfig['attemptWallMinutes']] ?? 45) * 60_000
  }

  /** Time already spent by earlier work attempts of this generation (resume included), for the 3× cap (§13). */
  private spentMs(t: TaskRow, exclude: string): number {
    return this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.id !== exclude && a.generation === t.generation && a.started_at && a.ended_at)
      .reduce((s, a) => s + Math.max(0, Date.parse(a.ended_at!) - Date.parse(a.started_at!)), 0)
  }

  private async pollLive(): Promise<void> {
    for (const att of this.store.liveAttempts()) {
      if (this.launching.has(att.id)) continue
      const l = this.live.get(att.id)
      if (!l) continue // not adopted (reconcile reports it)
      const task = this.store.task(att.task_id)
      l.tail.poll((line, s) => {
        if (s.sessionId && s.sessionId !== att.session_id) { this.store.updateAttempt(att.id, { session_id: s.sessionId }); att.session_id = s.sessionId }
        if (s.rateLimit) this.observe(line)
      })
      const id = await this.identityOf(l)
      if (id === 'same') { l.confirmed = true; l.unknownPolls = 0; l.unknownSince = null }
      if (id === 'unknown') {
        // Cannot tell whether the pid is still our worker: never signal it. Finished evidence (a result line) is judged;
        // otherwise, once `unknown` has lasted UNKNOWN_POLLS polls and UNKNOWN_MS, the task stops for the chairman (§22).
        l.tail.poll((line, s) => { if (s.rateLimit) this.observe(line) })
        if (!l.tail.finalResult()) {
          l.unknownPolls++
          l.unknownSince ??= this.now()
          if (l.unknownPolls >= UNKNOWN_POLLS && this.now() - l.unknownSince >= UNKNOWN_MS) this.stopUnknown(att, l)
          continue
        }
      }
      if (id === 'same') {
        const now = this.now()
        const wall = this.wallMs(task)
        const elapsed = now - Date.parse(att.started_at ?? new Date(now).toISOString())
        const total = att.kind === 'work' && task ? this.spentMs(task, att.id) + elapsed : elapsed
        if (!att.outcome && (elapsed > wall || total > 3 * wall || l.tail.sameErrorCount >= 3 || l.tail.toolCount > this.cfg.maxTurns)) {
          const why = elapsed > wall ? `시간 초과 (${Math.round(elapsed / 60_000)}분 > ${wall / 60_000}분)`
            : total > 3 * wall ? `작업 누적 시간 초과 (${Math.round(total / 60_000)}분 > ${3 * wall / 60_000}분)` : l.tail.toolCount > this.cfg.maxTurns ? `도구 실행 상한 (${this.cfg.maxTurns}) 초과` : `같은 도구 오류 3회 연속: ${l.tail.lastActivity ?? ''}`
          this.store.updateAttempt(att.id, { outcome: 'runaway', reason: why })
          att.outcome = 'runaway'
          this.bus.emit({ kind: 'attempt', text: `폭주 감시: ${why}`, data: { id: att.id } })
        }
        if (att.outcome === 'runaway' || att.outcome === 'cancelled' || att.outcome === 'superseded') {
          // Identity was confirmed just above on this tick, so each signal (the later SIGKILL included) is re-checked.
          if (l.killAt === null) { killGroup(l.pid, 'SIGTERM'); l.killAt = Date.now() }
          else if (!l.killed9 && Date.now() - l.killAt >= KILL_GRACE_MS) { killGroup(l.pid, 'SIGKILL'); l.killed9 = true }
        }
        continue
      }
      l.tail.poll((line, s) => { if (s.rateLimit) this.observe(line) })
      this.live.delete(att.id)
      // Background processes the worker left behind (§7.4): only a group this daemon saw as ours whose leader is now gone.
      // A reused pid (`other`) or an unknown identity is never signalled.
      if (id === 'gone' && l.confirmed) void terminateGroup(l.pid, l.lstart, KILL_GRACE_MS, this.probe)
      const cacheDir = readProcessInfo(hqDirOf(att))?.cacheDir // per-launch package cache (§6.2), gone with the group
      setTimeout(() => removeCacheDir(cacheDir), KILL_GRACE_MS + 1_000).unref()
      const fresh = this.store.attempt(att.id)!
      try {
        if (fresh.kind === 'review') await this.finalizeReview(fresh, l)
        else await this.finalizeWork(fresh, l)
      } catch (e) {
        console.error('[hq runner] finalize', e)
        this.store.tx(() => {
          this.store.updateAttempt(att.id, { status: 'unverifiable', ended_at: this.iso(), reason: `판정 중 오류: ${String(e).slice(0, 300)}` })
          const t = this.store.task(att.task_id)
          if (t && t.generation === fresh.generation && ['running', 'reviewing'].includes(t.status)) this.block(t, `판정 중 오류: ${String(e).slice(0, 300)}`)
        })
      }
    }
  }

  /**
   * The worker's identity stayed unconfirmable and it left no result: stop tracking it without a signal, the task stops.
   * The process may still run, so the task remembers it (lingering) and no new attempt of the task starts until it is gone.
   */
  private stopUnknown(att: AttemptRow, l: Live): void {
    this.live.delete(att.id)
    const why = identityUnknown(l.pid)
    this.store.tx(() => {
      this.store.updateAttempt(att.id, { status: 'unverifiable', ended_at: this.iso(), reason: why })
      const t = this.store.task(att.task_id)
      if (!t) return
      const rec: Lingering = { pid: l.pid, lstart: l.lstart, since: this.iso() }
      this.store.updateTask(t.id, { lingering: JSON.stringify(rec) })
      if (t.generation === att.generation && ['running', 'reviewing'].includes(t.status)) this.block(t, why)
    })
    this.bus.emit({ kind: 'attempt', text: why, data: { id: att.id } })
  }

  /**
   * Each poll: a lingering earlier worker whose pid is gone (kill(pid, 0) → ESRCH), or whose pid now belongs to another
   * process (recorded start time differs), is forgotten and its task may start again. Nothing is ever signalled here.
   */
  private async checkLingering(): Promise<void> {
    for (const t of this.store.lingeringTasks()) {
      const l = lingeringOf(t)
      let gone = !l || !pidAlive(l.pid)
      if (!gone && l!.lstart) gone = ['gone', 'other'].includes(await identify(l!.pid, l!.lstart, this.probe.lstart))
      if (!gone) { await this.lookAtLingering(t, l!); continue }
      if (!this.store.tx(() => {
        const cur = this.store.task(t.id); if (cur?.lingering !== t.lingering) return false
        this.store.updateTask(t.id, { lingering: null }); this.store.set(lingeringPsKey(t.id), null); return true
      })) continue
      this.emitTask(t, `이전 작업자(pid ${l?.pid ?? '?'})가 끝났어요: ${t.title}`)
    }
  }

  /**
   * The blocked card shows what the lingering pid is now (`ps` line) and offers `kill` only when that line looks like
   * this task's worker (Codex binary + its worktree or one of its attempt sessions). Read-only: nothing is signalled.
   */
  private async lookAtLingering(t: TaskRow, l: Lingering): Promise<void> {
    let ps: string | null = null
    try { ps = await (this.probe.info ?? psInfo)(l.pid) } catch { ps = null }
    const sessions = this.store.attempts(t.id).filter((a) => a.pid === l.pid || !a.pid).map((a) => a.session_id)
    const ours = ps !== null && looksLikeWorker(ps, { bin: basename(this.cfg.codexBin), paths: t.worktree ? [t.worktree] : [], sessions })
    const rec: LingeringPs = { lingering: t.lingering!, ps: ps?.slice(0, 2000) ?? null, ours }
    const v = JSON.stringify(rec)
    this.store.tx(() => { if (this.store.task(t.id)?.lingering === t.lingering && this.store.get(lingeringPsKey(t.id)) !== v) this.store.set(lingeringPsKey(t.id), v) })
  }

  private usage(result: Record<string, unknown> | null) {
    const u = (result?.usage ?? {}) as Record<string, unknown>
    return {
      cost_usd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
      input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
      output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
    }
  }

  /** The attempt's result may change the task only while the task is still in the attempt's generation (§7.7). */
  private stale(att: AttemptRow, t: TaskRow): boolean {
    const r = this.store.request(t.request_id)
    return t.generation !== att.generation || !r || r.status === 'cancelled' || t.status === 'cancelled' || ['cancelled', 'superseded'].includes(att.outcome ?? '')
  }

  /** Generation-guarded task update (the SQL carries `where generation = ?`). */
  private tset(t: TaskRow, f: Parameters<Store['updateTask']>[1]): boolean { return this.store.updateTaskIf(t.id, t.generation, f) }

  // ----- work attempt judgement (§8, §C table) -----
  async finalizeWork(att: AttemptRow, l: Live): Promise<void> {
    const task = this.store.task(att.task_id)!
    const result = l.tail.finalResult()
    const endedAt = this.iso()
    const role = task.role === 'collect' ? 'collect' : 'implement'
    const collectWt = role === 'collect' ? this.worktreeDir(task.request_id, `${task.key}.c${att.n}`) : null
    if (this.stale(att, task)) {
      this.store.updateAttempt(att.id, { status: 'failed', ended_at: endedAt, reason: att.outcome === 'cancelled' ? '요청 중단' : '세대가 바뀌어 결과를 반영하지 않음', ...this.usage(result) })
      if (collectWt) await removeMirrorWorktree(this.mirror(task.project), collectWt).catch(() => {})
      return
    }
    const spec = specOf(task)
    const out = outDirOf(att), hq = hqDirOf(att)
    const mirror = this.mirror(task.project)
    const report = readOut(out, 'report.md', REPORT_MAX)
    let git: GitFacts | null = null
    let fetched: string | null = null
    let fetchError: string | null = null
    if (role === 'implement' && task.worktree && task.base_sha) {
      const f = await fetchWork(mirror, task.worktree, this.resultRef(task, att.id))
      fetched = f.sha; fetchError = f.error
      git = await mirrorFacts(mirror, task.base_sha, fetched)
    } else if (collectWt && task.base_sha && existsSync(collectWt)) {
      const wt = { path: collectWt, gitDir: join(mirror, 'worktrees', `${task.key}.c${att.n}`), mirror }
      const head = (await wtGit(wt, ['rev-parse', 'HEAD'])).stdout.trim() || null
      git = { head, changed: [], status: head ? await wtStatus(wt).catch(() => '?') : '', baseIsAncestor: true, hasMerges: false }
      await removeMirrorWorktree(mirror, collectWt).catch(() => {})
    }
    const stderr = (readText(join(hq, 'stderr.log'), 200_000) ?? '').slice(-20_000)
    const j = judgeWork({
      role, token: att.attempt_token, owns: spec.owns, protectedPaths: this.cfg.protectedPaths, base: task.base_sha ?? '',
      runaway: att.outcome === 'runaway', result, stderr, rejectedSeen: l.tail.rejectedSeen,
      doneRaw: readOut(out, 'done.json', DONE_MAX), report, git,
    })
    // The fetch's own reason (e.g. the object check refused the result) says more than "could not fetch".
    if (fetchError && j.outcome === 'failed' && !git?.head) j.reasons = [fetchError]
    const reason = j.reasons.join('\n') || null
    // changedFiles: counted from the mirror diff base..head (hq's fact), not from the worker's done.json (F3).
    atomicJson(join(hq, 'result.json'), { outcome: j.outcome, reasons: j.reasons, summary: j.done?.summary ?? null, fetched, protectedChanges: j.protectedChanges,
      changedFiles: role === 'implement' ? git?.changed.length ?? null : 0, at: endedAt })
    if (j.outcome === 'succeeded' && role === 'collect' && report !== null) atomicWrite(join(hq, 'report.sealed.md'), report)
    if (j.login) this.requireLogin(String(result?.result ?? stderr).slice(0, 300))
    else if (j.outcome === 'limited' && this.quota().mode !== 'hold') this.limitBackoff()
    const status: WorkOutcome = j.outcome
    this.store.tx(() => {
      this.store.updateAttempt(att.id, { status, ended_at: endedAt, reason: att.outcome === 'runaway' ? att.reason : reason, ...this.usage(result),
        ...(att.outcome ? {} : { outcome: j.done?.outcome ?? j.outcome }) })
      const t = this.store.task(att.task_id)!
      if (t.status !== 'running' || t.generation !== att.generation) return
      switch (j.outcome) {
        case 'succeeded': {
          // A person-judged criterion needs a judge: with no reviewer, add a sonnet review (F03); protected paths likewise (§3).
          const needsJudge = t.review_model === 'none' && manualIds(spec).length > 0
          const reviewModel = t.review_model === 'none' && (j.protectedChanges.length || needsJudge) ? 'sonnet' : t.review_model
          const sha = report === null ? null : sha256(report)
          if (role === 'collect') this.tset(t, { status: reviewModel === 'none' ? 'passed' : 'reviewing', head_sha: t.base_sha, report_sha: sha, review_model: reviewModel, limited_streak: 0, review_invalid: 0, note: null })
          else this.tset(t, { status: 'verifying', head_sha: j.done!.head_sha, report_sha: sha, review_model: reviewModel, limited_streak: 0, review_invalid: 0, checks_state: null, note: null })
          if (needsJudge) this.emitTask(t, JUDGE_ADDED)
          break
        }
        case 'brief_blocked':
          if (t.revise_turns >= MAX_REVISE_TURNS) this.block(t, `지시서를 ${t.revise_turns}번 고쳤는데도 작업자가 멈췄어요: ${reason}`)
          else this.tset(t, { status: 'revising', note: reason })
          break
        case 'question': {
          const rounds = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'question' && a.generation === t.generation).length
          if (rounds > MAX_QUESTION_ROUNDS) { this.block(t, `작업자 질문이 ${MAX_QUESTION_ROUNDS}라운드를 넘었어요`); break }
          this.store.addTaskQuestions(t.id, att.id, t.revision, j.done!.questions.map((q) => ({ id: 'tq-' + randomUUID().slice(0, 8), ...q })))
          this.tset(t, { status: 'question', resume_session: att.session_id, note: j.done!.summary || null })
          break
        }
        case 'limited': {
          if (j.login) { this.tset(t, { status: 'held', resume_session: att.session_id, note: 'Codex 로그인 필요' }); break }
          const streak = t.limited_streak + 1
          if (streak >= MAX_LIMITED_STREAK) { this.tset(t, { limited_streak: streak }); this.block(this.store.task(t.id)!, `사용 한도로 ${streak}번 연속 중단됐어요`) }
          else this.tset(t, { status: 'held', limited_streak: streak, resume_session: att.session_id, note: '사용 한도로 보류' })
          break
        }
        case 'transient': {
          const prev = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.id !== att.id).at(-1)
          if (prev?.status === 'transient') this.rework(t, `일시 오류가 2번 연속: ${reason}`)
          else this.tset(t, { status: 'pending', note: reason })
          break
        }
        case 'unverifiable': {
          // §8.4: one automatic retry for a format mistake by a worker that ran to the end.
          const prev = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.id !== att.id && a.generation === t.generation).at(-1)
          if (result && prev?.status !== 'unverifiable') this.rework(t, `형식 실수, 자동 재시도 1회: ${reason}`, true)
          else this.block(t, `완료를 확인할 수 없어요: ${reason}`)
          break
        }
        default: // failed, runaway
          this.rework(t, j.outcome === 'runaway' ? `폭주로 중단: ${att.reason ?? ''}` : reason ?? '실패')
      }
      this.emitTask(t, `${t.title}: 시도 판정 ${j.outcome}`)
    })
  }

  /** §C rework(): another attempt, or blocked after maxAttempts. A task that had passed invalidates its dependents. Call inside a tx. */
  rework(t: TaskRow, reason: string, sameModel = false): void {
    const cur = this.store.task(t.id)!
    const wasPassed = cur.status === 'passed'
    if (cur.attempts >= this.cfg.maxAttempts) this.block(cur, `${cur.attempts}번 실패했어요: ${reason}`)
    else this.tset(cur, { status: 'rework', note: reason.slice(0, 2000), model: !sameModel && cur.attempts + 1 >= 3 ? ladderUp(this.cfg.ladder, cur.model) : cur.model })
    if (wasPassed) this.invalidateDependents(cur)
  }

  /** Circuit break: the chairman decides (§9). The decision revision is the per-task block count. Call inside a tx. */
  block(t: TaskRow, reason: string): void {
    const cur = this.store.task(t.id)!
    this.store.updateTask(t.id, { status: 'blocked', note: reason.slice(0, 2000), diagnosis: null, block_count: cur.block_count + 1 })
    const r = this.store.request(t.request_id)
    if (r && r.status === 'executing') this.store.updateRequest(r.id, { status: 'blocked', note: `작업 ${t.title} 판단 필요` })
    this.emitTask(t, `작업 막힘: ${t.title}`)
  }

  /** Transitive dependents of a task within its request. */
  private dependents(t: TaskRow): TaskRow[] {
    const all = this.store.tasks(t.request_id)
    const gone = new Set<string>([t.key])
    for (let changed = true; changed;) {
      changed = false
      for (const x of all) if (!gone.has(x.key) && specOf(x).depends_on.some((d) => gone.has(d))) { gone.add(x.key); changed = true }
    }
    return all.filter((x) => x.id !== t.id && gone.has(x.key))
  }

  /**
   * Starts a task over (§11): generation+1, live attempts ended, pending, attempts 0, clone discarded (mirror refs are kept),
   * questions/session/base/verification/review dropped. Call inside a tx.
   */
  resetTask(d: TaskRow, note: string, base: string | null = null): void {
    const all = this.store.tasks(d.request_id)
    for (const a of this.store.liveAttempts()) if (a.task_id === d.id) {
      this.store.updateAttempt(a.id, { outcome: 'superseded' })
    }
    // The tick signals superseded workers after confirming their identity (pollLive); a starting one never spawns (F08).
    queueMicrotask(() => this.kick())
    const sameProjectDep = specOf(d).depends_on.some((k) => { const x = all.find((y) => y.key === k); return x?.project === d.project && x.role === 'implement' })
    const requestBase = this.store.get(`base:${d.request_id}:${d.project}`) ?? d.base_sha
    this.store.updateTask(d.id, { generation: d.generation + 1, status: 'pending', attempts: 0, head_sha: null, worktree: null,
      base_sha: base ?? (sameProjectDep ? null : requestBase), limited_streak: 0, review_invalid: 0, resume_session: null, checks_state: null, report_sha: null, note })
    if (d.worktree) { const path = d.worktree; queueMicrotask(() => rmSync(path, { recursive: true, force: true })) }
  }

  /** §11: every transitive dependent of a changed result (code head or collect report) starts over. Call inside a tx. */
  invalidateDependents(t: TaskRow): void {
    for (const d of this.dependents(t)) if (d.status !== 'cancelled') this.resetTask(d, `선행 작업 ${t.key}의 결과가 바뀌어 처음부터 다시 해요`)
    this.store.supersede(`accept:${t.request_id}`)
  }

  // ----- dispatch (§C 배정, §13) -----
  depsPassed(t: TaskRow, all: TaskRow[]): boolean {
    return specOf(t).depends_on.every((d) => all.find((x) => x.key === d)?.status === 'passed')
  }

  /** Tasks that could start now if there were a free slot (for the headline and the invariant check). */
  readyTasks(): TaskRow[] {
    const out: TaskRow[] = []
    for (const r of this.store.requestsByStatus(['executing'])) {
      const all = this.store.tasks(r.id)
      // A task whose earlier worker may still run waits for it (not for a slot): it is not ready.
      for (const t of all) if (['pending', 'rework', 'held'].includes(t.status) && !t.lingering && this.depsPassed(t, all)) out.push(t)
    }
    return out
  }

  private async dispatch(): Promise<void> {
    const q = this.quota()
    if (q.mode === 'hold') return
    const single = q.mode === 'save' || q.mode === 'unobserved'
    // save / unobserved: one process in total, and the CEO goes first (§13).
    if (single && (this.ceoLock.busy || this.ceoWaiting())) return
    let free = (single ? 1 : this.cfg.maxWorkers) - this.store.liveAttempts().length
    for (const t of this.store.tasksByStatus(['reviewing'])) {
      if (free <= 0) return
      const r = this.store.request(t.request_id)
      if (!r || !['executing', 'blocked'].includes(r.status)) continue
      if (this.store.liveAttempts().some((a) => a.task_id === t.id) || t.lingering) continue
      if (this.claimReview(t)) free--
    }
    for (const t of this.readyTasks()) {
      if (free <= 0) return
      if (this.claimWork(t)) free--
    }
  }

  // ----- work attempts (§7 start protocol) -----
  private claimWork(t: TaskRow): boolean {
    const { prev, counted } = this.workCounting(t)
    const resume = t.resume_session
    const n = this.store.nextAttemptN(t.id, 'work')
    const id = `${t.id}~a${n}`
    const claimed = this.store.tx(() => {
      const cur = this.store.task(t.id)!
      if (!['pending', 'rework', 'held'].includes(cur.status) || cur.generation !== t.generation || cur.lingering) return false
      this.store.insertAttempt({ id, task_id: t.id, kind: 'work', n, model: cur.model, status: 'starting', attempt_token: randomBytes(16).toString('hex'),
        dir: this.runDir(t.request_id, t.key, id), session_id: resume ?? randomUUID(), generation: cur.generation })
      this.tset(cur, { status: 'running', attempts: cur.attempts + (counted ? 1 : 0) })
      return true
    })
    if (!claimed) return false
    this.launching.add(id)
    this.bg(this.prepareAndLaunch(id, !!resume, prev ?? null).finally(() => this.launching.delete(id)))
    this.emitTask(t, `${t.title} 시작 · ${t.model}`)
    return true
  }

  /**
   * The previous work attempt (a start that waited for an earlier worker does not count as one) and whether the next
   * attempt is counted: the previous attempt decides even across a revision (a brief_blocked restart is never counted).
   */
  private workCounting(t: TaskRow): { prev: AttemptRow | undefined; counted: boolean } {
    const prev = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.outcome !== 'waiting').at(-1)
    return { prev, counted: !t.resume_session && !(prev && UNCOUNTED_PREV.has(prev.status)) }
  }

  private depHeads(t: TaskRow): TaskRow[] {
    const all = this.store.tasks(t.request_id)
    return specOf(t).depends_on.map((k) => all.find((x) => x.key === k)!).filter((d) => d && d.project === t.project && d.role === 'implement' && d.head_sha)
  }

  private upstream(t: TaskRow): Upstream[] {
    const all = this.store.tasks(t.request_id)
    return specOf(t).depends_on.map((k) => all.find((x) => x.key === k)!).filter((d) => d && d.status === 'passed').map((d) => {
      const work = this.store.attempts(d.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
      const sealed = work && d.role === 'collect' ? readText(join(hqDirOf(work), 'report.sealed.md'), 200_000) : null
      return { key: d.key, title: d.title, project: d.project, headSha: d.role === 'implement' ? d.head_sha : null, reportSha: d.report_sha, report: sealed }
    })
  }

  /** Base of a task (§11): request base, one same-project dependency head, or hq's --no-ff merge of several (in a mirror worktree). */
  private async resolveBase(t: TaskRow): Promise<string> {
    const deps = this.depHeads(t)
    if (!deps.length) return t.base_sha ?? this.store.get(`base:${t.request_id}:${t.project}`)!
    if (deps.length === 1) return deps[0].head_sha!
    const mirror = this.mirror(t.project)
    const wt = await verifyWorktree(mirror, this.worktreeDir(t.request_id, `${t.key}.base`), deps[0].head_sha!)
    try {
      const m = await withRepo(mirror, () => wtMerge(wt, deps.slice(1).map((d) => d.head_sha!), `hq: ${t.key}의 선행 작업 합치기 (${deps.map((d) => d.key).join(', ')})`))
      if (!m.ok) throw new Setup(`선행 작업(${deps.map((d) => d.key).join(', ')})의 결과를 합치다 충돌: ${m.files.join(', ')}`)
      await withRepo(mirror, () => hqGitOk(mirror, null, ['update-ref', `refs/hq/${t.request_id}/${t.key}/base-g${t.generation}`, m.sha]))
      return m.sha
    } finally { await removeMirrorWorktree(mirror, wt.path).catch(() => {}) }
  }

  /** `gate` (start paths): asked right before the setup process is spawned; it throws to stop. */
  private async runSetup(project: Project, wt: string, hq: string, name: string, gate?: () => void): Promise<void> {
    if (!project.setup) return
    gate?.()
    const prof = join(hq, `${name}.sb`)
    atomicWrite(prof, sandboxProfile(this.sandboxFor(wt, null, project.id)))
    const p = this.procTracker(name)
    try {
      const s = await runSandboxed(project.setup, wt, this.cfg.checkTimeoutMinutes * 60_000, prof, 'setup', p.onSpawn)
      atomicJson(join(hq, `${name}.json`), s)
      if (!s.pass) throw new Setup(`setup 명령 실패 (종료 코드 ${s.exitCode ?? '시간 초과'}): ${s.outputTail.split('\n').slice(-5).join(' ').slice(0, 300)}`)
    } finally { p.done() }
  }

  /**
   * Why a starting attempt must not go on (F08), or null: its request was cancelled or finished, the task's generation
   * changed or the task left `taskStatus`, or the attempt is no longer `starting` / got an outcome (cancelled, superseded).
   */
  private startBlocker(attemptId: string, taskStatus: string): StartAborted | StartWaiting | null {
    const a = this.store.attempt(attemptId)
    const t = a ? this.store.task(a.task_id) : null
    const r = t ? this.store.request(t.request_id) : null
    if (!a || !t || !r || r.status === 'cancelled' || a.outcome === 'cancelled' || t.status === 'cancelled') return new StartAborted('cancelled', '요청 중단')
    if (TERMINAL_REQUEST.has(r.status) || r.status === 'merging' || t.generation !== a.generation || t.status !== taskStatus
      || a.status !== 'starting' || a.outcome) return new StartAborted('superseded', '세대가 바뀌어 시작하지 않음')
    // An earlier worker of this task may still run (its identity could not be confirmed): never two in one task.
    const ling = lingeringOf(t)
    if (ling) return new StartWaiting(lingeringWait(ling.pid))
    return null
  }

  /** Throws StartAborted when the attempt must not start any more; call after every await and before each spawn. */
  private gate(attemptId: string, taskStatus: string): void {
    const b = this.startBlocker(attemptId, taskStatus)
    if (b) throw b
  }

  /**
   * A start that met a lingering earlier worker: nothing was spawned, the attempt ends as `waiting` (it is not a try and
   * does not count), and a work task goes back to the queue, where it waits until the earlier worker is gone.
   */
  private startWaiting(att: AttemptRow, e: StartWaiting): void {
    this.store.tx(() => {
      this.store.updateAttempt(att.id, { status: 'start_failed', outcome: 'waiting', ended_at: this.iso(), reason: e.message })
      const t = this.store.task(att.task_id)
      if (att.kind !== 'work' || !t || t.generation !== att.generation || t.status !== 'running') return
      this.tset(t, { status: 'rework', attempts: t.attempts - (this.workCounting(t).counted ? 1 : 0) })
    })
    this.bus.emit({ kind: 'attempt', text: e.message, data: { id: att.id } })
  }

  /** Records an aborted start: nothing was spawned, the attempt ends with its cancel/supersede outcome (task untouched). */
  private startAborted(att: AttemptRow, e: StartAborted): void {
    this.store.updateAttempt(att.id, { status: 'failed', outcome: e.outcome, ended_at: this.iso(), reason: e.message })
    this.bus.emit({ kind: 'attempt', text: e.message, data: { id: att.id } })
  }

  private async prepareAndLaunch(attemptId: string, resume: boolean, prev: AttemptRow | null): Promise<void> {
    const att = this.store.attempt(attemptId)!
    let t = this.store.task(att.task_id)!
    const project = this.project(t.project)
    const hq = hqDirOf(att), out = outDirOf(att)
    const gate = () => this.gate(attemptId, 'running')
    const collectWt = t.role === 'collect' ? this.worktreeDir(t.request_id, `${t.key}.c${att.n}`) : null
    try {
      if (!project) throw new Setup(`등록되지 않은 프로젝트: ${t.project}`)
      mkdirSync(hq, { recursive: true }); mkdirSync(out, { recursive: true })
      const mirror = this.mirror(t.project)
      if (!existsSync(join(mirror, 'HEAD'))) { await ensureMirror(project, mirror); gate() }
      let cwd: string
      if (collectWt) {
        const base = t.base_sha ?? await this.resolveBase(t)
        gate()
        cwd = (await verifyWorktree(mirror, collectWt, base)).path
        gate()
        if (!t.base_sha) this.tset(t, { base_sha: base })
        await this.runSetup(project, cwd, hq, 'setup', gate)
        gate()
      } else {
        cwd = this.workDir(t.request_id, t.key)
        if (!t.worktree) {
          const base = await this.resolveBase(t)
          gate()
          const identity = await this.projectIdentity(project)
          gate()
          await newWorkClone(mirror, cwd, base, identity)
          gate()
          await this.runSetup(project, cwd, hq, 'setup', gate)
          gate()
          if (!this.tset(t, { worktree: cwd, base_sha: base })) throw new Setup('작업이 다른 세대로 바뀌어 시작을 멈췄어요')
          t = this.store.task(t.id)!
        }
        const bases = await this.ensureBaseline(t, hq, gate)
        gate()
        const envMsg = this.baselineEnvMessage(t, bases)
        if (envMsg) throw new Setup(envMsg)
      }
      const role = t.role === 'collect' ? 'collect' : 'implement'
      let prompt: string
      if (resume) {
        const answers = prev ? this.store.taskQuestions(t.id, prev.id).filter((q) => q.answer !== null).map((q) => ({ question: q.question, answer: q.answer! })) : []
        prompt = resumePrompt({ answers, out, token: att.attempt_token, role, base: t.base_sha! })
      } else {
        const request = this.store.request(t.request_id)!
        prompt = workPrompt({ task: specOf(t), requestText: request.text, projectName: project.name, cwd, branch: role === 'implement' ? 'hq-work' : null, base: t.base_sha!,
          out, token: att.attempt_token, rework: t.note && prev ? this.reworkText(t, prev) : null, dirtyNotice: null, upstream: this.upstream(t) })
      }
      const argv = codexArgs(this.cfg, { role, model: att.model, sessionId: att.session_id, resume, out })
      gate()
      const { info, child, exit } = await launch({ codexBin: this.cfg.codexBin, argv, cwd, hqDir: hq, outDir: out, prompt, sessionId: att.session_id,
        sandbox: { ...this.sandboxFor(cwd, out, t.project), readOnlyWorktree: role === 'collect' }, proceed: () => !this.startBlocker(attemptId, 'running'),
        spec: { attemptId, kind: 'work', role, model: att.model, base: t.base_sha, generation: att.generation, attempt_token: att.attempt_token, resume, startedAt: this.iso() } })
      const startedAt = this.iso()
      // Spawned: from here the attempt is a live process; a cancel that lands now is handled by pollLive (SIGTERM).
      this.store.tx(() => {
        this.store.updateAttempt(attemptId, { status: 'running', pid: info.pid, lstart: info.lstart, started_at: startedAt })
        this.tset(t, { resume_session: null })
      })
      this.track({ ...att, status: 'running' }, info.pid, info.lstart, info.startedAt, { child, exit })
    } catch (e) {
      const aborted = e instanceof StartAborted || e instanceof StartWaiting ? e : e instanceof LaunchAborted ? this.startBlocker(attemptId, 'running') : null
      if (aborted) {
        if (collectWt) await removeMirrorWorktree(this.mirror(t.project), collectWt).catch(() => {})
        if (aborted instanceof StartWaiting) this.startWaiting(att, aborted)
        else this.startAborted(att, aborted)
      } else this.startFailed(att, e instanceof Setup ? e.message : `시작 실패: ${String(e)}`)
    }
  }

  private reworkText(t: TaskRow, prev: AttemptRow): string {
    const lastOk = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
    const checks = lastOk ? readJson<ChecksFile>(join(hqDirOf(lastOk), 'checks.json')) : null
    const lastReview = this.store.attempts(t.id).filter((a) => a.kind === 'review' && a.outcome === 'blocking').at(-1)
    const verdict = lastReview ? readJson<Verdict>(join(hqDirOf(lastReview), 'verdict.json')) : null
    // Only evidence that belongs to the failure being reworked: checks/verdict of the last succeeded attempt.
    const fresh = prev.status === 'succeeded'
    return reworkEvidence({ reasons: t.note ? [t.note] : [], checks: fresh ? checks : null, verdict: fresh ? verdict : null })
  }

  private baselineKey(t: TaskRow, a: Acceptance): string {
    return `baseline:${this.mirror(t.project)}:${t.base_sha}:${sha256(`${this.project(t.project)?.setup ?? ''}\n${a.check}`)}`
  }

  /** Stored base result; legacy 'pass'/'fail' values are still understood. Unreadable → null (rerun). */
  private readBase(key: string): BaseResult | null {
    const v = this.store.get(key)
    if (v === null) return null
    if (v === 'pass') return { pass: true, exitCode: 0, timedOut: false, tail: '' }
    if (v === 'fail') return { pass: false, exitCode: null, timedOut: false, tail: '' }
    try { return JSON.parse(v) as BaseResult } catch { return null }
  }

  /**
   * §9 baseline: each check once on the base, recorded (never an exemption). Returns every nonManual check's base result
   * (fresh and cached). Environment failures are not stored, so a retry after fixing the setup runs the baseline again.
   */
  private async ensureBaseline(t: TaskRow, hq: string, gate?: () => void): Promise<Record<string, BaseResult>> {
    const project = this.project(t.project)!
    const out: Record<string, BaseResult> = {}
    const missing: Acceptance[] = []
    for (const a of nonManual(specOf(t))) {
      const b = this.readBase(this.baselineKey(t, a))
      if (b) out[a.id] = b
      else missing.push(a)
    }
    if (!missing.length) return out
    gate?.() // before the baseline spawns its setup and checks
    const p = this.procTracker('baseline')
    try {
      const res = await baseline({ mirror: this.mirror(t.project), base: t.base_sha!, path: this.worktreeDir(t.request_id, `${t.key}.baseline`),
        checks: missing.map((a) => ({ id: a.id, command: a.check })), setup: project.setup ?? null, timeoutMs: this.cfg.checkTimeoutMinutes * 60_000,
        sandbox: (wt) => this.sandboxFor(wt, null, t.project), profilePath: join(hq, 'baseline.sb'), onSpawn: p.onSpawn })
      for (const a of missing) {
        const b = res[a.id]
        if (!b) continue
        out[a.id] = b
        if (!envFailure(b)) this.store.set(this.baselineKey(t, a), JSON.stringify(b))
      }
    } finally { p.done() }
    return out
  }

  /**
   * Why the base run says nothing about the code (setup failed, timeout, command not found/executable), or null.
   * A new-kind check exiting 126/127 on the base is expected (the script it runs is what the task adds), so only
   * setup failures and timeouts count for those.
   */
  private baselineEnvMessage(t: TaskRow, bases: Record<string, BaseResult>): string | null {
    const lastLine = (tail: string) => (tail.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[hq] 시간 초과')).at(-1) ?? '').slice(0, 200)
    const lines: string[] = []
    let setupLine = false
    for (const a of nonManual(specOf(t))) {
      const b = bases[a.id]
      if (!b || !envFailure(b)) continue
      if (b.setupFailed) {
        if (!setupLine) {
          const l = lastLine(b.tail)
          lines.unshift(l.startsWith('setup이 추적 파일을 바꿨어요') ? `- ${l}` : `- setup 명령 실패${l ? `: ${l}` : ''}`)
          setupLine = true
        }
        continue
      }
      if (!b.timedOut && kindOf(a) === 'new') continue
      const why = b.timedOut ? `${this.cfg.checkTimeoutMinutes}분 안에 끝나지 않음` : b.exitCode === 127 ? 'exit 127 (명령을 찾지 못함)' : 'exit 126 (실행할 수 없음)'
      const l = lastLine(b.tail)
      lines.push(`- [${a.id}] ${a.check} → ${why}${l ? `: ${l}` : ''}`)
    }
    if (!lines.length) return null
    return ['검사 명령이 원래 코드에서 실행되지 않아 작업을 시작하지 않았어요', ...lines,
      '원인 후보: 프로젝트 setup(의존성 설치)이 없거나 검사 명령이 잘못됐어요. setup을 등록하거나(hq projects add … --setup) 계획을 고친 뒤 다시 시도해 주세요'].join('\n')
  }

  /** The project repo's effective commit identity (read-only; the user's repo is not worker-writable, §6.1). */
  private async projectIdentity(project: Project): Promise<{ name?: string; email?: string }> {
    const get = async (k: string) => {
      const r = await hqGit(null, null, ['config', '--get', k], { cwd: project.path }).catch(() => null)
      const v = r && r.code === 0 ? r.stdout.trim() : ''
      return v || undefined
    }
    return { name: await get('user.name'), email: await get('user.email') }
  }

  /**
   * Checks hq runs itself (§9). Regression checks that already failed on the base for an ordinary reason still run,
   * marked `baseFailed`; `baseTails` holds their base output for the reviewer.
   */
  effectiveChecks(t: TaskRow, prefix = ''): { checks: CheckSpec[]; basePassed: Record<string, boolean>; baseTails: Record<string, string> } {
    const checks: CheckSpec[] = [], basePassed: Record<string, boolean> = {}, baseTails: Record<string, string> = {}
    for (const a of nonManual(specOf(t))) {
      const b = this.readBase(this.baselineKey(t, a))
      if (b) basePassed[prefix + a.id] = b.pass
      const baseFailed = kindOf(a) === 'regression' && !!b && !b.pass && !envFailure(b)
      if (baseFailed) baseTails[prefix + a.id] = b.tail
      checks.push({ id: prefix + a.id, command: a.check, kind: kindOf(a), ...(baseFailed ? { baseFailed: true } : {}) })
    }
    return { checks, basePassed, baseTails }
  }

  /** start_failed never restarts automatically (v3): the task stops for the chairman. */
  private startFailed(att: AttemptRow, why: string): void {
    this.store.tx(() => {
      this.store.updateAttempt(att.id, { status: 'start_failed', ended_at: this.iso(), reason: why.slice(0, 2000) })
      const t = this.store.task(att.task_id)!
      if (t.generation === att.generation && ['running', 'reviewing'].includes(t.status)) this.block(t, why)
    })
    this.bus.emit({ kind: 'attempt', text: why.slice(0, 200), data: { id: att.id } })
  }

  // ----- verification (§9) -----
  private startVerifications(): void {
    for (const t of this.store.tasksByStatus(['verifying'])) {
      if (this.checking.has(t.id) || !this.jobReady(`verify:${t.id}`)) continue
      this.checking.add(t.id)
      this.bg(this.verify(t).finally(() => this.checking.delete(t.id)), `verify:${t.id}`, this.blockOnFailure(t.id, t.generation))
    }
  }

  private async verify(t: TaskRow): Promise<void> {
    const att = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
    this.tset(t, { checks_state: 'running' })
    const mirror = this.mirror(t.project)
    const path = this.worktreeDir(t.request_id, `${t.key}.v${att?.n ?? 0}`)
    const p = this.procTracker('checks')
    try {
      if (!att || !t.base_sha || !t.head_sha) throw new Error('성공한 시도·커밋 정보가 없음')
      const project = this.project(t.project)!
      const hq = hqDirOf(att)
      // Before each spawn: the task must still be verifying this head in this generation (F08); otherwise stop quietly.
      const gate = () => {
        const cur = this.store.task(t.id), r = cur ? this.store.request(cur.request_id) : null
        if (!cur || !r || TERMINAL_REQUEST.has(r.status) || cur.status !== 'verifying' || cur.generation !== t.generation || cur.head_sha !== t.head_sha)
          throw new StartAborted('superseded', '검증 대상이 바뀌어 멈춤')
      }
      const wt = await verifyWorktree(mirror, path, t.head_sha)
      gate()
      await this.runSetup(project, wt.path, hq, 'verify-setup', gate)
      gate()
      const eff = this.effectiveChecks(t)
      const file = await runChecks({ wt, base: t.base_sha, head: t.head_sha, checks: eff.checks, basePassed: eff.basePassed,
        timeoutMs: this.cfg.checkTimeoutMinutes * 60_000, sandbox: this.sandboxFor(wt.path, null, t.project), profilePath: checksProfile(hq), onSpawn: p.onSpawn })
      file.manual = file.checks.filter((c) => c.baseFailed).map((c) => c.id)
      file.baseTails = Object.fromEntries(file.manual.map((id) => [id, eff.baseTails[id] ?? '']))
      atomicJson(join(hq, 'checks.json'), file)
      // Setup rewrote tracked files: an environment failure (the chairman decides), not the worker's fault (F01).
      if (file.setupChanged) throw new Setup(file.error!)
      const failed = file.checks.filter((c) => !c.pass && !c.baseFailed).map((c) => `[${c.id}] ${c.command} → ${c.exitCode ?? '시간 초과'}`)
      if (file.error) failed.unshift(file.error)
      if (file.secrets.length) failed.push(`비밀값 패턴·금지 파일: ${file.secrets.map((s) => `${s.file}:${s.line}(${s.pattern})`).join(', ')}`)
      this.store.tx(() => {
        const cur = this.store.task(t.id)
        if (!cur || cur.status !== 'verifying' || cur.generation !== t.generation || cur.head_sha !== t.head_sha) return
        // Manual items (failed on base and candidate) need a judge: with no reviewer, add a sonnet review instead of passing.
        const addReview = file.pass && cur.review_model === 'none' && (file.manual?.length ?? 0) > 0
        if (addReview) this.tset(cur, { status: 'reviewing', review_model: 'sonnet', checks_state: 'passed' })
        else if (file.pass) this.tset(cur, { status: cur.review_model === 'none' ? 'passed' : 'reviewing', checks_state: 'passed' })
        else { this.tset(cur, { checks_state: 'failed' }); this.rework(this.store.task(cur.id)!, `기계 검증 실패: ${failed.join('; ')}`) }
        this.emitTask(cur, `${cur.title}: 검증 ${file.pass ? '통과' : '실패'}`)
        if (addReview) this.emitTask(cur, '기존 실패 항목이 있어 검토를 추가해요 · sonnet')
      })
    } catch (e) {
      if (e instanceof StartAborted) return
      this.store.tx(() => {
        const cur = this.store.task(t.id)
        if (cur?.status === 'verifying' && cur.generation === t.generation) { this.tset(cur, { checks_state: 'error' }); this.block(cur, e instanceof Setup ? e.message : `검증을 실행할 수 없어요: ${String(e).slice(0, 300)}`) }
      })
    } finally {
      p.done()
      await removeMirrorWorktree(mirror, path).catch(() => {})
    }
  }

  // ----- cross review (§10) -----
  private reviewWorktree(t: TaskRow, n: number): string { return this.worktreeDir(t.request_id, `${t.key}.r${n}`) }

  private claimReview(t: TaskRow): boolean {
    const n = this.store.nextAttemptN(t.id, 'review')
    const id = `${t.id}~r${n}`
    this.store.insertAttempt({ id, task_id: t.id, kind: 'review', n, model: t.review_model, status: 'starting', attempt_token: randomBytes(16).toString('hex'),
      dir: this.runDir(t.request_id, t.key, id), session_id: randomUUID(), generation: t.generation })
    this.launching.add(id)
    this.bg(this.launchReview(id).finally(() => this.launching.delete(id)))
    this.emitTask(t, `${t.title} 검토 시작 · ${t.review_model}`)
    return true
  }

  private async launchReview(attemptId: string): Promise<void> {
    const att = this.store.attempt(attemptId)!
    const t = this.store.task(att.task_id)!
    const project = this.project(t.project)!
    const mirror = this.mirror(t.project)
    const path = this.reviewWorktree(t, att.n)
    const hq = hqDirOf(att)
    const gate = () => this.gate(attemptId, 'reviewing')
    try {
      mkdirSync(hq, { recursive: true })
      const wt = await verifyWorktree(mirror, path, t.head_sha!)
      gate()
      await this.runSetup(project, wt.path, hq, 'setup', gate)
      gate()
      // The reviewer must see the commit under review, not what setup made of it (F01).
      const changed = await trackedChanges(wt, t.head_sha!)
      gate()
      if (changed.length) throw new Setup(setupChangedReason(changed))
      const stat = await hqGit(mirror, null, ['diff', '--stat', '--no-ext-diff', '--no-textconv', t.base_sha!, t.head_sha!])
      gate()
      const work = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
      const result = work ? readJson<{ protectedChanges?: string[] }>(join(hqDirOf(work), 'result.json')) : null
      const checks = work ? readJson<ChecksFile>(join(hqDirOf(work), 'checks.json')) : null
      const report = t.role === 'collect' && work ? readText(join(hqDirOf(work), 'report.sealed.md'), 200_000) : null
      const prompt = reviewPrompt({ task: specOf(t), requestText: this.store.request(t.request_id)!.text, base: t.base_sha!, head: t.head_sha!, diffStat: stat.stdout,
        checks, protectedChanges: result?.protectedChanges ?? [], manualIds: checks?.manual ?? [], report,
        manualTails: Object.fromEntries((checks?.manual ?? []).map((id) => [id, { candidate: checks!.checks.find((c) => c.id === id)?.outputTail ?? '', base: checks!.baseTails?.[id] ?? '' }])) })
      const argv = codexArgs(this.cfg, { role: 'review', model: att.model, sessionId: att.session_id, resume: false, out: null, schema: VERDICT_SCHEMA })
      gate()
      const { info, child, exit } = await launch({ codexBin: this.cfg.codexBin, argv, cwd: wt.path, hqDir: hq, outDir: null, prompt, sessionId: att.session_id, schema: VERDICT_SCHEMA,
        sandbox: this.sandboxFor(wt.path, null, t.project), proceed: () => !this.startBlocker(attemptId, 'reviewing'),
        spec: { attemptId, kind: 'review', model: att.model, head_sha: t.head_sha, base_sha: t.base_sha, worktree: wt.path, generation: att.generation, startedAt: this.iso() } })
      const startedAt = this.iso()
      this.store.updateAttempt(attemptId, { status: 'running', pid: info.pid, lstart: info.lstart, started_at: startedAt })
      this.track({ ...att, status: 'running' }, info.pid, info.lstart, info.startedAt, { child, exit })
    } catch (e) {
      await removeMirrorWorktree(mirror, path).catch(() => {})
      const aborted = e instanceof StartAborted || e instanceof StartWaiting ? e : e instanceof LaunchAborted ? this.startBlocker(attemptId, 'reviewing') : null
      if (aborted instanceof StartWaiting) this.startWaiting(att, aborted)
      else if (aborted) this.startAborted(att, aborted)
      else this.startFailed(att, e instanceof Setup ? e.message : `검토 시작 실패: ${String(e)}`)
    }
  }

  async finalizeReview(att: AttemptRow, l: Live): Promise<void> {
    const task = this.store.task(att.task_id)!
    const result = l.tail.finalResult()
    const endedAt = this.iso()
    await removeMirrorWorktree(this.mirror(task.project), this.reviewWorktree(task, att.n)).catch(() => {})
    if (this.stale(att, task)) {
      this.store.updateAttempt(att.id, { status: 'failed', ended_at: endedAt, reason: '요청 중단 또는 세대 변경', ...this.usage(result) })
      return
    }
    const hq = hqDirOf(att)
    const stderr = (readText(join(hq, 'stderr.log'), 200_000) ?? '').slice(-20_000)
    if (att.outcome !== 'runaway' && (isNotLoggedIn(result, stderr) || isLimited(result, stderr, l.tail.rejectedSeen))) {
      const login = isNotLoggedIn(result, stderr)
      if (login) this.requireLogin(String(result?.result ?? stderr).slice(0, 300))
      else if (this.quota().mode !== 'hold') this.limitBackoff()
      this.store.tx(() => {
        this.store.updateAttempt(att.id, { status: 'limited', ended_at: endedAt, reason: login ? '로그인 필요' : '사용 한도', ...this.usage(result) })
        const reviews = this.store.attempts(task.id).filter((a) => a.kind === 'review' && a.generation === att.generation)
        const streak = reviews.slice(-MAX_LIMITED_STREAK)
        const t = this.store.task(task.id)!
        if (!login && streak.length >= MAX_LIMITED_STREAK && streak.every((a) => a.status === 'limited') && t.status === 'reviewing') this.block(t, `검토가 사용 한도로 ${MAX_LIMITED_STREAK}번 연속 중단됐어요`)
      })
      return // otherwise the task stays reviewing; dispatch restarts the review when the hold ends
    }
    const codeChanged = task.role === 'implement' && task.base_sha && task.head_sha ? (await mirrorChanged(this.mirror(task.project), task.base_sha, task.head_sha).catch(() => ['?'])).length > 0 : false
    const spec = specOf(task)
    // Evidence first: the reviewer's real Bash runs go to the DB before the verdict is judged.
    const bashRuns = extractBashRuns(join(hq, 'stream.jsonl'))
    this.store.updateAttempt(att.id, { bash_runs: JSON.stringify(bashRuns) })
    const work = this.store.attempts(task.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
    const checksFile = work ? readJson<ChecksFile>(join(hqDirOf(work), 'checks.json')) : null
    // Items handed to the reviewer must be judged pass/fail: explicit manual criteria and base-failed checks (F03).
    const judgeIds = [...new Set([...manualIds(spec), ...(checksFile?.manual ?? [])])]
    const check = att.outcome === 'runaway' ? { kind: 'invalid' as const, reason: `검토 폭주: ${att.reason ?? ''}`, verdict: null }
      : result?.is_error || !result ? { kind: 'invalid' as const, reason: `검토 실행 오류: ${String(result?.result ?? result?.subtype ?? '결과 없음').slice(0, 300)}`, verdict: null }
      : checkVerdict(result.structured_output, { acceptanceIds: spec.acceptance.map((a) => a.id), codeChanged, bashRuns, judgeIds })
    const prot = work ? readJson<{ protectedChanges?: string[] }>(join(hqDirOf(work), 'result.json'))?.protectedChanges ?? [] : []
    const binding = { task: task.id, head_sha: task.head_sha ?? undefined, base_sha: task.base_sha ?? undefined, reviewer_model: att.model, implementer_model: task.model, sameFamily: true, protectedChanges: prot }
    atomicJson(join(hq, 'verdict.json'), check.verdict ? { ...check.verdict, ...binding, ...(check.kind === 'invalid' ? { invalid: check.reason } : {}) }
      : { invalid: check.kind === 'invalid' ? check.reason : null, raw: result?.structured_output ?? null, ...binding })
    this.store.tx(() => {
      const status = check.kind === 'pass' ? 'succeeded' : check.kind === 'blocking' ? 'failed' : 'unverifiable'
      this.store.updateAttempt(att.id, { status, ended_at: endedAt, outcome: check.kind, ...this.usage(result),
        reason: check.kind === 'invalid' ? check.reason : check.kind === 'blocking' ? check.verdict.blocking.map((b) => b.summary).join('; ').slice(0, 2000) : null })
      const t = this.store.task(att.task_id)!
      if (t.status !== 'reviewing' || t.generation !== att.generation || t.head_sha !== task.head_sha) return
      if (check.kind === 'pass') this.tset(t, { status: 'passed', note: null })
      else if (check.kind === 'blocking') this.rework(t, `검토 blocking: ${check.verdict.blocking.map((b) => `[${b.id}] ${b.summary}`).join('; ')}`)
      else {
        const cnt = t.review_invalid + 1
        this.tset(t, { review_invalid: cnt, note: `검토 무효: ${check.reason}` })
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
        if (this.integrating.has(k) || !this.jobReady(`integrate:${k}`)) continue
        this.integrating.add(k)
        const job = this.runIntegration(r.id, m.project).catch((e) => {
          // Thrown (not a judged failure): back to pending so it is retried after the backoff.
          this.store.tx(() => { if (this.store.mergeRow(r.id, m.project)?.state === 'integrating') this.store.putMerge(r.id, m.project, { state: 'pending' }) })
          throw e
        })
        this.bg(job.finally(() => this.integrating.delete(k)), `integrate:${k}`, (e) => {
          if (['executing', 'accepted'].includes(this.store.request(r.id)?.status ?? '')) this.integrationFailed(r.id, m.project, 'failed', JOB_FAILING, `${JOB_FAILING}\n${String(e).slice(0, 500)}`, [])
        })
      }
    }
  }

  private async runIntegration(requestId: string, projectId: string): Promise<void> {
    const project = this.project(projectId)!
    // A new integration never inherits an earlier acknowledgment (it was bound to the old integration SHA).
    this.store.tx(() => { this.store.putMerge(requestId, projectId, { state: 'integrating', known_failures: null }); this.store.set(knownKey(requestId, projectId), null) })
    const prevNote = this.store.mergeRow(requestId, projectId)?.note ?? null
    const tasks = this.store.tasks(requestId).filter((t) => t.project === projectId && t.role === 'implement' && t.status === 'passed')
    const hq = join(this.home, 'runs', requestId, `_integration-${projectId}`, 'hq')
    mkdirSync(hq, { recursive: true })
    const fail = (state: string, note: string, body: string, taskIds: string[], known: KnownOffer | null = null) => { if (wanted()) this.integrationFailed(requestId, projectId, state, note, body, taskIds, known) }
    // The request must still want this integration before anything is spawned or recorded (F08).
    const wanted = () => {
      const st = this.store.request(requestId)?.status
      return !!st && !TERMINAL_REQUEST.has(st) && st !== 'merging' && this.store.mergeRow(requestId, projectId)?.state === 'integrating'
    }
    const target = await currentBranch(project.path)
    if (!target) { fail('failed', `프로젝트 ${project.name} checkout이 브랜치가 아니라서(detached HEAD) 통합할 대상이 없어요`, '프로젝트 checkout을 브랜치로 되돌린 뒤 다시 통합하세요.', []); return }
    const mirror = this.mirror(projectId)
    try { await ensureMirror(project, mirror) } catch (e) { fail('failed', `미러 갱신 실패: ${String(e).slice(0, 200)}`, String(e).slice(0, 500), []); return }
    const eff = tasks.map((t) => ({ t, e: this.effectiveChecks(t, `${t.key}.`) }))
    const path = this.integrationDir(requestId, projectId)
    if (!wanted()) return
    const p = this.procTracker('integration')
    let res
    try {
      res = await integrate({ mirror, requestId, project: projectId, path, target, heads: tasks.map((t) => ({ taskId: t.id, title: t.title, sha: t.head_sha! })),
        setup: project.setup ?? null, checks: eff.flatMap((x) => x.e.checks), timeoutMs: this.cfg.checkTimeoutMinutes * 60_000,
        sandbox: this.sandboxFor(path, null, projectId), profilePath: join(hq, 'checks.sb'), onSpawn: p.onSpawn })
    } finally { p.done() }
    if (!wanted()) return
    if (res.kind !== 'conflict' && res.checks) atomicJson(join(hq, 'checks.json'), res.checks)
    if (res.kind === 'conflict') {
      const who = tasks.find((t) => t.id === res.taskId)
      fail('conflict', `통합 충돌 (${who?.key ?? res.taskId}): ${res.files.join(', ')}`, `'${who?.title ?? res.taskId}' 작업을 ${target}(${res.targetSha.slice(0, 10)}) 위에 합치다 충돌했어요.\n충돌 파일:\n${res.files.map((f) => `- ${f}`).join('\n')}`, [res.taskId])
      this.notify('통합 충돌', `${project.name}: ${res.files.slice(0, 3).join(', ')}`)
      return
    }
    if (res.kind === 'failed') {
      const failedIds = new Set((res.checks?.checks ?? []).filter((c) => !c.pass && !c.baseFailed).map((c) => c.id.split('.')[0]))
      // Every failure is a base-failed check the task reviewer judged `pass` (no worse): the chairman may accept them.
      const judgedPass = (id: string) => {
        const i = id.indexOf('.'), t = tasks.find((x) => x.key === id.slice(0, i))
        const review = t ? this.store.attempts(t.id).filter((a) => a.kind === 'review' && a.outcome === 'pass' && a.generation === t.generation).at(-1) : undefined
        const v = review ? readJson<Verdict>(join(hqDirOf(review), 'verdict.json')) : null
        return v?.head_sha === t?.head_sha && v?.criteria.find((c) => c.id === id.slice(i + 1))?.result === 'pass'
      }
      const known = res.sha && res.known?.length && res.targetSha && res.known.every((k) => judgedPass(k.id))
        ? { sha: res.sha, target, targetSha: res.targetSha, items: res.known } : null
      fail('failed', res.reason, res.reason, tasks.filter((t) => failedIds.has(t.key)).map((t) => t.id), known)
      return
    }
    this.store.tx(() => {
      this.store.putMerge(requestId, projectId, { state: 'integrated', target, target_sha: res.targetSha, integration_sha: res.sha, note: prevNote })
      if (this.store.request(requestId)?.status === 'accepted') this.offerMerge(requestId, projectId)
    })
  }

  /** Records a failed integration and opens its card (the request stops unless it already ended). */
  private integrationFailed(requestId: string, projectId: string, state: string, note: string, body: string, taskIds: string[], known: KnownOffer | null = null): void {
    const project = this.project(projectId)!
    this.store.tx(() => {
      this.store.putMerge(requestId, projectId, { state, note, diagnosis: null })
      this.store.set(`integration.tasks:${requestId}:${projectId}`, JSON.stringify(taskIds))
      this.store.set(knownKey(requestId, projectId), known ? JSON.stringify(known) : null)
      const r = this.store.request(requestId)!
      if (!TERMINAL_REQUEST.has(r.status)) this.store.updateRequest(requestId, { status: 'blocked', note })
      this.store.putApproval({ id: `integration:${requestId}:${projectId}`, teamId: 'hq', subjectId: requestId, title: `통합 문제: ${project.name}`,
        body, options: known ? [...INTEGRATION_OPTIONS, ACCEPT_KNOWN] : INTEGRATION_OPTIONS, subjectHash: sha256(`${requestId}:${projectId}:${note}:${known?.sha ?? ''}:${this.now()}`) })
    })
  }

  /** Integration card decision. Call inside a tx. */
  private integrationDecidedTx(requestId: string, projectId: string, decision: string): string | null {
    const m = this.store.mergeRow(requestId, projectId)
    if (decision === '요청 중단') return this.cancelRequestTx(requestId)
    if (!m || !['conflict', 'failed'].includes(m.state)) return '다시 통합할 수 있는 상태가 아닙니다'
    if (decision === ACCEPT_KNOWN) {
      const raw = this.store.get(knownKey(requestId, projectId))
      if (m.state !== 'failed' || !raw) return '기존 실패로 인정할 수 있는 통합이 아닙니다'
      const k = JSON.parse(raw) as KnownOffer
      // The acknowledgment is recorded on the merge row and bound to this integration SHA; the merge card follows for the same SHA.
      this.store.putMerge(requestId, projectId, { state: 'integrated', target: k.target, target_sha: k.targetSha, integration_sha: k.sha, note: null,
        known_failures: JSON.stringify({ sha: k.sha, items: k.items }) })
      this.store.set(knownKey(requestId, projectId), null)
      const r = this.store.request(requestId)!
      const accepted = this.store.approval(`accept:${requestId}`)?.decision === '수락'
      if (r.status === 'blocked' && !this.store.tasks(requestId).some((t) => t.status === 'blocked')) this.store.updateRequest(requestId, { status: accepted ? 'accepted' : 'executing', note: null })
      return null
    }
    const accepted = this.store.approval(`accept:${requestId}`)?.decision === '수락'
    if (decision === '해당 작업 재작업') {
      // The named tasks start over on top of the current target (invalidation rules, §12); integration restarts later.
      const ids = JSON.parse(this.store.get(`integration.tasks:${requestId}:${projectId}`) ?? '[]') as string[]
      const targets = (ids.length ? ids : this.store.tasks(requestId).filter((t) => t.project === projectId && t.role === 'implement').map((t) => t.id))
      for (const id of targets) {
        const t = this.store.task(id)
        if (!t) continue
        this.resetTask(t, '통합 실패로 새 대상 위에서 다시 해요', m.target_sha)
        for (const d of this.dependents(t)) if (d.status !== 'cancelled') this.resetTask(d, `선행 작업(${t.key})을 다시 해서 처음부터 다시 해요`)
      }
      this.store.raw().prepare('delete from merges where request_id = ?').run(requestId)
      this.store.supersede(`accept:${requestId}`)
      for (const x of this.store.mergeRows(requestId)) this.store.supersede(`merge:${requestId}:${x.project}`)
      this.store.updateRequest(requestId, { status: 'executing', note: null })
      return null
    }
    this.store.putMerge(requestId, projectId, { state: 'pending', note: null })
    const r = this.store.request(requestId)!
    if (r.status === 'blocked' && !this.store.tasks(requestId).some((t) => t.status === 'blocked')) this.store.updateRequest(requestId, { status: accepted ? 'accepted' : 'executing', note: null })
    return null
  }

  // ----- request completion (§C step 5, §12) -----
  /** Accept subject (v3): the task results only — the merge card binds the integration SHA. */
  acceptSubject(requestId: string): string {
    const lines = this.store.tasks(requestId).filter((t) => t.status === 'passed').map((t) => {
      const work = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
      const review = this.store.attempts(t.id).filter((a) => a.kind === 'review' && a.outcome === 'pass').at(-1)
      const checks = work ? readText(join(hqDirOf(work), 'checks.json')) ?? '' : ''
      const verdict = review ? readText(join(hqDirOf(review), 'verdict.json')) ?? '' : ''
      return `${t.id}|${t.generation}|${t.head_sha}|${t.report_sha ?? ''}|${sha256(checks)}|${sha256(verdict)}`
    }).sort()
    return sha256(lines.join('\n'))
  }

  private putAcceptCard(requestId: string): void {
    const r = this.store.request(requestId)!
    const body: string[] = []
    for (const t of this.store.tasks(requestId)) {
      if (t.status === 'cancelled') { body.push(`${t.key} ${t.title} — 취소됨`); continue }
      const work = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)
      const checks = work ? readJson<ChecksFile>(join(hqDirOf(work), 'checks.json')) : null
      // hq's own record (result.json): the worker's summary is shown as its report, the file count is the mirror diff (F3).
      const result = work ? readJson<{ protectedChanges?: string[]; summary?: string | null; changedFiles?: number | null }>(join(hqDirOf(work), 'result.json')) : null
      const review = this.store.attempts(t.id).filter((a) => a.kind === 'review' && a.outcome === 'pass').at(-1)
      const verdict = review ? readJson<Verdict>(join(hqDirOf(review), 'verdict.json')) : null
      const parts = [`변경 파일 ${typeof result?.changedFiles === 'number' ? result.changedFiles : '?'}개`,
        checks ? `검사 ${checks.checks.filter((c) => c.pass).length}/${checks.checks.length} 통과` : '검사 없음',
        t.review_model === 'none' ? '검토 없음(기계 검증만)' : verdict ? `검토 통과(${review!.model}${verdict.advisory.length ? `, 참고 ${verdict.advisory.length}건` : ''})` : '검토 기록 없음']
      if (checks?.manual?.length) parts.push(`기존 실패(검토자 판단): ${checks.manual.join(', ')}`)
      if (checks?.warnings?.length) parts.push(`경고: ${checks.warnings.join(' / ')}`)
      if (checks?.setupCreated?.count) parts.push(`setup이 만든 파일 ${checks.setupCreated.count}개`)
      if (result?.protectedChanges?.length) parts.push(`보호 경로 변경: ${result.protectedChanges.join(', ')}`)
      const judged = [...new Set([...manualIds(specOf(t)), ...(checks?.manual ?? [])])].map((id) => {
        const c = verdict?.criteria.find((x) => x.id === id)
        const why = (c?.evidence ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
        return `  검토자 판정: [${id}] ${c?.result ?? '기록 없음'} — ${why.slice(0, 160)}`
      })
      body.push([`${t.key} [${t.model}] ${t.title} — 작업자 보고: ${(result?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)}`, `  ${parts.join(' · ')}`, ...judged].join('\n'))
    }
    this.store.putApproval({ id: `accept:${requestId}`, teamId: 'hq', subjectId: requestId, title: `결과 수락: ${r.text.replace(/\s+/g, ' ').slice(0, 60)}`,
      body: body.join('\n'), options: ['수락', '반려'], subjectHash: this.acceptSubject(requestId) })
  }

  /** Call inside a tx. */
  private offerMerge(requestId: string, projectId: string): void {
    const m = this.store.mergeRow(requestId, projectId)!
    const project = this.project(projectId)!
    const tasks = this.store.tasks(requestId).filter((t) => t.project === projectId && t.role === 'implement' && t.status === 'passed')
    const newCommits = this.store.get(`targetAhead:${requestId}:${projectId}`)
    const known = m.known_failures ? JSON.parse(m.known_failures) as { sha: string; items: { id: string; command: string }[] } : null
    const knownLines = known && known.sha === m.integration_sha ? known.items.map((i) => `회장이 인정한 기존 실패: [${i.id}] ${i.command}`) : []
    const body = [...(m.note ? [m.note, ''] : []), ...knownLines, `대상: ${project.name} ${m.target} (${m.target_sha?.slice(0, 10)})`,
      `병합할 통합 커밋: ${m.integration_sha?.slice(0, 10)} (fast-forward)`, ...(newCommits ? [`대상 브랜치에 새로 생긴 커밋 ${newCommits}개`] : []),
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
        if (!live.length) { this.store.updateRequest(r.id, { status: 'cancelled', note: '남은 작업 없음' }); this.emitRequest(r.id, '남은 작업 없음'); return }
        if (!live.every((t) => t.status === 'passed')) return
        for (const p of this.projectsToIntegrate(r.id)) if (!this.store.mergeRow(r.id, p)) this.store.putMerge(r.id, p, { state: 'pending' })
        if (this.store.mergeRows(r.id).some((m) => m.state !== 'integrated')) return
        this.store.updateRequest(r.id, { status: 'awaiting_acceptance', note: null })
        this.putAcceptCard(r.id)
        this.emitRequest(r.id, '모든 작업 통과 — 결과 수락을 기다려요')
      })
    }
    for (const r of this.store.requestsByStatus(['accepted'])) {
      for (const m of this.store.mergeRows(r.id)) if (m.state === 'integrated') {
        await this.countTargetAhead(r.id, m.project, m.target_sha)
        this.store.tx(() => { if (this.store.mergeRow(r.id, m.project)?.state === 'integrated') this.offerMerge(r.id, m.project) })
      }
    }
    for (const r of this.store.requestsByStatus(['cancelled'])) await this.cleanupCancelled(r.id)
  }

  /** Commits the target gained since the request base, for the merge card (§12). */
  private async countTargetAhead(requestId: string, projectId: string, targetSha: string | null): Promise<void> {
    const base = this.store.get(`base:${requestId}:${projectId}`)
    if (!base || !targetSha) return
    const r = await hqGit(this.mirror(projectId), null, ['rev-list', '--count', `${base}..${targetSha}`])
    this.store.set(`targetAhead:${requestId}:${projectId}`, r.code === 0 && r.stdout.trim() !== '0' ? r.stdout.trim() : null)
  }

  // ----- chairman actions (§D) -----
  /** Call inside a tx. */
  private acceptTx(requestId: string): string | null {
    const r = this.store.request(requestId)
    if (r?.status !== 'awaiting_acceptance') return '결과 수락을 기다리는 요청이 아닙니다'
    this.store.updateRequest(requestId, { status: 'accepted', note: null })
    this.emitRequest(requestId, this.store.mergeRows(requestId).length ? '결과 수락 — 병합 승인을 기다려요' : '결과 수락 — 완료')
    return null
  }

  /** The merge itself, after the decide transaction recorded the intent (request merging, row merging). */
  private async runMerge(requestId: string, projectId: string): Promise<string | null> {
    const project = this.project(projectId)!
    const m = this.store.mergeRow(requestId, projectId)!
    await ensureMirror(project, this.mirror(projectId)).catch(() => {})
    const res = await applyMerge({ repo: project.path, mirror: this.mirror(projectId), requestId, project: projectId, target: m.target!, targetSha: m.target_sha!, integrationSha: m.integration_sha! })
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
    return res.kind === 'stale' ? res.why : 'detached HEAD'
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
    for (const t of this.store.tasks(requestId)) if (t.worktree) rmSync(t.worktree, { recursive: true, force: true })
    for (const m of this.store.mergeRows(requestId)) await withRepo(this.mirror(m.project), () => hqGit(this.mirror(m.project), null, ['update-ref', '-d', integrationRef(requestId, m.project)]))
  }

  /** §D rejectResult (v3): only via the API with a reason and the accept card's subject hash. */
  rejectResult(requestId: string, reason: string, subjectHash: string, keys?: string[]): string | null {
    const err = this.store.tx(() => {
      const r = this.store.request(requestId)
      if (r?.status !== 'awaiting_acceptance') return '결과 수락을 기다리는 요청이 아닙니다'
      const card = this.store.approval(`accept:${requestId}`)
      if (!card || card.state !== 'open' || card.subjectHash !== subjectHash) return '수락 카드 내용이 바뀌었습니다. 새로 보고 다시 반려해 주세요'
      const all = this.store.tasks(requestId)
      if (keys) for (const k of keys) if (!all.some((t) => t.key === k && t.status === 'passed')) return `통과한 작업이 아닙니다: ${k}`
      this.store.supersede(`accept:${requestId}`)
      this.store.updateRequest(requestId, { status: 'executing', note: `결과 반려: ${reason}` })
      for (const t of all) if (t.status === 'passed' && (!keys || keys.includes(t.key))) {
        const cur = this.store.task(t.id)!
        if (cur.status === 'passed') this.rework(cur, `결과 반려: ${reason}`)
      }
      this.store.raw().prepare('delete from merges where request_id = ?').run(requestId)
      if (this.store.tasks(requestId).some((t) => t.status === 'blocked')) this.store.updateRequest(requestId, { status: 'blocked' })
      return null
    })
    if (!err) { this.emitRequest(requestId, `결과 반려: ${reason}`); this.kick() }
    return err
  }

  /** Call inside a tx. Live attempt groups are killed after the transaction commits. */
  private cancelRequestTx(requestId: string): string | null {
    const r = this.store.request(requestId)
    if (!r) return '요청이 없습니다'
    if (TERMINAL_REQUEST.has(r.status) || r.status === 'merging') return '이미 끝났거나 병합 중인 요청입니다'
    if (r.status === 'accepted' && !this.store.mergeRows(requestId).length) return '이미 끝난 요청입니다'
    this.store.updateRequest(requestId, { status: 'cancelled', note: '회장이 중단' })
    const tasks = this.store.tasks(requestId)
    for (const t of tasks) if (t.status !== 'passed' && t.status !== 'cancelled') this.store.updateTask(t.id, { status: 'cancelled', generation: t.generation + 1 })
    for (const a of this.store.liveAttempts()) if (tasks.some((t) => t.id === a.task_id)) {
      // pollLive signals the group once its identity is confirmed (SIGTERM, SIGKILL after the grace period).
      this.store.updateAttempt(a.id, { outcome: 'cancelled', reason: '요청 중단' })
    }
    for (const a of this.store.openApprovals(0)) {
      if (a.id === `plan:${requestId}` || a.id === `accept:${requestId}` || a.id.startsWith(`merge:${requestId}:`) || a.id.startsWith(`integration:${requestId}:`)
        || (a.kind === 'revise' && tasks.some((t) => a.id === `revise:${t.id}`))) this.store.supersede(a.id)
    }
    this.emitRequest(requestId, '요청 중단')
    return null
  }

  cancelRequest(requestId: string): string | null {
    const err = this.store.tx(() => this.cancelRequestTx(requestId))
    if (!err) this.kick()
    return err
  }

  private async cleanupCancelled(requestId: string): Promise<void> {
    if (this.store.get(`cleaned:${requestId}`)) return
    const tasks = this.store.tasks(requestId)
    if (this.store.liveAttempts().some((a) => tasks.some((t) => t.id === a.task_id))) return
    for (const t of tasks) if (t.worktree) rmSync(t.worktree, { recursive: true, force: true })
    this.store.set(`cleaned:${requestId}`, this.iso())
  }

  /** §D decideTask (v3): retry on the same model, skip (with dependents), or stop. Revision = the task's block count. */
  decideTask(taskId: string, decision: string, revision: number): string | null {
    const t = this.store.task(taskId)
    if (!t || t.status !== 'blocked') return '차단된 작업이 아닙니다'
    if (t.block_count !== revision) return `오래된 revision입니다 (현재 ${t.block_count})`
    if (decision === 'stop') return this.cancelRequest(t.request_id)
    if (decision !== 'retry' && decision !== 'skip' && decision !== RELEASE) return 'decision은 retry | skip | stop | release 중 하나여야 합니다'
    const ling = lingeringOf(t)
    if (decision === RELEASE && !ling) return 'release는 이전 작업자가 남아 있을 때만 쓸 수 있습니다'
    this.store.tx(() => {
      if (decision === RELEASE) {
        // The chairman vouches that the earlier worker is gone: forget it without any signal, then retry.
        this.store.updateTask(t.id, { lingering: null })
        this.store.set(lingeringPsKey(t.id), null)
      }
      if (decision === 'retry' || decision === RELEASE) {
        const said = decision === RELEASE ? `회장: 이전 작업자(pid ${ling!.pid})를 끝난 것으로 보고 진행 (신호 없음)` : '회장: 한 번 더 (같은 모델)'
        this.store.updateTask(t.id, { status: 'rework', attempts: Math.max(0, this.cfg.maxAttempts - 1), limited_streak: 0,
          review_invalid: 0, resume_session: null, note: `${said}\n이전 사유: ${t.note ?? ''}`.slice(0, 2000) })
      } else {
        for (const x of [t, ...this.dependents(t)]) if (x.status !== 'passed' && x.status !== 'cancelled')
          this.store.updateTask(x.id, { status: 'cancelled', generation: x.generation + 1, note: x.id === t.id ? '회장: 이 작업 건너뛰기' : `선행 작업 ${t.key} 건너뜀` })
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
      const q = this.store.taskQuestions(taskId).find((x) => x.id === questionId)
      if (!q || q.revision !== t.revision) return '이 작업의 현재 질문이 아닙니다'
      if (!this.store.answerTaskQuestion(questionId, answer)) return '이미 답한 질문입니다'
      // All answered: worker questions resume the worker; CEO revise questions re-run the revise turn (F16).
      if (!this.store.taskQuestions(taskId, q.attempt_id).some((x) => x.answer === null))
        this.tset(t, q.attempt_id?.startsWith(REVISE_Q) ? { status: 'revising', note: '회장 답변을 받아 지시서를 다시 고쳐요' } : { status: 'pending' })
      return null
    })
    if (!err) {
      const ceo = this.store.taskQuestions(taskId).find((x) => x.id === questionId)?.attempt_id?.startsWith(REVISE_Q)
      this.bus.emit({ kind: 'task', text: `${ceo ? '사장' : '작업자'} 질문 답변: ${answer.slice(0, 60)}`, data: { id: taskId } }); this.kick()
    }
    return err
  }

  // ----- brief revision (§10a) -----
  /** CEO revise questions of the task's current revision (F16). */
  private reviseQuestions(t: TaskRow) {
    return this.store.taskQuestions(t.id).filter((q) => q.revision === t.revision && q.attempt_id?.startsWith(`${REVISE_Q}${t.id}:`))
  }

  private async reviseOne(): Promise<void> {
    if (!this.canStartCeo()) return
    const t = this.store.tasksByStatus(['revising']).find((x) => !this.revising.has(x.id) && this.store.approval(`revise:${x.id}`)?.state !== 'open'
      && this.store.request(x.request_id)?.status === 'executing' && this.jobReady(`revise:${x.id}`))
    if (!t || !this.ceoLock.tryAcquire()) return
    this.revising.add(t.id)
    this.bg(this.runRevise(t).finally(() => { this.revising.delete(t.id); this.ceoLock.release() }), `revise:${t.id}`, this.blockOnFailure(t.id, t.generation))
  }

  private async runRevise(t: TaskRow): Promise<void> {
    const project = this.project(t.project)!
    const r = this.store.request(t.request_id)!
    const spec = specOf(t)
    const att = this.store.attempts(t.id).filter((a) => a.kind === 'work' && a.status === 'brief_blocked').at(-1)
    const report = att ? readOut(outDirOf(att), 'report.md', REPORT_MAX) : null
    const fetched = att ? readJson<{ fetched?: string | null }>(join(hqDirOf(att), 'result.json'))?.fetched ?? null : null
    const stat = fetched && t.base_sha ? (await hqGit(this.mirror(t.project), null, ['diff', '--stat', '--no-ext-diff', '--no-textconv', t.base_sha, fetched])).stdout : ''
    // Answers the chairman gave to this revision's CEO questions (F16) go back into the turn.
    const answers = this.reviseQuestions(t).filter((q) => q.answer !== null).map((q) => ({ question: q.question, answer: q.answer! }))
    // Right before the CEO turn is spawned: still revising this generation of an executing request (F08).
    const now = this.store.task(t.id)
    if (!now || now.status !== 'revising' || now.generation !== t.generation || this.store.request(t.request_id)?.status !== 'executing') return
    this.store.updateTask(t.id, { revise_turns: t.revise_turns + 1 })
    const res = await runReviseTurn({ codexBin: this.cfg.codexBin, runtimeHome: this.cfg.home, model: this.cfg.models.sonnet, hqRoot: this.hqRoot, project, projects: this.projects, requestText: r.text, task: spec, report, diffStat: stat, answers,
      onLine: (line) => { if (line.type === 'rate_limit_event') this.observe(line) } })
    if (res.limited) { this.store.updateTask(t.id, { revise_turns: t.revise_turns }); if (this.quota().mode !== 'hold') this.limitBackoff(); return } // not counted
    const cur = this.store.task(t.id)
    if (!cur || cur.status !== 'revising' || cur.generation !== t.generation) return
    if (!res.ok || !res.output) { this.store.tx(() => this.block(cur, `지시서 수정 턴 실패: ${res.error ?? ''}`)); return }
    if (!res.output.revised_task) {
      // The CEO needs the chairman: its questions become this task's questions (answered like worker questions).
      // A question round is not a revision: it does not use up the revise budget (rounds are capped instead).
      const qs = res.output.questions
      const asked = this.store.tx(() => {
        this.store.updateTask(cur.id, { revise_turns: t.revise_turns })
        const rounds = new Set(this.reviseQuestions(cur).map((q) => q.attempt_id)).size
        if (rounds >= MAX_QUESTION_ROUNDS) { this.block(cur, `사장의 지시서 질문이 ${MAX_QUESTION_ROUNDS}라운드를 넘었어요:\n${qs.map((q) => `- ${q.question} (기본: ${q.default})`).join('\n')}`); return false }
        this.store.addTaskQuestions(cur.id, `${REVISE_Q}${cur.id}:${randomUUID().slice(0, 8)}`, cur.revision,
          qs.map((q) => ({ id: 'tq-' + randomUUID().slice(0, 8), question: q.question, options: q.options, default: q.default })))
        this.tset(cur, { status: 'question', note: `사장이 지시서를 고치려면 회장님 답이 필요해요 (${qs.length}건)` })
        return true
      })
      if (asked) this.emitTask(cur, `사장 질문: ${cur.title}`)
      return
    }
    const rev = res.output.revised_task
    const plan = this.store.tasks(t.request_id).map((x) => (x.id === t.id ? rev : specOf(x)))
    const problem = reviseProblem(spec, rev) ?? validateTasks(plan, this.projects)
    if (problem) { this.store.tx(() => this.block(cur, `지시서 수정안이 유효하지 않아요: ${problem}`)); return }
    if (canAutoApply(spec, rev)) { this.store.tx(() => this.applyRevision(t.id, rev)); return }
    this.store.tx(() => {
      this.store.set(`revise:${t.id}`, JSON.stringify(rev))
      this.store.putApproval({ id: `revise:${t.id}`, teamId: 'hq', subjectId: t.request_id, title: `지시서 수정안: ${t.title}`, body: reviseDiff(spec, rev),
        options: ['승인', '반려'], subjectHash: sha256(JSON.stringify(rev)) })
    })
    this.emitTask(t, `지시서 수정안 승인 필요: ${t.title}`)
  }

  /** §D applyRevision: full validate, new spec, revision+1, generation+1, rework keeping attempts, dependents invalidated. Call inside a tx. */
  applyRevision(taskId: string, rev: PlanTask): string | null {
    const t = this.store.task(taskId)
    if (!t || t.status !== 'revising') return '지시서 수정을 기다리는 작업이 아닙니다'
    const plan = this.store.tasks(t.request_id).map((x) => (x.id === t.id ? rev : specOf(x)))
    const problem = reviseProblem(specOf(t), rev) ?? validateTasks(plan, this.projects)
    if (problem) { this.block(t, `지시서 수정안이 유효하지 않아요: ${problem}`); return null }
    for (const a of this.store.liveAttempts()) if (a.task_id === t.id) this.store.updateAttempt(a.id, { outcome: 'superseded' }) // pollLive signals it
    this.store.updateTask(taskId, { spec: JSON.stringify(rev), title: rev.title, grade: rev.grade, model: rev.model, review_model: reviewModelOf(rev),
      revision: t.revision + 1, generation: t.generation + 1, status: 'rework', resume_session: null, note: '지시서 수정 적용' })
    this.store.set(`revise:${taskId}`, null)
    this.invalidateDependents(this.store.task(taskId)!)
    this.emitTask(t, `지시서 수정 적용: ${rev.title} (revision ${t.revision + 1})`)
    this.kick()
    return null
  }

  // ----- CEO diagnosis of blocked / integration items (§17) -----
  private async diagnoseOne(): Promise<void> {
    if (!this.canStartCeo() || this.ceoLock.busy) return
    const t = this.store.tasksByStatus(['blocked']).find((x) => x.diagnosis === null && !this.diagnosing.has(x.id) && this.jobReady(`diagnose:${x.id}`))
    const m = t ? null : this.store.requestsByStatus(['blocked', 'executing', 'accepted']).flatMap((r) => this.store.mergeRows(r.id))
      .find((x) => ['conflict', 'failed'].includes(x.state) && x.diagnosis === null && !this.diagnosing.has(`${x.request_id}:${x.project}`)
        && this.jobReady(`diagnose:${x.request_id}:${x.project}`))
    if ((!t && !m) || !this.ceoLock.tryAcquire()) return
    const key = t ? t.id : `${m!.request_id}:${m!.project}`
    this.diagnosing.add(key)
    const job = t ? this.diagnoseTask(t) : this.diagnoseIntegration(m!.request_id, m!.project)
    // Giving up stores the failed-diagnosis marker, so the item keeps hq's own explanation and the turn stops retrying.
    const marker = JSON.stringify({ ok: false, error: JOB_FAILING })
    const giveUp = () => this.store.tx(() => {
      if (t) { const cur = this.store.task(t.id); if (cur?.status === 'blocked' && cur.diagnosis === null) this.store.updateTask(t.id, { diagnosis: marker }) }
      else { const cur = this.store.mergeRow(m!.request_id, m!.project); if (cur && cur.diagnosis === null) this.store.putMerge(m!.request_id, m!.project, { diagnosis: marker }) }
    })
    this.bg(job.finally(() => { this.diagnosing.delete(key); this.ceoLock.release() }), `diagnose:${key}`, giveUp)
  }

  private checksEvidence(file: ChecksFile | null): string {
    if (!file) return '(검사 기록 없음)'
    const lines = file.checks.filter((c) => !c.pass && !c.baseFailed).map((c) => `- [${c.id}] \`${c.command}\` → 종료 코드 ${c.exitCode ?? '시간 초과'}\n\`\`\`\n${c.outputTail.split('\n').slice(-30).join('\n')}\n\`\`\``)
    if (file.error) lines.unshift(`- 오류: ${file.error}`)
    if (file.secrets.length) lines.push(`- 비밀값 패턴·금지 파일: ${file.secrets.map((x) => `${x.file}:${x.line} (${x.pattern})`).join(', ')}`)
    return lines.join('\n') || '(실패한 검사 없음)'
  }

  private async diagnoseTask(t: TaskRow): Promise<void> {
    const project = this.project(t.project)!
    const atts = this.store.attempts(t.id)
    const lastWork = atts.filter((a) => a.kind === 'work' && existsSync(join(hqDirOf(a), 'checks.json'))).at(-1)
    const lastBlocking = atts.filter((a) => a.kind === 'review' && a.outcome === 'blocking').at(-1)
    const verdict = lastBlocking ? readJson<Verdict>(join(hqDirOf(lastBlocking), 'verdict.json')) : null
    const reportAtt = atts.filter((a) => a.kind === 'work').reverse().find((a) => readOut(outDirOf(a), 'report.md', REPORT_MAX) !== null)
    const report = reportAtt ? readOut(outDirOf(reportAtt), 'report.md', REPORT_MAX) ?? '' : ''
    const summary = /^##\s*요약\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(report)?.[1]?.trim() ?? '(보고서 없음)'
    const evidence = [
      { title: '작업 spec (PlanTask JSON)', body: '```json\n' + JSON.stringify(specOf(t), null, 2) + '\n```' },
      { title: '멈춘 이유 (hq 판정)', body: t.note ?? '' },
      { title: '시도별 판정', body: atts.map((a) => `- ${a.id} [${a.kind} · ${a.model}] ${a.status}${a.reason ? `: ${a.reason.slice(0, 500)}` : ''}`).join('\n') },
      { title: '실패한 검사', body: this.checksEvidence(lastWork ? readJson<ChecksFile>(join(hqDirOf(lastWork), 'checks.json')) : null) },
      { title: '검토 blocking', body: verdict?.blocking.map((b) => `- [${b.id}] ${b.summary} — ${b.evidence}`).join('\n') || '(없음)' },
      { title: '작업자 보고서 요약', body: summary },
    ]
    const res = await runDiagnoseTurn({ codexBin: this.cfg.codexBin, runtimeHome: this.cfg.home, model: this.cfg.models.sonnet, hqRoot: this.hqRoot, project, kind: 'blocked', options: BLOCKED_OPTIONS, evidence,
      onLine: (line) => { if (line.type === 'rate_limit_event') this.observe(line) } })
    if (res.limited) return // retried after the hold
    this.store.tx(() => {
      const cur = this.store.task(t.id)
      if (cur?.status === 'blocked' && cur.diagnosis === null && cur.block_count === t.block_count) this.store.updateTask(t.id, { diagnosis: JSON.stringify(res.result) })
    })
  }

  private async diagnoseIntegration(requestId: string, projectId: string): Promise<void> {
    const project = this.project(projectId)!
    const m = this.store.mergeRow(requestId, projectId)!
    const tasks = this.store.tasks(requestId).filter((t) => t.project === projectId && t.role === 'implement' && t.status === 'passed')
    const checks = readJson<ChecksFile>(join(this.home, 'runs', requestId, `_integration-${projectId}`, 'hq', 'checks.json'))
    const evidence = [
      { title: '통합 실패 (hq 판정)', body: m.note ?? '' },
      { title: '합친 작업', body: tasks.map((t) => `- ${t.key} ${t.title} @ ${t.head_sha}\n  owns: ${specOf(t).owns.join(', ')}`).join('\n') },
      { title: '실패한 검사', body: m.state === 'failed' ? this.checksEvidence(checks) : '(충돌이라 검사 전)' },
    ]
    const res = await runDiagnoseTurn({ codexBin: this.cfg.codexBin, runtimeHome: this.cfg.home, model: this.cfg.models.sonnet, hqRoot: this.hqRoot, project, kind: 'integration', options: INTEGRATION_OPTIONS, evidence,
      onLine: (line) => { if (line.type === 'rate_limit_event') this.observe(line) } })
    if (res.limited) return
    this.store.tx(() => {
      const cur = this.store.mergeRow(requestId, projectId)
      if (cur && cur.state === m.state && cur.diagnosis === null && cur.updated_at === m.updated_at) this.store.putMerge(requestId, projectId, { diagnosis: JSON.stringify(res.result) })
    })
  }

  // ----- notifications (§17: once per decision id + revision) -----
  private notifyDecisions(): void {
    const titles: Record<DecisionItem['kind'], string> = { system: 'hq가 멈췄어요 — 확인이 필요해요', plan: '사장이 계획을 올렸어요', ceo_question: '사장이 질문했어요', worker_question: '작업자가 질문했어요',
      revise: '지시서 수정안 승인이 필요해요', blocked: '작업이 막혔어요 — 판단이 필요해요', integration: '통합에 문제가 생겼어요', accept: '결과 수락을 기다려요', merge: '병합 승인을 기다려요', team: '팀 결정이 필요해요' }
    for (const d of decisionItems(this.store, this.now(), this.teamNames)) {
      const k = `notified:${d.id}:${d.revision}`
      if (this.store.get(k)) continue
      this.store.set(k, this.iso())
      this.notify(titles[d.kind], d.title)
    }
  }

  // ----- screen data -----
  views(teams?: HeadlineInput['teams']): { workers: WorkerView[]; headline: Headline; quota: QuotaView | null; decisions: DecisionItem[] } {
    const decisions = decisionItems(this.store, this.now(), this.teamNames)
    const q = this.quota()
    const workers = workerViews(this.store, (a) => this.live.get(a.id)?.tail.lastActivity ?? lastActivityOf(hqDirOf(a)), q.mode === 'hold' ? q.until : null)
    const failures = this.store.requestsByStatus(['blocked']).map((r) => ({ title: r.text.replace(/\s+/g, ' ').slice(0, 30), reason: r.note ?? '' }))
    const merged = this.store.requestsByStatus(['merged']).filter((r) => this.now() - Date.parse(r.updated_at) < 10 * 60_000).at(-1)
    const waiting = this.readyTasks().length + this.store.tasksByStatus(['reviewing']).filter((t) => !this.store.liveAttempts().some((a) => a.task_id === t.id)).length
    const headline = buildHeadline({ decisions, failures, workers, ceoThinking: this.store.requestsByStatus(['thinking']).length > 0, waiting, quota: q,
      recentMerged: merged ? merged.text.replace(/\s+/g, ' ').slice(0, 40) : null, reviewFollows: (id) => this.store.task(id)?.review_model !== 'none', teams })
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
    const lstart = await Promise.resolve().then(() => this.probe.lstart(pid)).catch(() => null)
    this.store.updateAttempt(att.id, { status: 'running', pid, lstart, started_at: att.started_at ?? this.iso() })
    this.track(this.store.attempt(att.id)!, pid, lstart, att.started_at ?? this.iso(), null)
  }

  findOrphan(sessionId: string): Promise<number | null> { return findOrphan(sessionId) }

  requestRow(id: string): RequestRow | null { return this.store.request(id) }

  /** Offers the merge card again for a project whose integration is still valid (recovery when HEAD is still the target). */
  reofferIntegrated(requestId: string, projectId: string): void { this.store.tx(() => { this.store.putMerge(requestId, projectId, { state: 'integrated' }) }) }
}

