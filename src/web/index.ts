// Web detail UI (docs/design/execution.md §16). Serves the single-page "자세히 보기" screen and proxies an
// allowlist of /ui-api/* to the daemon's /api/* handlers behind a cookie-less session token.
//   GET  /ui, /ui/           page shell (no auth; the page itself holds no data)
//   GET  /ui/assets/*        static assets read at startup
//   POST /ui-api/session     {code} → {token}   one-time code from issueLoginUrl() (60 s, single use)
//   *    /ui-api/<allowed>   Authorization: Bearer <session token> (events: ?t=<token> only) → routeApi as /api/*
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiRouter } from '../server.ts'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WebUi {
  /** Handles /ui, /ui/*, /ui-api/* (session token auth, then delegates allowed /ui-api/* to routeApi as /api/*). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** One-time login URL (60 s) the pet opens in the browser. */
  issueLoginUrl(): string
}

export const CODE_TTL_MS = 60_000
export const SESSION_IDLE_MS = 12 * 60 * 60_000
export const SESSION_MAX_MS = 7 * 24 * 60 * 60_000

/** Sent on every /ui* response, including ones produced by routeApi (execution.md §16). */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
}

const ASSET_TYPES: Record<string, string> = {
  'app.js': 'text/javascript; charset=utf-8',
  'lib.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
}

/** The only /api routes the browser may reach (`*` = one path segment). Everything else is 404. */
const ALLOWED: Record<string, string[][]> = {
  GET: [['state'], ['events'], ['requests', '*'], ['attempts', '*', 'activity'], ['attempts', '*', 'files', '*'], ['requests', '*', 'diff'], ['quota']],
  POST: [['requests'], ['requests', '*', 'answer'], ['tasks', '*', 'answer'], ['tasks', '*', 'decide'], ['requests', '*', 'reject'],
    ['requests', '*', 'cancel'], ['requests', '*', 'merge'], ['approvals', '*']],
}

export function isAllowed(method: string, segments: string[]): boolean {
  return (ALLOWED[method] ?? []).some((p) => p.length === segments.length && p.every((x, i) => (x === '*' ? segments[i].length > 0 : x === segments[i])))
}

interface Session { createdAt: number; lastSeen: number }

export function createWebUi(opts: { port: number; token: string; routeApi: ApiRouter; now?: () => number }): WebUi {
  const now = opts.now ?? Date.now
  const origin = `http://127.0.0.1:${opts.port}`
  const host = `127.0.0.1:${opts.port}`
  const codes = new Map<string, number>() // code → expiresAt
  const sessions = new Map<string, Session>() // token → session (in memory: a daemon restart signs everyone out)
  const dir = join(import.meta.dirname, 'assets')
  const assets = new Map<string, Buffer>()
  for (const name of Object.keys(ASSET_TYPES)) assets.set(name, readFileSync(join(dir, name)))
  const shell = readFileSync(join(dir, 'index.html'))

  const alive = (s: Session, t: number) => t - s.lastSeen <= SESSION_IDLE_MS && t - s.createdAt <= SESSION_MAX_MS
  function prune(): void {
    const t = now()
    for (const [c, exp] of codes) if (exp <= t) codes.delete(c)
    for (const [id, s] of sessions) if (!alive(s, t)) sessions.delete(id)
  }
  function session(token: string): boolean {
    if (!token) return false
    const s = sessions.get(token)
    if (!s) return false
    const t = now()
    if (!alive(s, t)) { sessions.delete(token); return false }
    s.lastSeen = t
    return true
  }

  return {
    issueLoginUrl() {
      prune()
      const code = randomBytes(32).toString('base64url')
      codes.set(code, now() + CODE_TTL_MS)
      return `${origin}/ui/#code=${code}`
    },

    async handle(req, res) {
      enforceHeaders(res)
      // DNS rebinding: only the exact loopback host:port this daemon listens on.
      if (req.headers.host !== host) return json(res, 403, { error: '허용되지 않은 Host예요' })
      const url = new URL(req.url ?? '/', origin)
      const path = url.pathname

      if (path === '/ui' || path === '/ui/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return void res.end(shell)
      }

      if (path.startsWith('/ui/assets/')) {
        const name = path.slice('/ui/assets/'.length)
        const body = assets.get(name)
        if (!body || req.method !== 'GET') return json(res, 404, { error: 'not found' })
        res.writeHead(200, { 'content-type': ASSET_TYPES[name] })
        return void res.end(body)
      }

      if (path === '/ui-api/session') {
        if (req.method !== 'POST') return json(res, 404, { error: 'not found' })
        let code = ''
        try { const b = JSON.parse(await readBody(req, 4096)); code = typeof b?.code === 'string' ? b.code : '' } catch { return json(res, 400, { error: '잘못된 요청이에요' }) }
        prune()
        // Consume in the same tick as the lookup: a code is only ever exchanged once.
        const exp = codes.get(code)
        codes.delete(code)
        if (!code || exp === undefined || exp <= now()) return json(res, 403, { error: "링크가 만료됐어요. 펫에서 '자세히 보기'를 다시 눌러 주세요." })
        const token = randomBytes(32).toString('base64url')
        sessions.set(token, { createdAt: now(), lastSeen: now() })
        return json(res, 200, { token })
      }

      if (path.startsWith('/ui-api/')) {
        const rest = path.slice('/ui-api/'.length)
        const segments = rest.split('/')
        if (!isAllowed(req.method ?? '', segments)) return json(res, 404, { error: 'not found' })
        const isEvents = req.method === 'GET' && rest === 'events'
        const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
        // EventSource cannot send headers, so the events stream (and only it) takes ?t=<token>.
        const token = bearer || (isEvents ? url.searchParams.get('t') ?? '' : '')
        if (!session(token)) return json(res, 401, { error: "세션이 없어요. 펫에서 '자세히 보기'로 열어 주세요." })
        if (isEvents) url.searchParams.delete('t')
        req.url = '/api/' + rest + url.search
        req.headers.authorization = `Bearer ${opts.token}`
        delete req.headers.origin
        delete req.headers.cookie
        return opts.routeApi(req, res)
      }

      return json(res, 404, { error: 'not found' })
    },
  }
}

/** Security headers win over anything a handler (e.g. routeApi's SSE) passes to writeHead. */
function enforceHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    const i = typeof rest[0] === 'string' ? 1 : 0
    const h = rest[i]
    if (h && typeof h === 'object' && !Array.isArray(h)) {
      const clean: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(h)) if (!(k.toLowerCase() in SECURITY_HEADERS)) clean[k] = v
      rest[i] = clean
    }
    return writeHead(status, ...rest)
  }) as ServerResponse['writeHead']
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  let raw = ''
  for await (const chunk of req) { raw += chunk; if (raw.length > max) throw new Error('body too large') }
  return raw
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
