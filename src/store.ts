// SQLite persistence (node:sqlite, no dependencies). One file per company under .data/.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Approval, HqEvent, RunRecord } from './types.ts'

export interface TaskRow {
  id: string; request_id: string; task_key: string; project: string; title: string; role: string; grade: string; model: string
  spec: string; review_brief: string | null; status: string; attempts: number; branch: string | null; worktree: string | null
  base_sha: string | null; head_sha: string | null; note: string | null; updated_at: string
}
export interface AttemptRow {
  id: string; task_id: string; kind: string; n: number; model: string; status: string; session_id: string | null; pid: number | null
  attempt_token: string; dir: string; started_at: string | null; ended_at: string | null; cost_usd: number | null
  input_tokens: number | null; output_tokens: number | null; outcome: string | null; reason: string | null
}
export interface QuotaRow { five_hour: number | null; seven_day: number | null; five_hour_resets_at: string | null; seven_day_resets_at: string | null; status: string | null; observed_at: string | null }

const TASK_COLS = new Set(['title', 'role', 'grade', 'model', 'spec', 'review_brief', 'status', 'attempts', 'branch', 'worktree', 'base_sha', 'head_sha', 'note'])
const ATTEMPT_COLS = new Set(['model', 'status', 'session_id', 'pid', 'started_at', 'ended_at', 'cost_usd', 'input_tokens', 'output_tokens', 'outcome', 'reason'])
type Val = string | number | null

export interface RequestRow { id: string; project: string; text: string; status: string; session_id: string | null; turns: number; corrections: number; plan: string | null; plan_hash: string | null; note: string | null; cost_usd: number; created_at: string; updated_at: string }
export interface QuestionRow { id: string; requestId: string; question: string; options: string[]; default: string; reason: string; answer: string | null }

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists runs (
        id integer primary key autoincrement, team_id text not null, started_at text not null,
        ended_at text, exit_code integer, summary text);
      create table if not exists events (
        id integer primary key autoincrement, at text not null, kind text not null,
        team_id text, text text not null, data text);
      create table if not exists approvals (
        id text primary key, team_id text not null, title text not null, body text not null,
        options text not null, subject_hash text not null, expires_at text not null,
        created_at text not null, decision text, decided_at text);
      create table if not exists kv (key text primary key, value text not null);
      create table if not exists requests (
        id text primary key, project text not null, text text not null, status text not null,
        session_id text, turns integer not null default 0, corrections integer not null default 0,
        plan text, plan_hash text, note text, cost_usd real not null default 0,
        created_at text not null, updated_at text not null);
      create table if not exists request_questions (
        id text primary key, request_id text not null, question text not null, options text not null,
        default_option text not null, reason text not null, answer text, created_at text not null);
      create table if not exists tasks (
        id text primary key, request_id text not null, task_key text not null, project text not null,
        title text not null, role text not null, grade text not null, model text not null,
        spec text not null, review_brief text, status text not null,
        attempts integer not null default 0,
        branch text, worktree text, base_sha text, head_sha text,
        note text, updated_at text not null);
      create index if not exists tasks_request on tasks (request_id);
      create table if not exists attempts (
        id text primary key, task_id text not null, kind text not null,
        n integer not null, model text not null, status text not null,
        session_id text, pid integer, attempt_token text not null, dir text not null,
        started_at text, ended_at text, cost_usd real, input_tokens integer, output_tokens integer,
        outcome text, reason text);
      create index if not exists attempts_task on attempts (task_id);
      create table if not exists quota (id integer primary key check (id = 1), five_hour real, seven_day real,
        five_hour_resets_at text, seven_day_resets_at text, status text, observed_at text);
    `)
  }

  private txDepth = 0
  /** Runs fn in one IMMEDIATE transaction (nested calls join the outer one). fn must be synchronous. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) { this.txDepth++; try { return fn() } finally { this.txDepth-- } }
    this.db.exec('begin immediate')
    this.txDepth = 1
    try { const r = fn(); this.db.exec('commit'); return r } catch (e) { this.db.exec('rollback'); throw e } finally { this.txDepth = 0 }
  }

  close(): void { this.db.close() }

  // ----- execution: tasks / attempts / quota -----
  insertTask(t: Omit<TaskRow, 'updated_at' | 'attempts' | 'head_sha'> & { attempts?: number; head_sha?: string | null }): void {
    this.db.prepare(`insert into tasks (id, request_id, task_key, project, title, role, grade, model, spec, review_brief, status, attempts, branch, worktree, base_sha, head_sha, note, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.id, t.request_id, t.task_key, t.project, t.title, t.role, t.grade, t.model, t.spec,
      t.review_brief, t.status, t.attempts ?? 0, t.branch, t.worktree, t.base_sha, t.head_sha ?? null, t.note, new Date().toISOString())
  }

  updateTask(id: string, f: Partial<Omit<TaskRow, 'id' | 'request_id' | 'task_key' | 'project' | 'updated_at'>>): void {
    const keys = Object.keys(f).filter((k) => { if (!TASK_COLS.has(k)) throw new Error(`bad task column ${k}`); return true })
    if (!keys.length) return
    this.db.prepare(`update tasks set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? where id = ?`)
      .run(...keys.map((k) => (f as Record<string, Val>)[k]), new Date().toISOString(), id)
  }

  task(id: string): TaskRow | null { return (this.db.prepare('select * from tasks where id = ?').get(id) as TaskRow | undefined) ?? null }

  /** Plan order (insertion order). */
  tasks(requestId: string): TaskRow[] { return this.db.prepare('select * from tasks where request_id = ? order by rowid').all(requestId) as unknown as TaskRow[] }

  tasksByStatus(statuses: string[]): TaskRow[] {
    return this.db.prepare(`select t.* from tasks t join requests r on r.id = t.request_id where t.status in (${statuses.map(() => '?').join(',')}) order by r.created_at, t.rowid`)
      .all(...statuses) as unknown as TaskRow[]
  }

  insertAttempt(a: Pick<AttemptRow, 'id' | 'task_id' | 'kind' | 'n' | 'model' | 'status' | 'attempt_token' | 'dir'> & { session_id?: string | null }): void {
    this.db.prepare('insert into attempts (id, task_id, kind, n, model, status, attempt_token, dir, session_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.task_id, a.kind, a.n, a.model, a.status, a.attempt_token, a.dir, a.session_id ?? null)
  }

  updateAttempt(id: string, f: Partial<Omit<AttemptRow, 'id' | 'task_id' | 'kind' | 'n' | 'attempt_token' | 'dir'>>): void {
    const keys = Object.keys(f).filter((k) => { if (!ATTEMPT_COLS.has(k)) throw new Error(`bad attempt column ${k}`); return true })
    if (!keys.length) return
    this.db.prepare(`update attempts set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`).run(...keys.map((k) => (f as Record<string, Val>)[k]), id)
  }

  attempt(id: string): AttemptRow | null { return (this.db.prepare('select * from attempts where id = ?').get(id) as AttemptRow | undefined) ?? null }

  attempts(taskId: string): AttemptRow[] { return this.db.prepare('select * from attempts where task_id = ? order by rowid').all(taskId) as unknown as AttemptRow[] }

  liveAttempts(): AttemptRow[] { return this.db.prepare("select * from attempts where status in ('starting', 'running') order by rowid").all() as unknown as AttemptRow[] }

  quota(): QuotaRow | null { return (this.db.prepare('select * from quota where id = 1').get() as QuotaRow | undefined) ?? null }

  setQuota(q: QuotaRow): void {
    this.db.prepare(`insert into quota (id, five_hour, seven_day, five_hour_resets_at, seven_day_resets_at, status, observed_at) values (1, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set five_hour = excluded.five_hour, seven_day = excluded.seven_day, five_hour_resets_at = excluded.five_hour_resets_at,
      seven_day_resets_at = excluded.seven_day_resets_at, status = excluded.status, observed_at = excluded.observed_at`)
      .run(q.five_hour, q.seven_day, q.five_hour_resets_at, q.seven_day_resets_at, q.status, q.observed_at)
  }

  requestsByStatus(statuses: string[]): RequestRow[] {
    return this.db.prepare(`select * from requests where status in (${statuses.map(() => '?').join(',')}) order by created_at`).all(...statuses) as unknown as RequestRow[]
  }

  /** Creates or replaces a card (a replaced card is open again, with the new subject hash). */
  putApproval(a: Omit<Approval, 'decision' | 'decidedAt'>): void {
    this.db.prepare(`insert into approvals (id, team_id, title, body, options, subject_hash, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set team_id = excluded.team_id, title = excluded.title, body = excluded.body, options = excluded.options,
      subject_hash = excluded.subject_hash, expires_at = excluded.expires_at, created_at = excluded.created_at, decision = null, decided_at = null`)
      .run(a.id, a.teamId, a.title, a.body, JSON.stringify(a.options), a.subjectHash, a.expiresAt, a.createdAt)
  }

  /** Closes an open card without a chairman decision (e.g. the request was cancelled). */
  closeApproval(id: string, why: string): void {
    this.db.prepare('update approvals set decision = ?, decided_at = ? where id = ? and decision is null').run(why, new Date().toISOString(), id)
  }

  startRun(teamId: string): number {
    const r = this.db.prepare('insert into runs (team_id, started_at) values (?, ?)').run(teamId, new Date().toISOString())
    return Number(r.lastInsertRowid)
  }

  endRun(id: number, exitCode: number, summary: string): void {
    this.db.prepare('update runs set ended_at = ?, exit_code = ?, summary = ? where id = ?')
      .run(new Date().toISOString(), exitCode, summary.slice(0, 2000), id)
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

  upsertApproval(a: Omit<Approval, 'decision' | 'decidedAt'>): void {
    this.db.prepare(`insert into approvals (id, team_id, title, body, options, subject_hash, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do nothing`).run(a.id, a.teamId, a.title, a.body, JSON.stringify(a.options), a.subjectHash, a.expiresAt, a.createdAt)
  }

  /** Decides only if still open, unexpired, the option exists, and the caller saw the same subject hash. */
  decide(id: string, decision: string, subjectHash: string): Approval | null {
    const a = this.approval(id)
    if (!a || a.decision !== null || !a.options.includes(decision)) return null
    if (a.subjectHash !== subjectHash || Date.parse(a.expiresAt) <= Date.now()) return null
    const r = this.db.prepare('update approvals set decision = ?, decided_at = ? where id = ? and decision is null and subject_hash = ?').run(decision, new Date().toISOString(), id, subjectHash)
    return Number(r.changes) === 1 ? this.approval(id) : null
  }

  approval(id: string): Approval | null {
    const row = this.db.prepare('select * from approvals where id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toApproval(row) : null
  }

  openApprovals(): Approval[] {
    const now = new Date().toISOString()
    return (this.db.prepare('select * from approvals where decision is null and expires_at > ? order by created_at').all(now) as Record<string, unknown>[]).map(toApproval)
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
      .run(...keys.map((k) => (f as Record<string, string | number | null>)[k]), new Date().toISOString(), id)
  }

  request(id: string): RequestRow | null {
    return (this.db.prepare('select * from requests where id = ?').get(id) as RequestRow | undefined) ?? null
  }

  requests(limit = 20): RequestRow[] {
    return this.db.prepare('select * from requests order by created_at desc limit ?').all(limit) as unknown as RequestRow[]
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

  /** Answers once; returns false if unknown or already answered. */
  answer(questionId: string, answer: string): boolean {
    const r = this.db.prepare('update request_questions set answer = ? where id = ? and answer is null').run(answer, questionId)
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
}

function toApproval(row: Record<string, unknown>): Approval {
  return {
    id: String(row.id), teamId: String(row.team_id), title: String(row.title), body: String(row.body),
    options: JSON.parse(String(row.options)) as string[], createdAt: String(row.created_at),
    subjectHash: String(row.subject_hash), expiresAt: String(row.expires_at),
    decision: row.decision == null ? null : String(row.decision),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
  }
}
