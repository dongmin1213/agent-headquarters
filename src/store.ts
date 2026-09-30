// SQLite persistence (node:sqlite, no dependencies). Schema version in `pragma user_version` (execution.md §4).
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Approval, HqEvent, RunRecord } from './types.ts'

export interface RequestRow { id: string; project: string; text: string; status: string; session_id: string | null; turns: number; corrections: number; plan: string | null; plan_hash: string | null; note: string | null; cost_usd: number; created_at: string; updated_at: string }
export interface QuestionRow { id: string; requestId: string; question: string; options: string[]; default: string; reason: string; answer: string | null }

export interface TaskRow {
  id: string; request_id: string; key: string; project: string; title: string; role: string; grade: string; model: string
  review_model: string; spec: string; revision: number; status: string; attempts: number; limited_streak: number
  review_invalid: number; revise_turns: number; branch: string | null; worktree: string | null; base_sha: string | null
  head_sha: string | null; checks_state: string | null; resume_session: string | null; report_sha: string | null
  diagnosis: string | null; generation: number; block_count: number; note: string | null; updated_at: string
}
export interface AttemptRow {
  id: string; task_id: string; kind: string; n: number; model: string; status: string; session_id: string; pid: number | null
  lstart: string | null; attempt_token: string; dir: string; started_at: string | null; ended_at: string | null; cost_usd: number | null
  input_tokens: number | null; output_tokens: number | null; outcome: string | null; reason: string | null
  generation: number; bash_runs: string | null
}
export interface QuotaRow { window: string; utilization: number | null; resets_at: string | null; status: string | null; observed_at: string }
export interface MergeRow {
  request_id: string; project: string; target: string | null; target_sha: string | null; integration_sha: string | null
  state: string; result_sha: string | null; note: string | null; diagnosis: string | null; updated_at: string
  /** JSON `{ sha, items: [{ id, command }] }`: base-failed checks the chairman accepted for exactly this integration_sha. */
  known_failures: string | null
}
export interface TaskQuestionRow { id: string; task_id: string; attempt_id: string | null; revision: number; question: string; options: string[]; default: string; answer: string | null; created_at: string }
export interface ApprovalRow extends Approval { revision: number; kind: string; subjectId: string | null; state: string }

const SCHEMA_VERSION = 6
/** Cards fixed to a subject hash never expire (execution.md §12). */
export const NO_EXPIRY = '9999-12-31T00:00:00.000Z'

const TASK_COLS = new Set(['title', 'role', 'grade', 'model', 'review_model', 'spec', 'revision', 'status', 'attempts', 'limited_streak', 'review_invalid',
  'revise_turns', 'branch', 'worktree', 'base_sha', 'head_sha', 'checks_state', 'resume_session', 'report_sha', 'diagnosis', 'generation', 'block_count', 'note'])
const ATTEMPT_COLS = new Set(['model', 'status', 'session_id', 'pid', 'lstart', 'started_at', 'ended_at', 'cost_usd', 'input_tokens', 'output_tokens', 'outcome', 'reason', 'bash_runs'])
const MERGE_COLS = new Set(['target', 'target_sha', 'integration_sha', 'state', 'result_sha', 'note', 'diagnosis', 'known_failures'])
type Val = string | number | null

const kindOf = (id: string) => (/^(plan|accept|merge|revise|integration|team|system):/.exec(id)?.[1] ?? 'team')

export class Store {
  private db: DatabaseSync
  private txDepth = 0

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      pragma journal_mode = wal;
      pragma busy_timeout = 5000;
      create table if not exists runs (
        id integer primary key autoincrement, team_id text not null, started_at text not null,
        ended_at text, exit_code integer, summary text);
      create table if not exists events (
        id integer primary key autoincrement, at text not null, kind text not null,
        team_id text, text text not null, data text);
      create table if not exists kv (key text primary key, value text not null);
      create table if not exists requests (
        id text primary key, project text not null, text text not null, status text not null,
        session_id text, turns integer not null default 0, corrections integer not null default 0,
        plan text, plan_hash text, note text, cost_usd real not null default 0,
        created_at text not null, updated_at text not null);
      create table if not exists request_questions (
        id text primary key, request_id text not null, question text not null, options text not null,
        default_option text not null, reason text not null, answer text, created_at text not null);
    `)
    this.migrate()
  }

  private migrate(): void {
    const v = Number((this.db.prepare('pragma user_version').get() as { user_version: number }).user_version)
    if (v >= SCHEMA_VERSION) return
    this.tx(() => {
      // v1 approvals had one row per id; v2 keeps every revision of a card.
      const cols = (this.db.prepare("select name from pragma_table_info('approvals')").all() as { name: string }[]).map((c) => c.name)
      if (cols.length && !cols.includes('revision')) this.db.exec('alter table approvals rename to approvals_v1')
      this.db.exec(`
        create table if not exists approvals (
          id text not null, revision integer not null, team_id text not null, kind text not null, subject_id text,
          title text not null, body text not null, options text not null, subject_hash text not null, expires_at text not null,
          created_at text not null, state text not null default 'open', decision text, decided_at text,
          primary key (id, revision));
        create table if not exists tasks (
          id text primary key, request_id text not null, key text not null, project text not null,
          title text not null, role text not null, grade text not null, model text not null, review_model text not null,
          spec text not null, revision integer not null default 0, status text not null,
          attempts integer not null default 0, limited_streak integer not null default 0,
          review_invalid integer not null default 0, revise_turns integer not null default 0,
          branch text, worktree text, base_sha text, head_sha text, checks_state text, resume_session text, report_sha text,
          diagnosis text, note text, updated_at text not null);
        create index if not exists tasks_request on tasks (request_id);
        create table if not exists attempts (
          id text primary key, task_id text not null, kind text not null, n integer not null, model text not null,
          status text not null, session_id text not null, pid integer, lstart text, attempt_token text not null, dir text not null,
          started_at text, ended_at text, cost_usd real, input_tokens integer, output_tokens integer, outcome text, reason text,
          unique (task_id, kind, n));
        create table if not exists quota (window text primary key, utilization real, resets_at text, status text, observed_at text not null);
        create table if not exists merges (
          request_id text not null, project text not null, target text, target_sha text, integration_sha text,
          state text not null, result_sha text, note text, diagnosis text, updated_at text not null, primary key (request_id, project));
        create table if not exists task_questions (
          id text primary key, task_id text not null, attempt_id text, revision integer not null, question text not null,
          options text not null, default_option text not null, answer text, created_at text not null);
      `)
      if (cols.length && !cols.includes('revision')) {
        this.db.exec(`insert into approvals (id, revision, team_id, kind, subject_id, title, body, options, subject_hash, expires_at, created_at, state, decision, decided_at)
          select id, 0, team_id, case when id like 'plan:%' then 'plan' else 'team' end, null, title, body, options, subject_hash, expires_at, created_at,
            case when decision is null then 'open' else 'decided' end, decision, decided_at from approvals_v1;
          drop table approvals_v1;`)
      }
      const addColumn = (tbl: string, col: string, decl: string) => {
        const have = (this.db.prepare(`select name from pragma_table_info('${tbl}')`).all() as { name: string }[]).map((c) => c.name)
        if (!have.includes(col)) this.db.exec(`alter table ${tbl} add column ${col} ${decl}`)
      }
      // schema 3: diagnosis columns (execution.md §17 decision explanations).
      addColumn('tasks', 'diagnosis', 'text'); addColumn('merges', 'diagnosis', 'text')
      // schema 4 (contract v3): generations, per-block decision revision, reviewer Bash evidence.
      addColumn('tasks', 'generation', 'integer not null default 0'); addColumn('tasks', 'block_count', 'integer not null default 0')
      addColumn('attempts', 'generation', 'integer not null default 0'); addColumn('attempts', 'bash_runs', 'text')
      // schema 5: team run process identity (adopted after a daemon restart) and the scoped token's hash.
      addColumn('runs', 'pid', 'integer'); addColumn('runs', 'lstart', 'text'); addColumn('runs', 'token_hash', 'text')
      // schema 6: base-failed integration checks the chairman accepted, bound to one integration SHA.
      addColumn('merges', 'known_failures', 'text')
      if (v === 2 || v === 3) this.convertV2Execution()
      this.db.exec(`pragma user_version = ${SCHEMA_VERSION}`)
    })
  }

  /**
   * Execution rows written by the v2 engine used shared-.git worktrees that v3 no longer trusts (§6.1).
   * Unfinished work is parked as blocked with a retry hint; results that passed keep their SHAs (the mirror fetches them).
   */
  private convertV2Execution(): void {
    const live = "('executing', 'blocked', 'awaiting_acceptance', 'accepted', 'merging')"
    const note = 'v3 전환: 다시 시작하려면 한 번 더'
    this.db.prepare(`update attempts set status = 'failed', reason = 'v3 전환', ended_at = ? where status in ('starting', 'running')`).run(new Date().toISOString())
    this.db.prepare(`update tasks set status = 'blocked', note = ?, block_count = block_count + 1, worktree = null, resume_session = null
      where status not in ('passed', 'cancelled') and request_id in (select id from requests where status in ${live})`).run(note)
    this.db.exec(`update tasks set worktree = null where request_id in (select id from requests where status in ${live})`)
    this.db.exec(`delete from merges where request_id in (select id from requests where status in ${live}) and state != 'merged'`)
    this.db.exec(`update approvals set state = 'superseded' where state = 'open' and kind in ('accept', 'merge', 'integration', 'revise')`)
    this.db.prepare(`update requests set status = 'blocked', note = ? where status in ${live}`).run(note)
  }

  /** Runs fn in one IMMEDIATE transaction (nested calls join the outer one). fn must be synchronous. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) { this.txDepth++; try { return fn() } finally { this.txDepth-- } }
    this.db.exec('begin immediate')
    this.txDepth = 1
    try { const r = fn(); this.db.exec('commit'); return r } catch (e) { this.db.exec('rollback'); throw e } finally { this.txDepth = 0 }
  }

  close(): void { this.db.close() }

  /** Escape hatch for tests and one-off diagnostics. */
  raw(): DatabaseSync { return this.db }

  // ----- teams -----
  startRun(teamId: string): number {
    const r = this.db.prepare('insert into runs (team_id, started_at) values (?, ?)').run(teamId, new Date().toISOString())
    return Number(r.lastInsertRowid)
  }

  endRun(id: number, exitCode: number, summary: string): void {
    this.db.prepare('update runs set ended_at = ?, exit_code = ?, summary = ? where id = ?')
      .run(new Date().toISOString(), exitCode, summary.slice(0, 2000), id)
  }

  /** Records the team process (pid, `ps` start time or null) and the sha256 of its scoped API token. */
  setRunProcess(id: number, pid: number, lstart: string | null, tokenHash: string): void {
    this.db.prepare('update runs set pid = ?, lstart = ?, token_hash = ? where id = ?').run(pid, lstart, tokenHash, id)
  }

  runProcess(id: number): { pid: number | null; lstart: string | null; tokenHash: string | null } | null {
    const r = this.db.prepare('select pid, lstart, token_hash from runs where id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) return null
    return { pid: r.pid == null ? null : Number(r.pid), lstart: r.lstart == null ? null : String(r.lstart), tokenHash: r.token_hash == null ? null : String(r.token_hash) }
  }

  lastRun(teamId: string): RunRecord | null {
    const row = this.db.prepare('select * from runs where team_id = ? order by id desc limit 1').get(teamId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: Number(row.id), teamId: String(row.team_id), startedAt: String(row.started_at),
      endedAt: row.ended_at == null ? null : String(row.ended_at),
      exitCode: row.exit_code == null ? null : Number(row.exit_code),
      summary: row.summary == null ? null : String(row.summary),
    }
  }

  addEvent(e: HqEvent): number {
    const r = this.db.prepare('insert into events (at, kind, team_id, text, data) values (?, ?, ?, ?, ?)')
      .run(e.at, e.kind, e.teamId ?? null, e.text, e.data === undefined ? null : JSON.stringify(e.data))
    return Number(r.lastInsertRowid)
  }

  lastEventId(): number {
    const row = this.db.prepare('select max(id) m from events').get() as { m: number | null }
    return row.m ?? 0
  }

  // ----- approvals (cards) -----
  /** Creates a card, or supersedes the open one with the same id and adds a new revision. Returns the revision. */
  putApproval(a: { id: string; teamId: string; title: string; body: string; options: string[]; subjectHash: string; expiresAt?: string | null; subjectId?: string | null; kind?: string }): number {
    return this.tx(() => {
      const prev = this.db.prepare('select max(revision) m from approvals where id = ?').get(a.id) as { m: number | null }
      this.db.prepare("update approvals set state = 'superseded' where id = ? and state = 'open'").run(a.id)
      const rev = prev.m === null ? 0 : prev.m + 1
      this.db.prepare(`insert into approvals (id, revision, team_id, kind, subject_id, title, body, options, subject_hash, expires_at, created_at, state)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`).run(a.id, rev, a.teamId, a.kind ?? kindOf(a.id), a.subjectId ?? null, a.title, a.body,
        JSON.stringify(a.options), a.subjectHash, a.expiresAt ?? NO_EXPIRY, new Date().toISOString())
      return rev
    })
  }

  /** Team cards: first registration wins; a later POST with the same id is a no-op. */
  upsertApproval(a: Omit<Approval, 'decision' | 'decidedAt'>): void {
    if (this.approval(a.id)) return
    this.putApproval({ id: a.id, teamId: a.teamId, title: a.title, body: a.body, options: a.options, subjectHash: a.subjectHash, expiresAt: a.expiresAt })
  }

  /** Closes the open revision without a decision (the subject changed or the request ended). */
  supersede(id: string): void {
    this.db.prepare("update approvals set state = 'superseded' where id = ? and state = 'open'").run(id)
  }

  /** Decides only if the latest revision is open, unexpired, the option exists, and the caller saw the same subject hash. */
  decide(id: string, decision: string, subjectHash: string, now = Date.now()): ApprovalRow | null {
    return this.tx(() => {
      const a = this.approval(id)
      if (!a || a.state !== 'open' || !a.options.includes(decision)) return null
      if (a.subjectHash !== subjectHash || Date.parse(a.expiresAt) <= now) return null
      this.db.prepare("update approvals set state = 'decided', decision = ?, decided_at = ? where id = ? and revision = ?").run(decision, new Date().toISOString(), id, a.revision)
      return this.approval(id)
    })
  }

  /** Latest revision of a card. */
  approval(id: string): ApprovalRow | null {
    const row = this.db.prepare('select * from approvals where id = ? order by revision desc limit 1').get(id) as Record<string, unknown> | undefined
    return row ? toApproval(row) : null
  }

  openApprovals(now = Date.now()): ApprovalRow[] {
    return (this.db.prepare("select * from approvals where state = 'open' and expires_at > ? order by created_at, id").all(new Date(now).toISOString()) as Record<string, unknown>[]).map(toApproval)
  }

  /** Open cards past their expiry (plan cards only have one). */
  expiredApprovals(now = Date.now()): ApprovalRow[] {
    return (this.db.prepare("select * from approvals where state = 'open' and expires_at <= ?").all(new Date(now).toISOString()) as Record<string, unknown>[]).map(toApproval)
  }

  // ----- chairman requests (CEO turns) -----
  addRequest(id: string, project: string, text: string): void {
    const now = new Date().toISOString()
    this.db.prepare('insert into requests (id, project, text, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)').run(id, project, text, 'queued', now, now)
  }

  updateRequest(id: string, f: Partial<{ status: string; session_id: string; turns: number; corrections: number; plan: string | null; plan_hash: string | null; note: string | null; cost_usd: number }>): void {
    const keys = Object.keys(f)
    if (!keys.length) return
    this.db.prepare(`update requests set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? where id = ?`)
      .run(...keys.map((k) => (f as Record<string, Val>)[k]), new Date().toISOString(), id)
  }

  request(id: string): RequestRow | null {
    return (this.db.prepare('select * from requests where id = ?').get(id) as RequestRow | undefined) ?? null
  }

  requests(limit = 20): RequestRow[] {
    return this.db.prepare('select * from requests order by created_at desc limit ?').all(limit) as unknown as RequestRow[]
  }

  requestsByStatus(statuses: string[]): RequestRow[] {
    return this.db.prepare(`select * from requests where status in (${statuses.map(() => '?').join(',')}) order by created_at, rowid`).all(...statuses) as unknown as RequestRow[]
  }

  nextQueued(): RequestRow | null {
    return (this.db.prepare("select * from requests where status = 'queued' order by created_at limit 1").get() as RequestRow | undefined) ?? null
  }

  addQuestions(requestId: string, qs: { id: string; question: string; options: string[]; default: string; reason: string }[]): void {
    const now = new Date().toISOString()
    const s = this.db.prepare('insert into request_questions (id, request_id, question, options, default_option, reason, created_at) values (?, ?, ?, ?, ?, ?, ?)')
    for (const q of qs) s.run(q.id, requestId, q.question, JSON.stringify(q.options), q.default, q.reason, now)
  }

  questions(requestId: string): QuestionRow[] {
    return (this.db.prepare('select * from request_questions where request_id = ? order by created_at, id').all(requestId) as Record<string, unknown>[])
      .map((r) => ({ id: String(r.id), requestId: String(r.request_id), question: String(r.question), options: JSON.parse(String(r.options)) as string[],
        default: String(r.default_option), reason: String(r.reason), answer: r.answer == null ? null : String(r.answer) }))
  }

  /** Answers once, and only a question owned by that request; false otherwise. */
  answer(requestId: string, questionId: string, answer: string): boolean {
    const r = this.db.prepare('update request_questions set answer = ? where id = ? and request_id = ? and answer is null').run(answer, questionId, requestId)
    return Number(r.changes) === 1
  }

  get(key: string): string | null {
    const row = this.db.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  set(key: string, value: string | null): void {
    if (value === null) this.db.prepare('delete from kv where key = ?').run(key)
    else this.db.prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value)
  }

  // ----- execution: tasks -----
  insertTask(t: Pick<TaskRow, 'id' | 'request_id' | 'key' | 'project' | 'title' | 'role' | 'grade' | 'model' | 'review_model' | 'spec' | 'status' | 'branch' | 'base_sha'>): void {
    this.db.prepare(`insert into tasks (id, request_id, key, project, title, role, grade, model, review_model, spec, status, branch, base_sha, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.id, t.request_id, t.key, t.project, t.title, t.role, t.grade, t.model, t.review_model,
      t.spec, t.status, t.branch, t.base_sha, new Date().toISOString())
  }

  updateTask(id: string, f: Partial<Omit<TaskRow, 'id' | 'request_id' | 'key' | 'project' | 'updated_at'>>): void {
    const keys = Object.keys(f)
    for (const k of keys) if (!TASK_COLS.has(k)) throw new Error(`bad task column ${k}`)
    if (!keys.length) return
    this.db.prepare(`update tasks set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? where id = ?`)
      .run(...keys.map((k) => (f as Record<string, Val>)[k]), new Date().toISOString(), id)
  }

  /** Generation-guarded transition (§7.7): applies only while the task is still in `generation`. Returns whether it applied. */
  updateTaskIf(id: string, generation: number, f: Partial<Omit<TaskRow, 'id' | 'request_id' | 'key' | 'project' | 'updated_at'>>): boolean {
    const keys = Object.keys(f)
    for (const k of keys) if (!TASK_COLS.has(k)) throw new Error(`bad task column ${k}`)
    if (!keys.length) return (this.task(id)?.generation ?? -1) === generation
    const r = this.db.prepare(`update tasks set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? where id = ? and generation = ?`)
      .run(...keys.map((k) => (f as Record<string, Val>)[k]), new Date().toISOString(), id, generation)
    return Number(r.changes) === 1
  }

  task(id: string): TaskRow | null { return (this.db.prepare('select * from tasks where id = ?').get(id) as TaskRow | undefined) ?? null }

  /** Plan order (insertion order). */
  tasks(requestId: string): TaskRow[] { return this.db.prepare('select * from tasks where request_id = ? order by rowid').all(requestId) as unknown as TaskRow[] }

  /** Request created_at, then plan order. */
  tasksByStatus(statuses: string[]): TaskRow[] {
    return this.db.prepare(`select t.* from tasks t join requests r on r.id = t.request_id where t.status in (${statuses.map(() => '?').join(',')}) order by r.created_at, r.rowid, t.rowid`)
      .all(...statuses) as unknown as TaskRow[]
  }

  // ----- attempts -----
  insertAttempt(a: Pick<AttemptRow, 'id' | 'task_id' | 'kind' | 'n' | 'model' | 'status' | 'attempt_token' | 'dir' | 'session_id'> & { generation?: number }): void {
    this.db.prepare('insert into attempts (id, task_id, kind, n, model, status, attempt_token, dir, session_id, generation) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.task_id, a.kind, a.n, a.model, a.status, a.attempt_token, a.dir, a.session_id, a.generation ?? 0)
  }

  /** Attempt numbers only ever grow per kind (§7.1), independent of the rework counter. */
  nextAttemptN(taskId: string, kind: string): number {
    return Number((this.db.prepare('select coalesce(max(n), 0) + 1 n from attempts where task_id = ? and kind = ?').get(taskId, kind) as { n: number }).n)
  }

  updateAttempt(id: string, f: Partial<Omit<AttemptRow, 'id' | 'task_id' | 'kind' | 'n' | 'attempt_token' | 'dir'>>): void {
    const keys = Object.keys(f)
    for (const k of keys) if (!ATTEMPT_COLS.has(k)) throw new Error(`bad attempt column ${k}`)
    if (!keys.length) return
    this.db.prepare(`update attempts set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`).run(...keys.map((k) => (f as Record<string, Val>)[k]), id)
  }

  attempt(id: string): AttemptRow | null { return (this.db.prepare('select * from attempts where id = ?').get(id) as AttemptRow | undefined) ?? null }

  attempts(taskId: string): AttemptRow[] { return this.db.prepare('select * from attempts where task_id = ? order by rowid').all(taskId) as unknown as AttemptRow[] }

  liveAttempts(): AttemptRow[] { return this.db.prepare("select * from attempts where status in ('starting', 'running') order by rowid").all() as unknown as AttemptRow[] }

  // ----- quota -----
  quotaRows(): QuotaRow[] { return this.db.prepare('select * from quota order by window').all() as unknown as QuotaRow[] }

  setQuotaWindow(q: QuotaRow): void {
    this.db.prepare(`insert into quota (window, utilization, resets_at, status, observed_at) values (?, ?, ?, ?, ?)
      on conflict(window) do update set utilization = excluded.utilization, resets_at = excluded.resets_at, status = excluded.status, observed_at = excluded.observed_at`)
      .run(q.window, q.utilization, q.resets_at, q.status, q.observed_at)
  }

  // ----- merges -----
  mergeRow(requestId: string, project: string): MergeRow | null {
    return (this.db.prepare('select * from merges where request_id = ? and project = ?').get(requestId, project) as MergeRow | undefined) ?? null
  }

  mergeRows(requestId: string): MergeRow[] { return this.db.prepare('select * from merges where request_id = ? order by rowid').all(requestId) as unknown as MergeRow[] }

  putMerge(requestId: string, project: string, f: Partial<Omit<MergeRow, 'request_id' | 'project' | 'updated_at'>>): void {
    for (const k of Object.keys(f)) if (!MERGE_COLS.has(k)) throw new Error(`bad merge column ${k}`)
    const now = new Date().toISOString()
    if (!this.mergeRow(requestId, project)) this.db.prepare("insert into merges (request_id, project, state, updated_at) values (?, ?, 'pending', ?)").run(requestId, project, now)
    const keys = Object.keys(f)
    if (keys.length) this.db.prepare(`update merges set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? where request_id = ? and project = ?`)
      .run(...keys.map((k) => (f as Record<string, Val>)[k]), now, requestId, project)
  }

  // ----- worker questions -----
  addTaskQuestions(taskId: string, attemptId: string | null, revision: number, qs: { id: string; question: string; options: string[]; default: string }[]): void {
    const now = new Date().toISOString()
    const s = this.db.prepare('insert into task_questions (id, task_id, attempt_id, revision, question, options, default_option, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const q of qs) s.run(q.id, taskId, attemptId, revision, q.question, JSON.stringify(q.options), q.default, now)
  }

  taskQuestions(taskId: string, attemptId?: string | null): TaskQuestionRow[] {
    const rows = (attemptId === undefined
      ? this.db.prepare('select * from task_questions where task_id = ? order by created_at, rowid').all(taskId)
      : this.db.prepare('select * from task_questions where task_id = ? and attempt_id is ? order by created_at, rowid').all(taskId, attemptId)) as Record<string, unknown>[]
    return rows.map((r) => ({ id: String(r.id), task_id: String(r.task_id), attempt_id: r.attempt_id == null ? null : String(r.attempt_id), revision: Number(r.revision),
      question: String(r.question), options: JSON.parse(String(r.options)) as string[], default: String(r.default_option),
      answer: r.answer == null ? null : String(r.answer), created_at: String(r.created_at) }))
  }

  answerTaskQuestion(id: string, answer: string): boolean {
    return Number(this.db.prepare('update task_questions set answer = ? where id = ? and answer is null').run(answer, id).changes) === 1
  }
}

function toApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: String(row.id), teamId: String(row.team_id), title: String(row.title), body: String(row.body),
    options: JSON.parse(String(row.options)) as string[], createdAt: String(row.created_at),
    subjectHash: String(row.subject_hash), expiresAt: String(row.expires_at),
    decision: row.decision == null ? null : String(row.decision),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    revision: Number(row.revision), kind: String(row.kind), subjectId: row.subject_id == null ? null : String(row.subject_id), state: String(row.state),
  }
}

/**
 * One-time move of the old database (execution.md §4): VACUUM INTO a temp file (captures WAL-only commits),
 * integrity_check, then rename. The original is left in place. Returns true when a copy was made.
 */
export function migrateDb(oldPath: string, newPath: string): boolean {
  if (existsSync(newPath) || !existsSync(oldPath)) return false
  mkdirSync(dirname(newPath), { recursive: true })
  const tmp = `${newPath}.migrating-${process.pid}`
  rmSync(tmp, { force: true })
  const src = new DatabaseSync(oldPath)
  try { src.prepare('vacuum into ?').run(tmp) } finally { src.close() }
  const check = new DatabaseSync(tmp)
  try {
    const r = check.prepare('pragma integrity_check').get() as Record<string, unknown>
    if (Object.values(r)[0] !== 'ok') throw new Error(`DB 이전 무결성 검사 실패: ${JSON.stringify(r)}`)
    check.prepare("insert into kv (key, value) values ('migrated_from', ?) on conflict(key) do update set value = excluded.value").run(oldPath)
  } catch (e) { check.close(); rmSync(tmp, { force: true }); throw e }
  check.close()
  renameSync(tmp, newPath)
  return true
}
