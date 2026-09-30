// Local API for the pet, the CLI and team commands (execution.md §15). Binds to 127.0.0.1 only.
// Every error body is {"error": "<한국어 사유>"}; wrong state or stale revision → 409.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { Bus } from './bus.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store, TaskRow } from './store.ts'
import type { AttemptView, RequestDetail, RequestView, Snapshot } from './types.ts'
import type { RequestEngine } from './engine.ts'
import type { Project } from './ceo.ts'
import type { Runner } from './exec/runner.ts'
import { hqDirOf, outDirOf, taskView } from './exec/decisions.ts'
import { git } from './exec/git.ts'
import { readText } from './exec/fsx.ts'
import { lastActivityOf } from './exec/stream.ts'
import { DONE_MAX, readOut, REPORT_MAX } from './exec/contract.ts'
import { createWebUi } from './web/index.ts'

const BODY_MAX = 64 * 1024
const FILE_MAX = 1024 * 1024
const DIFF_MAX = 2 * 1024 * 1024
const ACTIVITY_MAX = 500
const RESERVED = /^(plan|accept|merge|revise|integration):/
/** Evidence files the API serves, and which folder of the attempt they live in. */
const FILES: Record<string, 'out' | 'hq'> = { 'report.md': 'out', 'done.json': 'out', 'checks.json': 'hq', 'verdict.json': 'hq', 'stderr.log': 'hq' }

// Pet/CLI requests carry the app token and come from localhost without a browser Origin,
// so a web page or another user cannot forge an approval.
function authorized(req: IncomingMessage, token: string, port: number): boolean {
  if ((req.headers.host ?? '') !== `127.0.0.1:${port}`) return false
  if (req.headers.origin) return false
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export type ApiRouter = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export interface ServerDeps { port: number; store: Store; bus: Bus; scheduler: Scheduler; token: string; engine: RequestEngine; runner: Runner; projects: Project[] }

function requestView(store: Store, runner: Runner, id: string): RequestView | null {
  const r = store.request(id)
  if (!r) return null
  const plan = r.plan ? JSON.parse(r.plan) : null
  return { id: r.id, project: r.project, text: r.text, status: r.status, note: r.note, turns: r.turns, costUsd: r.cost_usd,
    questions: store.questions(r.id),
    tasks: store.tasks(r.id).map((t) => taskView(store, t, (a) => runner.live.get(a.id)?.tail.lastActivity ?? lastActivityOf(hqDirOf(a)))),
    plan: plan && { summary: plan.summary, assumptions: plan.assumptions, tasks: plan.tasks.map((x: Record<string, string>) => ({ id: x.id, title: x.title, project: x.project, role: x.role, grade: x.grade, model: x.model })) },
    updatedAt: r.updated_at }
}

export function snapshot(d: ServerDeps): Snapshot {
  const recent = d.store.requests(10)
  const active = d.store.requestsByStatus(['queued', 'thinking', 'asking', 'planned', 'executing', 'blocked', 'awaiting_acceptance', 'accepted', 'merging'])
  const ids = [...new Set([...active.map((r) => r.id), ...recent.map((r) => r.id)])]
  const teams = d.scheduler.views()
  const v = d.runner.views(teams.map((t) => ({ name: t.name, state: t.state, bubble: t.bubble })))
  return { updatedAt: new Date().toISOString(), lastEventId: d.store.lastEventId(), teams, approvals: d.store.openApprovals(),
    requests: ids.map((id) => requestView(d.store, d.runner, id)!).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    projects: d.projects.map((p) => ({ id: p.id, name: p.name })), limit: { blockedUntil: d.runner.holdUntil() },
    workers: v.workers, headline: v.headline, quota: v.quota, decisions: v.decisions }
}

function attemptView(a: { id: string; task_id: string; kind: string; n: number; model: string; status: string; started_at: string | null; ended_at: string | null; cost_usd: number | null; reason: string | null }): AttemptView {
  return { id: a.id, taskId: a.task_id, kind: a.kind as AttemptView['kind'], n: a.n, model: a.model, status: a.status as AttemptView['status'],
    startedAt: a.started_at, endedAt: a.ended_at, costUsd: a.cost_usd, reason: a.reason }
}

export function createApi(d: ServerDeps): ApiRouter {
  const { store, bus, scheduler, engine, runner, projects } = d
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // Path ids are decoded exactly once.
      let parts: string[]
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch { throw new HttpError(400, '경로 인코딩이 잘못됐습니다') }
      const m = req.method ?? 'GET'
      const is = (method: string, ...shape: (string | null)[]) => m === method && parts.length === shape.length && shape.every((s, i) => s === null || s === parts[i])
      const ok = (data: unknown, status = 200) => json(res, status, data)
      const conflict = (err: string | null, data: unknown = { ok: true }) => (err ? json(res, 409, { error: err }) : json(res, 200, data))

      if (is('GET', 'api', 'state')) return ok(snapshot(d))
      if (is('GET', 'api', 'events')) return bus.subscribe(res)
      if (is('GET', 'api', 'quota')) return ok(runner.quotaView() ?? { windows: [], fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, mode: runner.quota().mode, observedAt: null })

      if (is('GET', 'api', 'requests', null)) {
        const view = requestView(store, runner, parts[2])
        if (!view) throw new HttpError(404, '요청이 없습니다')
        const detail: RequestDetail = { request: view, tasks: store.tasks(parts[2]).map((t) => ({ ...view.tasks.find((x) => x.id === t.id)!, spec: JSON.parse(t.spec),
          branch: t.branch, baseSha: t.base_sha, attemptsList: store.attempts(t.id).map(attemptView) })) }
        return ok(detail)
      }
      if (is('GET', 'api', 'requests', null, 'diff')) {
        const key = url.searchParams.get('task') ?? ''
        const t = store.tasks(parts[2]).find((x) => x.key === key)
        if (!t) throw new HttpError(404, '작업이 없습니다')
        return ok(await taskDiff(t, projects))
      }
      if (is('GET', 'api', 'attempts', null, 'activity')) {
        const a = store.attempt(parts[2])
        if (!a) throw new HttpError(404, '시도가 없습니다')
        const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0)
        const all = (readText(join(hqDirOf(a), 'activity.jsonl'), 16 * 1024 * 1024) ?? '').split('\n').filter(Boolean)
        const lines = all.slice(after, after + ACTIVITY_MAX).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        return ok({ lines, next: after + lines.length })
      }
      if (is('GET', 'api', 'attempts', null, 'files', null)) {
        const a = store.attempt(parts[2])
        const where = Object.hasOwn(FILES, parts[4]) ? FILES[parts[4]] : null
        if (!a || !where) throw new HttpError(404, '허용되지 않은 파일이거나 시도가 없습니다')
        // The name only selects from the allow list; the folder always comes from the DB row.
        const dir = where === 'out' ? outDirOf(a) : hqDirOf(a)
        const text = readOut(dir, parts[4], parts[4] === 'done.json' ? DONE_MAX : parts[4] === 'report.md' ? REPORT_MAX : FILE_MAX)
        if (text === null) throw new HttpError(404, '파일이 없거나 너무 큽니다')
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
        return void res.end(text)
      }

      if (m === 'POST' && parts[0] === 'api' && parts[1] === 'requests') {
        const b = await body(req)
        if (parts.length === 2) {
          if (!str(b.text) || b.text.length > 4000) throw new HttpError(400, 'text(1~4000자)가 필요합니다')
          const project = str(b.project) ? b.project : projects[0]?.id
          if (!projects.some((p) => p.id === project)) throw new HttpError(400, '등록되지 않은 프로젝트입니다')
          return ok({ id: engine.submit(b.text, project!) }, 201)
        }
        const id = parts[2]
        if (parts.length === 4 && parts[3] === 'answer') {
          if (!str(b.questionId) || !str(b.answer)) throw new HttpError(400, 'questionId와 answer가 필요합니다')
          return conflict(engine.answer(id, b.questionId, b.answer))
        }
        if (parts.length === 4 && parts[3] === 'reject') {
          if (!str(b.reason) || !b.reason.trim()) throw new HttpError(400, '반려 사유(reason)가 필요합니다')
          if (!str(b.subjectHash)) throw new HttpError(400, '수락 카드의 subjectHash가 필요합니다')
          if (b.tasks !== undefined && (!Array.isArray(b.tasks) || !b.tasks.every(str))) throw new HttpError(400, 'tasks는 작업 key 목록이어야 합니다')
          return conflict(runner.rejectResult(id, b.reason.trim().slice(0, 2000), b.subjectHash, b.tasks))
        }
        if (parts.length === 4 && parts[3] === 'cancel') return conflict(runner.cancelRequest(id))
        if (parts.length === 4 && parts[3] === 'merge') return conflict(runner.reofferMerge(id))
      }
      if (m === 'POST' && parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 4) {
        const b = await body(req)
        if (!Number.isInteger(b.revision)) throw new HttpError(400, 'revision(정수)이 필요합니다')
        if (parts[3] === 'answer') {
          if (!str(b.questionId) || !str(b.answer)) throw new HttpError(400, 'questionId와 answer가 필요합니다')
          return conflict(runner.answerTask(parts[2], b.questionId, b.answer, b.revision))
        }
        if (parts[3] === 'decide') {
          if (!str(b.decision)) throw new HttpError(400, 'decision이 필요합니다')
          if (!['retry', 'skip', 'stop'].includes(b.decision)) throw new HttpError(400, 'decision은 retry | skip | stop 중 하나여야 합니다')
          return conflict(runner.decideTask(parts[2], b.decision, b.revision))
        }
      }

      if (parts[0] === 'api' && parts[1] === 'approvals') {
        if (is('POST', 'api', 'approvals')) {
          const b = await body(req)
          if (!str(b.id) || !str(b.teamId) || !str(b.title) || !str(b.subjectHash) || !Array.isArray(b.options) || b.options.length === 0)
            throw new HttpError(400, 'id, teamId, title, subjectHash, options가 필요합니다')
          if (RESERVED.test(b.id) || !b.id.startsWith(`team:${b.teamId}:`)) throw new HttpError(400, `팀 카드 id는 "team:${b.teamId}:"로 시작해야 합니다`)
          const minutes = Math.min(Math.max(Number(b.expiresInMinutes ?? 24 * 60), 1), 7 * 24 * 60)
          store.upsertApproval({ id: b.id, teamId: b.teamId, title: b.title, body: str(b.body) ? b.body : '', options: b.options.map(String),
            subjectHash: b.subjectHash, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(), createdAt: new Date().toISOString() })
          bus.emit({ kind: 'approval', teamId: b.teamId, text: `승인 요청: ${b.title}`, data: { id: b.id } })
          return ok(store.approval(b.id), 201)
        }
        if (is('GET', 'api', 'approvals', null)) { const a = store.approval(parts[2]); if (!a) throw new HttpError(404, '카드가 없습니다'); return ok(a) }
        if (is('POST', 'api', 'approvals', null)) {
          const b = await body(req)
          if (!str(b.decision) || !str(b.subjectHash)) throw new HttpError(400, 'decision과 subjectHash가 필요합니다')
          const card = store.approval(parts[2])
          if (card?.kind === 'team') {
            const a = store.decide(parts[2], b.decision, b.subjectHash, runner.now())
            if (!a) throw new HttpError(409, '카드가 없거나, 만료·결정·교체됐거나, 내용이 바뀌었거나, 없는 선택지입니다')
            bus.emit({ kind: 'approval', teamId: a.teamId, text: `결정: ${a.title} → ${a.decision}`, data: { id: a.id } })
            scheduler.runNow(a.teamId)
            return ok(a)
          }
          // Card consumption and the state transition happen in one runner transaction; replays get the same answer.
          const r = await runner.decide(parts[2], b.decision, b.subjectHash)
          return json(res, r.status, r.body)
        }
      }
      if (is('POST', 'api', 'teams', null, 'run')) {
        return scheduler.runNow(parts[2]) ? ok({ started: true }, 202) : json(res, 409, { error: '없는 팀이거나 이미 실행 중이거나 한도 보류 중입니다' })
      }
      json(res, 404, { error: '없는 경로입니다' })
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message })
      console.error('[hq api]', e)
      json(res, 500, { error: `서버 오류: ${String(e).slice(0, 200)}` })
    }
  }
}

async function taskDiff(t: TaskRow, projects: Project[]): Promise<{ files: { path: string; added: number; removed: number }[]; diff: string; truncated: boolean }> {
  const p = projects.find((x) => x.id === t.project)
  if (!p || !t.base_sha || !t.head_sha || t.role !== 'implement') return { files: [], diff: '', truncated: false }
  const num = await git(p.path, ['diff', '--numstat', '--no-renames', t.base_sha, t.head_sha])
  const files = num.stdout.split('\n').filter(Boolean).map((l) => { const [a, r, ...path] = l.split('\t'); return { path: path.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 } })
  const d = await git(p.path, ['diff', '--no-color', '--no-ext-diff', t.base_sha, t.head_sha], 64 * 1024 * 1024)
  const truncated = Buffer.byteLength(d.stdout) > DIFF_MAX
  return { files, diff: truncated ? Buffer.from(d.stdout).subarray(0, DIFF_MAX).toString('utf8') : d.stdout, truncated }
}

export function startServer(d: ServerDeps) {
  const routeApi = createApi(d)
  const web = createWebUi({ port: d.port, token: d.token, routeApi })
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/ui' || path.startsWith('/ui/') || path.startsWith('/ui-api/')) return await web.handle(req, res)
      if (!authorized(req, d.token, d.port)) return json(res, 401, { error: '인증되지 않았습니다' })
      if (path === '/api/ui-code' && req.method === 'POST') return json(res, 200, { url: web.issueLoginUrl() })
      await routeApi(req, res)
    } catch (e) {
      json(res, 500, { error: `서버 오류: ${String(e).slice(0, 200)}` })
    }
  })
  server.listen(d.port, '127.0.0.1')
  return server
}

function json(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}

function str(v: unknown): v is string { return typeof v === 'string' && v.length > 0 }

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = ''
  for await (const chunk of req) { raw += chunk; if (raw.length > BODY_MAX) throw new HttpError(413, '본문이 너무 큽니다 (64KB 제한)') }
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error()
    return v
  } catch { throw new HttpError(400, 'JSON 본문이 잘못됐습니다') }
}
