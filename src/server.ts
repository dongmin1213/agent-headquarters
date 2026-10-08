// Local API for the pet, the CLI and team commands (execution.md §15). Binds to 127.0.0.1 only.
// Every error body is {"error": "<한국어 사유>"}; wrong state or stale revision → 409.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Bus } from './bus.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store, TaskRow } from './store.ts'
import type { AttemptView, RequestDetail, RequestView, Snapshot } from './types.ts'
import type { RequestEngine } from './engine.ts'
import type { Project } from './ceo.ts'
import type { Runner } from './exec/runner.ts'
import { hqDirOf, lingeringOf, outDirOf, recommendMerges, RELEASE, taskView } from './exec/decisions.ts'
import { GAME_REASSESS, GAME_KEEP_HOLD } from './game.ts'
import { hqGit, SAFE_DIFF } from './exec/repos.ts'
import { SERVER_ERROR } from './humanize.ts'
import { readText } from './exec/fsx.ts'
import { lastActivityOf } from './exec/stream.ts'
import { DONE_MAX, readOut, REPORT_MAX } from './exec/contract.ts'
import { createWebUi } from './web/index.ts'
import { gameEnabled } from './game.ts'

const BODY_MAX = 64 * 1024
const FILE_MAX = 1024 * 1024
const DIFF_MAX = 2 * 1024 * 1024
const ACTIVITY_MAX = 500
const RESERVED = /^(plan|accept|merge|revise|integration):/
/** Evidence files the API serves, and which folder of the attempt they live in. */
const FILES: Record<string, 'out' | 'hq'> = { 'report.md': 'out', 'done.json': 'out', 'checks.json': 'hq', 'verdict.json': 'hq', 'stderr.log': 'hq' }

// Pet/CLI requests carry the app token and come from localhost without a browser Origin,
// so a web page or another user cannot forge an approval. A team run's scoped token is a narrower caller.
export type Caller = { kind: 'master' } | { kind: 'team'; teamId: string }
const MASTER: Caller = { kind: 'master' }
const TEAM_FORBIDDEN = '팀 토큰으로는 할 수 없는 요청이에요'

function authorize(req: IncomingMessage, token: string, port: number, scheduler: Scheduler): Caller | null {
  if ((req.headers.host ?? '') !== `127.0.0.1:${port}`) return null
  if (req.headers.origin) return null
  const raw = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
  const got = Buffer.from(raw)
  const want = Buffer.from(token)
  if (got.length === want.length && timingSafeEqual(got, want)) return MASTER
  const teamId = scheduler.teamOfToken(raw)
  return teamId ? { kind: 'team', teamId } : null
}

/** A team may read the quota, post its own cards and read them back — never decide or see anything else. */
function teamMayCall(method: string, parts: string[], teamId: string): boolean {
  const p = parts.join('/')
  if (method === 'GET' && p === 'api/quota') return true
  if (method === 'POST' && p === 'api/approvals') return true
  return method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'approvals' && parts[2].startsWith(`team:${teamId}:`)
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export type ApiRouter = (req: IncomingMessage, res: ServerResponse, caller?: Caller) => Promise<void>

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
  for (const p of d.projects.filter(p => p.workflow === 'game')) {
    const enabled = gameEnabled(d.store, p.id)
    const jobs = active.filter(r => r.project === p.id)
    const latest = recent.find(r => r.project === p.id)
    const failed = latest?.status === 'failed' ? latest : null
    const tasks = jobs.flatMap(r => d.store.tasks(r.id))
    const running = tasks.some(t => ['running', 'verifying'].includes(t.status)) || d.store.liveAttempts().some(a => tasks.some(t => t.id === a.task_id))
    const waiting = tasks.find(t => ['blocked', 'question', 'held'].includes(t.status) || /연결 복구 대기/.test(t.note ?? ''))
    const stalled = waiting && !running && !d.runner.readyTasks().some(t => t.project === p.id) && !d.runner.ceoLock.busy

    teams.push({ id: `game:${p.id}`, name: p.name, pack: 'pokemon', kind: 'game', project: p.id, enabled,
      state: !enabled ? 'idle' : stalled ? 'error' : jobs.length ? 'working' : failed ? 'error' : 'idle',
      bubble: !enabled ? '꺼짐 · 현재 작업 뒤 다음 배정은 쉽니다' : stalled ? `복구·결정 대기: ${waiting.note ?? waiting.title}` : jobs.length ? `게임팀 ${jobs.length}건 진행 · 팀장이 제작하고 피카츄가 검수해요` : failed ? `완성 미달: ${failed.note ?? '작업 실패'}` : '새 요청을 기다려요 · 기획부터 출시 후보까지', lastRun: null, nextRunAt: null })
  }
  const v = d.runner.views(teams.map((t) => ({ name: t.name, state: t.state, bubble: t.bubble })))
  const models: Record<string, string> = d.runner.cfg.models
  const workers = v.workers.map(w => ({ ...w, model: models[w.model] ?? w.model }))
  const headline = { ...v.headline, text: v.headline.text.replace(/ · (haiku|sonnet|opus)(?= ·|$)/g, (_, alias: string) => ` · ${models[alias]}`) }
  return { models, updatedAt: new Date().toISOString(), lastEventId: d.store.lastEventId(), teams, approvals: d.store.openApprovals(),
    requests: ids.map((id) => requestView(d.store, d.runner, id)!).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    projects: d.projects.map((p) => ({ id: p.id, name: p.name })), limit: { blockedUntil: d.runner.holdUntil() },
    workers, headline, quota: v.quota, decisions: recommendMerges(v.decisions, d.store, (project, branch) => branchSha(d.projects, project, branch)) }
}

/** The branch tip in the user's checkout right now (read-only rev-parse), or null when it cannot be read. */
function branchSha(projects: Project[], projectId: string, branch: string): string | null {
  const p = projects.find((x) => x.id === projectId)
  if (!p) return null
  try {
    return execFileSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { cwd: p.path, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }).trim() || null
  } catch { return null }
}

function attemptView(a: { id: string; task_id: string; kind: string; n: number; model: string; status: string; started_at: string | null; ended_at: string | null; cost_usd: number | null; reason: string | null }): AttemptView {
  return { id: a.id, taskId: a.task_id, kind: a.kind as AttemptView['kind'], n: a.n, model: a.model, status: a.status as AttemptView['status'],
    startedAt: a.started_at, endedAt: a.ended_at, costUsd: a.cost_usd, reason: a.reason }
}

export function createApi(d: ServerDeps): ApiRouter {
  const { store, bus, scheduler, engine, runner, projects } = d
  return async (req, res, caller = MASTER) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // Path ids are decoded exactly once.
      let parts: string[]
      try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch { throw new HttpError(400, '경로 인코딩이 잘못됐습니다') }
      const m = req.method ?? 'GET'
      const is = (method: string, ...shape: (string | null)[]) => m === method && parts.length === shape.length && shape.every((s, i) => s === null || s === parts[i])
      const ok = (data: unknown, status = 200) => json(res, status, data)
      const conflict = (err: string | null, data: unknown = { ok: true }) => (err ? json(res, 409, { error: err }) : json(res, 200, data))
      if (caller.kind === 'team' && !teamMayCall(m, parts, caller.teamId)) throw new HttpError(403, TEAM_FORBIDDEN)

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
        return ok(await taskDiff(t, runner.mirror(t.project)))
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
          if (!['retry', 'skip', 'stop', RELEASE, GAME_REASSESS, GAME_KEEP_HOLD].includes(b.decision)) throw new HttpError(400, '지원하지 않는 작업 결정입니다')
          // release forgets an earlier worker that may still run: only offered (and accepted) while one is recorded.
          if (b.decision === RELEASE) { const t = store.task(parts[2]); if (!t || !lingeringOf(t)) throw new HttpError(400, 'release는 이전 작업자가 남아 있을 때만 쓸 수 있습니다') }
          return conflict(runner.decideTask(parts[2], b.decision, b.revision))
        }
      }

      if (parts[0] === 'api' && parts[1] === 'approvals') {
        if (is('POST', 'api', 'approvals')) {
          const b = await body(req)
          if (!str(b.id) || !str(b.teamId) || !str(b.title) || !str(b.subjectHash) || !Array.isArray(b.options) || b.options.length === 0)
            throw new HttpError(400, 'id, teamId, title, subjectHash, options가 필요합니다')
          if (caller.kind === 'team' && b.teamId !== caller.teamId) throw new HttpError(403, TEAM_FORBIDDEN)
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
      if (is('POST', 'api', 'teams', null, 'enabled')) {
        const b = await body(req)
        if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled는 true 또는 false여야 합니다')
        const project = projects.find(p => p.workflow === 'game' && `game:${p.id}` === parts[2])
        if (project) {
          store.set(`game.enabled:${project.id}`, String(b.enabled))
          bus.emit({ kind: 'team', teamId: parts[2], text: b.enabled ? '게임팀 켜짐' : '게임팀 꺼짐 · 현재 작업 종료 후 다음 배정을 쉽니다' })
          if (b.enabled) { runner.kick(); void engine.tick() }
          return ok({ enabled: b.enabled })
        }
        if (!scheduler.setEnabled(parts[2], b.enabled)) throw new HttpError(404, '없는 팀입니다')
        return ok({ enabled: b.enabled })
      }
      json(res, 404, { error: '없는 경로입니다' })
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message })
      console.error('[hq api]', e)
      json(res, 500, { error: SERVER_ERROR })
    }
  }
}

type DiffBody = { files: { path: string; added: number; removed: number }[]; diff: string; truncated: boolean }

/**
 * A task's change, read from hq's mirror (execution.md §6.1): before merge, worker commits exist only there,
 * never in the user's checkout. Three outcomes: files; truly empty (base == head tree); unreadable → HttpError 409
 * with a short Korean reason (the raw git output goes to the daemon log), so the page never shows "변경 사항이 없어요" by mistake.
 */
export async function taskDiff(t: TaskRow, mirror: string): Promise<DiffBody> {
  if (t.role !== 'implement' || !t.head_sha) return { files: [], diff: '', truncated: false }
  const fail = (why: string, raw?: string): never => {
    if (raw) console.error(`[hq api] diff ${t.id}: ${raw.trim().slice(0, 500)}`)
    throw new HttpError(409, `변경 내용을 읽지 못했어요: ${why}`)
  }
  if (!t.base_sha) fail('기준 커밋이 기록되지 않았어요')
  if (!existsSync(join(mirror, 'HEAD'))) fail('hq 미러가 없어요')
  const run = async (args: string[], maxBuffer?: number) => {
    const r = await hqGit(mirror, null, [...args, ...SAFE_DIFF, t.base_sha!, t.head_sha!, '--'], { maxBuffer })
    if (r.code !== 0) fail(/bad object|bad revision|unknown revision|Not a valid object|invalid object/i.test(r.stderr) ? '커밋이 hq 미러에 없어요' : 'git diff가 실패했어요', r.stderr || r.stdout)
    return r.stdout
  }
  const num = await run(['diff', '--numstat', '--no-renames'])
  const files = num.split('\n').filter(Boolean).map((l) => { const [a, r, ...path] = l.split('\t'); return { path: path.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 } })
  const d = await run(['diff', '--no-color', '--no-renames'], 64 * 1024 * 1024)
  const truncated = Buffer.byteLength(d) > DIFF_MAX
  return { files, diff: truncated ? Buffer.from(d).subarray(0, DIFF_MAX).toString('utf8') : d, truncated }
}

export function startServer(d: ServerDeps) {
  const routeApi = createApi(d)
  const web = createWebUi({ port: d.port, token: d.token, routeApi })
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/ui' || path.startsWith('/ui/') || path.startsWith('/ui-api/')) return await web.handle(req, res)
      const caller = authorize(req, d.token, d.port, d.scheduler)
      if (!caller) return json(res, 401, { error: '인증되지 않았습니다' })
      if (path === '/api/ui-code' && req.method === 'POST') {
        if (caller.kind !== 'master') return json(res, 403, { error: TEAM_FORBIDDEN })
        return json(res, 200, { url: web.issueLoginUrl() })
      }
      await routeApi(req, res, caller)
    } catch (e) {
      console.error('[hq server]', e)
      json(res, 500, { error: SERVER_ERROR })
    }
  })
  server.listen(d.port, '127.0.0.1')
  return server
}

function json(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'x-hq': '1' })
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
