// Web UI auth + proxy tests (execution.md §15): one-time code, session cookie, CSRF + Origin, Host check, /ui-api → /api rewrite.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWebUi, SESSION_IDLE_MS, type WebUi } from '../../src/web/index.ts'
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
    if (body) req.write(body)
    req.end()
  })
}
const origin = () => `http://127.0.0.1:${port}`

async function login(): Promise<{ cookie: string; csrf: string }> {
  const url = new URL(web.issueLoginUrl())
  const r = await raw('GET', url.pathname + url.search)
  assert.equal(r.status, 200)
  const cookie = String(r.headers['set-cookie']).split(';')[0]
  const page = await raw('GET', '/ui', { cookie })
  const csrf = /name="hq-csrf" content="([^"]+)"/.exec(page.body)?.[1]
  assert.ok(csrf, 'csrf meta present')
  return { cookie, csrf }
}

test('issueLoginUrl returns a 127.0.0.1 /ui/open URL with a code', () => {
  const u = new URL(web.issueLoginUrl())
  assert.equal(u.origin, origin())
  assert.equal(u.pathname, '/ui/open')
  assert.ok((u.searchParams.get('code') ?? '').length >= 24)
})

test('unauthenticated /ui shows the Korean "open from the pet" page', async () => {
  const r = await raw('GET', '/ui')
  assert.equal(r.status, 401)
  assert.match(r.body, /펫에서 &#39;자세히 보기&#39;로 열어 주세요/)
  assert.equal(r.headers['set-cookie'], undefined)
})

test('login code sets an HttpOnly SameSite=Strict session cookie and is single-use', async () => {
  const url = new URL(web.issueLoginUrl())
  const r = await raw('GET', url.pathname + url.search)
  assert.equal(r.status, 200)
  const sc = String(r.headers['set-cookie'])
  assert.match(sc, /^hq_session=[\w-]{40,};/)
  assert.match(sc, /HttpOnly/)
  assert.match(sc, /SameSite=Strict/)
  assert.match(sc, /Path=\//)
  assert.match(r.body, /http-equiv="refresh" content="0;url=\/ui"/)
  const again = await raw('GET', url.pathname + url.search)
  assert.equal(again.status, 403)
  assert.equal(again.headers['set-cookie'], undefined)
})

test('login code expires after 60 s', async () => {
  const url = new URL(web.issueLoginUrl())
  clock += 61_000
  try {
    const r = await raw('GET', url.pathname + url.search)
    assert.equal(r.status, 403)
    assert.equal(r.headers['set-cookie'], undefined)
  } finally { clock -= 61_000 }
})

test('missing or unknown code is rejected', async () => {
  assert.equal((await raw('GET', '/ui/open')).status, 403)
  assert.equal((await raw('GET', '/ui/open?code=nope')).status, 403)
})

test('forged cookie is not a session', async () => {
  assert.equal((await raw('GET', '/ui', { cookie: 'hq_session=forged' })).status, 401)
  assert.equal((await raw('GET', '/ui-api/state', { cookie: 'hq_session=forged' })).status, 401)
})

test('Host other than 127.0.0.1:<port> is rejected everywhere', async () => {
  const { cookie } = await login()
  for (const host of ['localhost:' + port, '127.0.0.1:1', 'evil.example', `127.0.0.1:${port}.evil.example`]) {
    assert.equal((await raw('GET', '/ui', { host, cookie })).status, 403, host)
    assert.equal((await raw('GET', '/ui-api/state', { host, cookie })).status, 403, host)
  }
  const url = new URL(web.issueLoginUrl())
  assert.equal((await raw('GET', url.pathname + url.search, { host: 'localhost:' + port })).status, 403)
})

test('security headers are present on pages, assets and API responses', async () => {
  const { cookie } = await login()
  for (const path of ['/ui', '/ui/assets/app.js', '/ui/assets/app.css', '/ui-api/state']) {
    const r = await raw('GET', path, { cookie })
    assert.equal(r.status, 200, path)
    assert.equal(r.headers['content-security-policy']?.toString().startsWith("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:"), true, path)
    assert.equal(r.headers['x-frame-options'], 'DENY', path)
    assert.equal(r.headers['referrer-policy'], 'no-referrer', path)
  }
  const unauth = await raw('GET', '/ui')
  assert.equal(unauth.headers['x-frame-options'], 'DENY')
})

test('scripts need a session; the stylesheet is public for the message pages', async () => {
  assert.equal((await raw('GET', '/ui/assets/app.js')).status, 401)
  assert.equal((await raw('GET', '/ui/assets/lib.js')).status, 401)
  const css = await raw('GET', '/ui/assets/app.css')
  assert.equal(css.status, 200)
  assert.match(String(css.headers['content-type']), /text\/css/)
  assert.equal((await raw('GET', '/ui/assets/../index.ts')).status, 404)
  const { cookie } = await login()
  const js = await raw('GET', '/ui/assets/app.js', { cookie })
  assert.match(String(js.headers['content-type']), /javascript/)
})

test('/ui-api GET requires the cookie and is rewritten to /api with the Bearer token', async () => {
  assert.equal((await raw('GET', '/ui-api/state')).status, 401)
  const { cookie } = await login()
  const n = mock.calls.length
  const r = await raw('GET', '/ui-api/attempts/req-1%2Ftask%23a1/activity?after=2', { cookie, origin: origin() })
  assert.equal(r.status, 200)
  const call = mock.calls[n]
  assert.equal(call.url, '/api/attempts/req-1%2Ftask%23a1/activity?after=2')
  assert.equal(call.headers.authorization, 'Bearer mock-token')
  assert.equal(call.headers.origin, undefined)
  assert.equal(call.headers.cookie, undefined)
  const s = await raw('GET', '/ui-api/state', { cookie })
  assert.equal(JSON.parse(s.body).headline.needsYou > 0, true)
})

test('non-GET /ui-api needs both X-CSRF-Token and the exact Origin', async () => {
  const { cookie, csrf } = await login()
  const state = JSON.parse((await raw('GET', '/ui-api/state', { cookie })).body)
  const a = state.approvals.find((x: { id: string }) => x.id.startsWith('merge:'))
  const body = JSON.stringify({ decision: '보류', subjectHash: a.subjectHash })
  const path = `/ui-api/approvals/${encodeURIComponent(a.id)}`
  const json = { 'content-type': 'application/json' }
  const n = mock.calls.length
  assert.equal((await raw('POST', path, { ...json, cookie, origin: origin() }, body)).status, 403, 'no csrf')
  assert.equal((await raw('POST', path, { ...json, cookie, origin: origin(), 'x-csrf-token': 'wrong' }, body)).status, 403, 'bad csrf')
  assert.equal((await raw('POST', path, { ...json, cookie, 'x-csrf-token': csrf }, body)).status, 403, 'no origin')
  assert.equal((await raw('POST', path, { ...json, cookie, origin: 'http://evil.example', 'x-csrf-token': csrf }, body)).status, 403, 'bad origin')
  assert.equal((await raw('POST', path, { ...json, cookie, origin: `http://localhost:${port}`, 'x-csrf-token': csrf }, body)).status, 403, 'localhost origin')
  assert.equal((await raw('POST', path, { ...json, origin: origin(), 'x-csrf-token': csrf }, body)).status, 401, 'no cookie')
  assert.equal(mock.calls.length, n, 'rejected requests never reach routeApi')
  const ok = await raw('POST', path, { ...json, cookie, origin: origin(), 'x-csrf-token': csrf }, body)
  assert.equal(ok.status, 200)
  const call = mock.calls[n]
  assert.equal(call.method, 'POST')
  assert.equal(call.url, `/api/approvals/${encodeURIComponent(a.id)}`)
  assert.equal(call.headers.authorization, 'Bearer mock-token')
  assert.equal(call.headers.origin, undefined)
  assert.equal(call.headers['x-csrf-token'], undefined)
  assert.deepEqual(JSON.parse(call.body), { decision: '보류', subjectHash: a.subjectHash })
})

test('CSRF token of one session does not work for another', async () => {
  const s1 = await login(), s2 = await login()
  assert.notEqual(s1.csrf, s2.csrf)
  const r = await raw('POST', '/ui-api/requests/req-x/cancel', { cookie: s1.cookie, origin: origin(), 'x-csrf-token': s2.csrf }, '{}')
  assert.equal(r.status, 403)
})

test('sessions expire after 12 h idle, and activity keeps them alive', async () => {
  const a = await login(), b = await login()
  clock += SESSION_IDLE_MS - 1000
  try {
    assert.equal((await raw('GET', '/ui-api/state', { cookie: b.cookie })).status, 200) // touch b
    clock += 2000
    assert.equal((await raw('GET', '/ui-api/state', { cookie: a.cookie })).status, 401, 'a idle > 12h')
    assert.equal((await raw('GET', '/ui-api/state', { cookie: b.cookie })).status, 200, 'b was touched')
  } finally { clock -= SESSION_IDLE_MS + 1000 }
})

test('SSE /ui-api/events streams through', async () => {
  const { cookie } = await login()
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/ui-api/events', headers: { host: `127.0.0.1:${port}`, cookie } }, (res) => {
      assert.equal(res.statusCode, 200)
      assert.match(String(res.headers['content-type']), /text\/event-stream/)
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        buf += c
        if (buf.includes(': connected') && !buf.includes('data:')) mock.emit({ kind: 'task', text: '테스트 이벤트' })
        if (buf.includes('테스트 이벤트')) { req.destroy(); resolve() }
      })
    })
    req.on('error', (e) => { if (!String(e).includes('socket hang up')) reject(e) })
    req.end()
  })
})

test('unknown /ui paths are 404', async () => {
  assert.equal((await raw('GET', '/ui/nope')).status, 404)
  assert.equal((await raw('POST', '/ui')).status, 405)
})
