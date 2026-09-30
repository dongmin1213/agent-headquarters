// Web detail UI (docs/design/execution.md §15). Serves the single-page "자세히 보기" screen and proxies
// /ui-api/* to the daemon's /api/* handlers behind cookie + CSRF auth.
//   GET  /ui/open?code=…   one-time code (60 s) → hq_session cookie, then /ui
//   GET  /ui               the page (401 page without a session)
//   GET  /ui/assets/*      static assets read at startup
//   *    /ui-api/*         cookie; non-GET also X-CSRF-Token + Origin → routeApi as /api/* with the Bearer token
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiRouter } from '../server.ts'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WebUi {
  /** Handles /ui, /ui/*, /ui-api/* (cookie + CSRF auth, then delegates /ui-api/* to routeApi as /api/*). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** One-time login URL (60 s) the pet opens in the browser. */
  issueLoginUrl(): string
}

export const CODE_TTL_MS = 60_000
export const SESSION_IDLE_MS = 12 * 60 * 60_000
const COOKIE = 'hq_session'

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
}

const ASSET_TYPES: Record<string, string> = {
  'app.js': 'text/javascript; charset=utf-8',
  'lib.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
}

interface Session { csrf: string; lastSeen: number }

export function createWebUi(opts: { port: number; token: string; routeApi: ApiRouter; now?: () => number }): WebUi {
  const now = opts.now ?? Date.now
  const origin = `http://127.0.0.1:${opts.port}`
  const host = `127.0.0.1:${opts.port}`
  const codes = new Map<string, number>() // code → expiresAt
  const sessions = new Map<string, Session>()
  const dir = join(import.meta.dirname, 'assets')
  const assets = new Map<string, Buffer>()
  for (const name of Object.keys(ASSET_TYPES)) assets.set(name, readFileSync(join(dir, name)))
  const pageTemplate = readFileSync(join(dir, 'index.html'), 'utf8')

  function prune(): void {
    const t = now()
    for (const [c, exp] of codes) if (exp <= t) codes.delete(c)
    for (const [id, s] of sessions) if (t - s.lastSeen > SESSION_IDLE_MS) sessions.delete(id)
  }

  function session(req: IncomingMessage): Session | null {
    const id = readCookie(req, COOKIE)
    if (!id) return null
    const s = sessions.get(id)
    if (!s) return null
    if (now() - s.lastSeen > SESSION_IDLE_MS) { sessions.delete(id); return null }
    s.lastSeen = now()
    return s
  }

  return {
    issueLoginUrl() {
      prune()
      const code = randomBytes(24).toString('base64url')
      codes.set(code, now() + CODE_TTL_MS)
      return `${origin}/ui/open?code=${code}`
    },

    async handle(req, res) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
      res.setHeader('cache-control', 'no-store')
      // DNS rebinding: only the exact loopback host:port this daemon listens on.
      if (req.headers.host !== host) return text(res, 403, 'forbidden host')
      const url = new URL(req.url ?? '/', origin)
      const path = url.pathname

      if (path === '/ui/open') {
        if (req.method !== 'GET') return text(res, 405, 'method not allowed')
        prune()
        const code = url.searchParams.get('code') ?? ''
        const exp = codes.get(code)
        codes.delete(code) // single use, even when expired
        if (!code || exp === undefined || exp <= now()) return page(res, 403, messagePage('링크가 만료됐어요', "이 링크는 한 번만, 60초 안에 쓸 수 있어요. 펫에서 '자세히 보기'를 다시 눌러 주세요."))
        const id = randomBytes(32).toString('base64url')
        sessions.set(id, { csrf: randomBytes(32).toString('base64url'), lastSeen: now() })
        res.setHeader('set-cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`)
        // A same-origin meta refresh instead of a 30x: a Strict cookie is not sent on a redirect chain
        // that started from another site (e.g. a link clicked in a chat app).
        return page(res, 200, messagePage('여는 중…', '잠시만요. 자동으로 넘어가지 않으면 아래를 눌러 주세요.', true))
      }

      if (path.startsWith('/ui/assets/')) {
        const name = path.slice('/ui/assets/'.length)
        const body = assets.get(name)
        if (!body || req.method !== 'GET') return text(res, 404, 'not found')
        // CSS is public so the sign-in message pages are styled; scripts only with a session.
        if (name !== 'app.css' && !session(req)) return text(res, 401, 'unauthorized')
        res.writeHead(200, { 'content-type': ASSET_TYPES[name] })
        return void res.end(body)
      }

      if (path === '/ui' || path === '/ui/') {
        if (req.method !== 'GET') return text(res, 405, 'method not allowed')
        const s = session(req)
        if (!s) return page(res, 401, messagePage('로그인이 필요해요', "펫에서 '자세히 보기'로 열어 주세요"))
        return page(res, 200, pageTemplate.replace('{{CSRF}}', s.csrf))
      }

      if (path.startsWith('/ui-api/')) {
        const s = session(req)
        if (!s) return json(res, 401, { error: 'unauthorized' })
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (req.headers.origin !== origin) return json(res, 403, { error: 'bad origin' })
          if (!safeEqual(String(req.headers['x-csrf-token'] ?? ''), s.csrf)) return json(res, 403, { error: 'bad csrf token' })
        }
        req.url = '/api/' + (req.url ?? '').slice('/ui-api/'.length)
        req.headers.authorization = `Bearer ${opts.token}`
        delete req.headers.origin
        delete req.headers.cookie
        delete req.headers['x-csrf-token']
        return opts.routeApi(req, res)
      }

      return text(res, 404, 'not found')
    },
  }
}

function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** HTML-escapes text for the few server-rendered strings (all constants today). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function messagePage(title: string, message: string, toUi = false): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${toUi ? '<meta http-equiv="refresh" content="0;url=/ui">' : ''}<link rel="icon" href="data:,"><link rel="stylesheet" href="/ui/assets/app.css">
<title>HQ · ${escapeHtml(title)}</title></head><body class="message-page"><main class="message-card"><div class="brand-mark" aria-hidden="true">HQ</div>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${toUi ? '<p><a class="btn btn-primary" href="/ui">자세히 보기 열기</a></p>' : ''}</main></body></html>`
}

function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
