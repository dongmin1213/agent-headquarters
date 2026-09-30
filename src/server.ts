// Local API for the pet and for team commands. Binds to 127.0.0.1 only.
//   GET  /api/state                 snapshot for the pet
//   GET  /api/events                server-sent events stream
//   POST /api/approvals             team registers {id, teamId, title, body, options}
//   GET  /api/approvals/:id         team polls for the chairman's decision
//   POST /api/approvals/:id         pet posts {decision}
//   POST /api/teams/:id/run         run a team now
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Bus } from './bus.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store } from './store.ts'
import type { RequestView, Snapshot } from './types.ts'
import type { RequestEngine } from './engine.ts'
import type { Project } from './ceo.ts'
import { timingSafeEqual } from 'node:crypto'
import { createWebUi } from './web/index.ts'

// Every request must carry the app token (from .data/token, mode 0600) and come from localhost
// without a browser Origin, so a web page or another user cannot forge an approval.
function authorized(req: IncomingMessage, token: string): boolean {
  const host = req.headers.host ?? ''
  if (!/^127\.0\.0\.1:\d+$/.test(host)) return false
  if (req.headers.origin) return false
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

function requestViews(store: Store): RequestView[] {
  return store.requests(10).map((r) => {
    const plan = r.plan ? JSON.parse(r.plan) : null
    return { id: r.id, project: r.project, text: r.text, status: r.status, note: r.note, turns: r.turns, costUsd: r.cost_usd,
      questions: store.questions(r.id), tasks: [],
      plan: plan && { summary: plan.summary, assumptions: plan.assumptions, tasks: plan.tasks.map((x: Record<string, string>) => ({ id: x.id, title: x.title, project: x.project, role: x.role, grade: x.grade, model: x.model })) },
      updatedAt: r.updated_at }
  })
}

export type ApiRouter = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function startServer(port: number, store: Store, bus: Bus, scheduler: Scheduler, token: string, engine: RequestEngine, projects: Project[]) {
  // /api/* handlers after authentication. The web UI (src/web) reuses them behind cookie + CSRF auth.
  const routeApi: ApiRouter = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean)
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const snap: Snapshot = { updatedAt: new Date().toISOString(), lastEventId: store.lastEventId(), teams: scheduler.views(),
          approvals: store.openApprovals(), requests: requestViews(store), projects: projects.map((p) => ({ id: p.id, name: p.name })),
          limit: { blockedUntil: scheduler.blockedUntil() }, workers: [], headline: { text: '', needsYou: 0 }, quota: null, decisions: [] }
        return json(res, 200, snap)
      }
      if (req.method === 'GET' && url.pathname === '/api/events') return bus.subscribe(res)
      if (parts[0] === 'api' && parts[1] === 'requests' && req.method === 'POST') {
        const b = await body(req)
        if (parts.length === 2) {
          if (!str(b.text) || b.text.length > 4000) return json(res, 400, { error: 'text (1-4000 chars) is required' })
          const project = str(b.project) ? b.project : projects[0].id
          if (!projects.some((p) => p.id === project)) return json(res, 400, { error: 'unknown project' })
          return json(res, 201, { id: engine.submit(b.text, project) })
        }
        if (parts.length === 4 && parts[3] === 'answer') {
          if (!str(b.questionId) || !str(b.answer)) return json(res, 400, { error: 'questionId and answer are required' })
          return engine.answer(decodeURIComponent(parts[2]), b.questionId, b.answer) ? json(res, 200, { ok: true }) : json(res, 409, { error: 'question unknown, already answered, or request not asking' })
        }
      }
      if (parts[0] === 'api' && parts[1] === 'approvals') {
        if (req.method === 'POST' && parts.length === 2) {
          const b = await body(req)
          if (!str(b.id) || !str(b.teamId) || !str(b.title) || !str(b.subjectHash) || !Array.isArray(b.options) || b.options.length === 0)
            return json(res, 400, { error: 'id, teamId, title, subjectHash, options are required' })
          const minutes = Math.min(Math.max(Number(b.expiresInMinutes ?? 24 * 60), 1), 7 * 24 * 60)
          store.upsertApproval({ id: b.id, teamId: b.teamId, title: b.title, body: str(b.body) ? b.body : '', options: b.options.map(String),
            subjectHash: b.subjectHash, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(), createdAt: new Date().toISOString() })
          bus.emit({ kind: 'approval', teamId: b.teamId, text: `승인 요청: ${b.title}`, data: { id: b.id } })
          return json(res, 201, store.approval(b.id))
        }
        if (parts.length === 3) {
          const id = decodeURIComponent(parts[2])
          if (req.method === 'GET') { const a = store.approval(id); return a ? json(res, 200, a) : json(res, 404, { error: 'not found' }) }
          if (req.method === 'POST') {
            const b = await body(req)
            const a = str(b.decision) && str(b.subjectHash) ? store.decide(id, b.decision, b.subjectHash) : null
            if (!a) return json(res, 409, { error: 'approval unknown, expired, already decided, subject changed, or decision not in options' })
            bus.emit({ kind: 'approval', teamId: a.teamId, text: `결정: ${a.title} → ${a.decision}`, data: { id } })
            if (a.id.startsWith('plan:')) engine.planDecided(a.id.slice(5), a.decision!)
            else scheduler.runNow(a.teamId) // let the team continue right away
            return json(res, 200, a)
          }
        }
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'teams' && parts[3] === 'run') {
        return scheduler.runNow(parts[2]) ? json(res, 202, { started: true }) : json(res, 409, { error: 'unknown team or already running' })
      }
      json(res, 404, { error: 'not found' })
  }
  const web = createWebUi({ port, token, routeApi })
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/ui' || path.startsWith('/ui/') || path.startsWith('/ui-api/')) return await web.handle(req, res)
      if (!authorized(req, token)) return json(res, 401, { error: 'unauthorized' })
      if (path === '/api/ui-code' && req.method === 'POST') return json(res, 200, { url: web.issueLoginUrl() })
      await routeApi(req, res)
    } catch (e) {
      json(res, 500, { error: String(e) })
    }
  })
  server.listen(port, '127.0.0.1')
  return server
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function str(v: unknown): v is string { return typeof v === 'string' && v.length > 0 }

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = ''
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('body too large') }
  return raw ? JSON.parse(raw) : {}
}
