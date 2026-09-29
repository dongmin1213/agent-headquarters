// SQLite persistence (node:sqlite, no dependencies). One file per company under .data/.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Approval, HqEvent, RunRecord } from './types.ts'

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
    `)
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
    this.db.prepare('update approvals set decision = ?, decided_at = ? where id = ?').run(decision, new Date().toISOString(), id)
    return this.approval(id)
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
