// Web UI auth + proxy tests (execution.md §16): #code → session token exchange, Bearer on /ui-api, query token only on
// events, Host check, allowlist, /ui-api → /api rewrite, security headers on every /ui* response.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWebUi, SECURITY_HEADERS, SESSION_IDLE_MS, SESSION_MAX_MS, type WebUi } from '../../src/web/index.ts'
import { createMockApi, type MockApi } from './mock-api.ts'

let server: Server
let web: WebUi
let mock: MockApi
let port = 0
let clock = Date.now()

before(async () => {
  mock = createMockApi()
  server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/ui' || path.startsWith('/ui/') || path.startsWith('/ui-api/')) return web.handle(req, res)
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  web = createWebUi({ port, token: 'mock-token', routeApi: mock.routeApi, now: () => clock })
})
after(() => { mock.close(); server.closeAllConnections(); server.close() })

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
const codeOf = (url: string) => new URL(url).hash.replace(/^#code=/, '')
const exchange = (code: string) => raw('POST', '/ui-api/session', { 'content-type': 'application/json' }, JSON.stringify({ code }))
async function login(): Promise<string> {
  const r = await exchange(codeOf(web.issueLoginUrl()))
  assert.equal(r.status, 200)
  const { token } = JSON.parse(r.body)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url')
  return token
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

test('issueLoginUrl returns /ui/#code=<32 random bytes> on 127.0.0.1', () => {
  const u = new URL(web.issueLoginUrl())
  assert.equal(u.origin, `http://127.0.0.1:${port}`)
  assert.equal(u.pathname, '/ui/')
  assert.equal(u.search, '')
  assert.match(u.hash, /^#code=[A-Za-z0-9_-]{43}$/)
})

test('/ui serves the page shell without auth and sets no cookie', async () => {
  for (const path of ['/ui', '/ui/']) {
    const r = await raw('GET', path)
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /text\/html/)
    assert.equal(r.headers['set-cookie'], undefined)
    assert.match(r.body, /펫에서 '자세히 보기'로 열어 주세요/, 'gate message is in the shell')
    assert.doesNotMatch(r.body, /csrf|hq_session/i)
  }
  assert.equal((await raw('GET', '/ui/assets/app.js')).status, 200, 'static assets need no auth')
})

test('session code is single use', async () => {
  const code = codeOf(web.issueLoginUrl())
  const first = await exchange(code)
  assert.equal(first.status, 200)
  assert.equal(first.headers['set-cookie'], undefined)
  const again = await exchange(code)
  assert.equal(again.status, 403)
  assert.match(JSON.parse(again.body).error, /펫에서/)
})

test('session code expires after 60 s', async () => {
  const code = codeOf(web.issueLoginUrl())
  clock += 61_000
  try { assert.equal((await exchange(code)).status, 403) } finally { clock -= 61_000 }
})

test('bad session exchange requests are rejected', async () => {
  assert.equal((await exchange('')).status, 403)
  assert.equal((await exchange('nope')).status, 403)
  assert.equal((await raw('POST', '/ui-api/session', {}, 'not json')).status, 400)
  assert.equal((await raw('GET', '/ui-api/session')).status, 404)
})

test('/ui-api requires a valid session token as Bearer', async () => {
  assert.equal((await raw('GET', '/ui-api/state')).status, 401)
  assert.equal((await raw('GET', '/ui-api/state', bearer('forged'))).status, 401)
  assert.equal((await raw('GET', '/ui-api/state', bearer('mock-token'))).status, 401, 'the daemon token is not a session')
  const token = await login()
  const r = await raw('GET', '/ui-api/state', bearer(token))
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(JSON.parse(r.body).decisions))
})

test('the query token is accepted on /ui-api/events only', async () => {
  const token = await login()
  assert.equal((await raw('GET', `/ui-api/state?t=${token}`)).status, 401)
  assert.equal((await raw('GET', `/ui-api/requests/req-7f3a9c21?t=${token}`)).status, 401)
  assert.equal((await raw('POST', `/ui-api/requests/req-7f3a9c21/cancel?t=${token}`, {}, '{}')).status, 401)
  const n = mock.calls.length
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/ui-api/events?t=${token}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      assert.equal(res.statusCode, 200)
      assert.match(String(res.headers['content-type']), /text\/event-stream/)
      assert.equal(res.headers['cache-control'], 'no-store', 'security headers win over the SSE handler')
      assert.equal(res.headers['content-security-policy'], SECURITY_HEADERS['content-security-policy'])
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        buf += c
        if (buf.includes(': connected') && !buf.includes('data:')) mock.emit({ kind: 'task', text: '테스트 이벤트 <script>' })
        if (buf.includes('테스트 이벤트')) { req.destroy(); resolve() }
      })
    })
    req.on('error', (e) => { if (!String(e).includes('socket hang up')) reject(e) })
    req.end()
  })
  const call = mock.calls[n]
  assert.equal(call.url, '/api/events', 'the token is stripped before routeApi')
  assert.equal(call.headers.authorization, 'Bearer mock-token')
})

test('/ui-api is rewritten to /api with the daemon Bearer; Origin and cookies are dropped', async () => {
  const token = await login()
  const n = mock.calls.length
  const r = await raw('GET', '/ui-api/attempts/req-7f3a9c21.runner~a2/activity?after=2', { ...bearer(token), origin: `http://127.0.0.1:${port}`, cookie: 'x=1' })
  assert.equal(r.status, 200)
  const call = mock.calls[n]
  assert.equal(call.url, '/api/attempts/req-7f3a9c21.runner~a2/activity?after=2')
  assert.equal(call.headers.authorization, 'Bearer mock-token')
  assert.equal(call.headers.origin, undefined)
  assert.equal(call.headers.cookie, undefined)
  const body = JSON.parse(r.body)
  assert.ok(Array.isArray(body.lines) && Number.isInteger(body.next))
})

test('POST works with only the session Bearer (no CSRF, no Origin needed)', async () => {
  const token = await login()
  const state = JSON.parse((await raw('GET', '/ui-api/state', bearer(token))).body)
  const d = state.decisions.find((x: { kind: string }) => x.kind === 'merge')
  const path = `/ui-api/approvals/${encodeURIComponent(d.id)}`
  const n = mock.calls.length
  const ok = await raw('POST', path, { ...bearer(token), 'content-type': 'application/json' }, JSON.stringify({ decision: '보류', subjectHash: d.subjectHash }))
  assert.equal(ok.status, 200)
  const call = mock.calls[n]
  assert.equal(call.url, `/api/approvals/${encodeURIComponent(d.id)}`)
  assert.deepEqual(JSON.parse(call.body), { decision: '보류', subjectHash: d.subjectHash })
  const stale = await raw('POST', path, { ...bearer(token), 'content-type': 'application/json' }, JSON.stringify({ decision: '보류', subjectHash: d.subjectHash }))
  assert.equal(stale.status, 409)
  assert.match(JSON.parse(stale.body).error, /[가-힣]/, '409 carries a Korean reason')
})

test('only allowlisted /ui-api routes are proxied; everything else is 404', async () => {
  const token = await login()
  const allowed: [string, string][] = [
    ['GET', 'state'], ['GET', 'requests/req-7f3a9c21'], ['GET', 'attempts/req-7f3a9c21.runner~a1/activity'], ['GET', 'attempts/req-7f3a9c21.runner~a1/files/report.md'],
    ['GET', 'requests/req-7f3a9c21/diff?task=runner'], ['GET', 'quota'],
    ['POST', 'requests'], ['POST', 'requests/r/answer'], ['POST', 'tasks/t/answer'], ['POST', 'tasks/t/decide'], ['POST', 'requests/r/reject'],
    ['POST', 'requests/r/cancel'], ['POST', 'requests/r/merge'], ['POST', 'approvals/a'],
  ]
  for (const [m, p] of allowed) {
    const n = mock.calls.length
    await raw(m, `/ui-api/${p}`, bearer(token), m === 'POST' ? '{}' : undefined)
    assert.equal(mock.calls.length, n + 1, `${m} ${p} reaches routeApi`)
  }
  const denied: [string, string][] = [
    ['POST', 'approvals'], ['POST', 'teams/blog/run'], ['GET', 'approvals/a'], ['POST', 'ui-code'], ['GET', 'ui-code'], ['POST', 'state'],
    ['GET', 'requests'], ['GET', 'requests/r/answer'], ['DELETE', 'requests/r'], ['PUT', 'approvals/a'], ['GET', 'attempts/a/files'],
    ['GET', 'attempts/a/files/x/y'], ['GET', 'requests//diff'], ['GET', ''], ['GET', 'state/'], ['GET', 'events/x'],
  ]
  for (const [m, p] of denied) {
    const n = mock.calls.length
    const r = await raw(m, `/ui-api/${p}`, bearer(token), m === 'GET' ? undefined : '{}')
    assert.equal(r.status, 404, `${m} ${p}`)
    assert.equal(mock.calls.length, n, `${m} ${p} never reaches routeApi`)
  }
})

test('Host other than 127.0.0.1:<port> is rejected everywhere', async () => {
  const token = await login()
  for (const host of [`localhost:${port}`, '127.0.0.1:1', 'evil.example', `127.0.0.1:${port}.evil.example`]) {
    assert.equal((await raw('GET', '/ui', { host })).status, 403, host)
    assert.equal((await raw('GET', '/ui/assets/app.js', { host })).status, 403, host)
    assert.equal((await raw('GET', '/ui-api/state', { host, ...bearer(token) })).status, 403, host)
    assert.equal((await raw('POST', '/ui-api/session', { host }, JSON.stringify({ code: codeOf(web.issueLoginUrl()) }))).status, 403, host)
  }
})

test('every /ui* response carries the security headers', async () => {
  const token = await login()
  const cases: [string, string, Record<string, string>, string?][] = [
    ['GET', '/ui', {}], ['GET', '/ui/', {}], ['GET', '/ui/assets/app.js', {}], ['GET', '/ui/assets/app.css', {}], ['GET', '/ui/assets/nope.js', {}], ['GET', '/ui/nope', {}],
    ['GET', '/ui-api/state', bearer(token)], ['GET', '/ui-api/state', {}], ['GET', '/ui-api/teams', bearer(token)],
    ['POST', '/ui-api/session', {}, '{"code":"x"}'], ['GET', '/ui', { host: 'evil.example' }],
    ['GET', '/ui-api/attempts/req-7f3a9c21.runner~a1/files/report.md', bearer(token)], ['GET', '/ui-api/attempts/nope/files/report.md', bearer(token)],
  ]
  for (const [m, p, h, b] of cases) {
    const r = await raw(m, p, h, b)
    assert.equal(r.headers['content-security-policy'], "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", `${m} ${p}`)
    assert.equal(r.headers['x-content-type-options'], 'nosniff', `${m} ${p}`)
    assert.equal(r.headers['referrer-policy'], 'no-referrer', `${m} ${p}`)
    assert.equal(r.headers['cache-control'], 'no-store', `${m} ${p}`)
  }
})

test('sessions expire after 12 h idle; activity keeps them alive up to 7 days', async () => {
  const start = clock
  try {
    const a = await login(), b = await login()
    clock += SESSION_IDLE_MS - 1000
    assert.equal((await raw('GET', '/ui-api/state', bearer(b))).status, 200)
    clock += 2000
    assert.equal((await raw('GET', '/ui-api/state', bearer(a))).status, 401, 'a idle > 12h')
    assert.equal((await raw('GET', '/ui-api/state', bearer(b))).status, 200, 'b was used')
    while (clock - start < SESSION_MAX_MS - 60 * 60_000) {
      clock += 10 * 60 * 60_000
      assert.equal((await raw('GET', '/ui-api/state', bearer(b))).status, 200, 'still under the 7 day cap')
    }
    clock = start + SESSION_MAX_MS + 1000
    assert.equal((await raw('GET', '/ui-api/state', bearer(b))).status, 401, 'b over the 7 day cap despite use')
  } finally { clock = start }
})

test('sessions live in memory: a new web UI instance (daemon restart) knows none of them', async () => {
  const token = await login()
  const fresh = createWebUi({ port, token: 'mock-token', routeApi: mock.routeApi, now: () => clock })
  const old = web
  web = fresh
  try { assert.equal((await raw('GET', '/ui-api/state', bearer(token))).status, 401) } finally { web = old }
})
