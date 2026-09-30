import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openUi, status } from '../../src/cli/daemon.ts'
import { fakeDaemon, freePort, testCtx, writeToken } from './helpers.ts'

const TOKEN = 'status-token'
const oldSnap = { updatedAt: 'x', lastEventId: 1, teams: [], approvals: [{ id: 'a' }, { id: 'b' }], requests: [], projects: [], limit: { blockedUntil: null } }
const newSnap = {
  ...oldSnap, approvals: [],
  workers: [{ attemptId: 'a1', taskId: 't', requestId: 'r', title: '로그인 화면', project: 'p', role: 'dev', model: 'sonnet', kind: 'work', state: 'running', bubble: 'Edit src/a.ts', startedAt: 'x' }],
  headline: { text: '회장님 결정 1건: 계획 승인', needsYou: 1 },
  quota: { fiveHour: 0.42, sevenDay: 0.1, fiveHourResetsAt: null, sevenDayResetsAt: null, mode: 'normal', observedAt: null },
}

test('status against a current daemon', async (t) => {
  const d = await fakeDaemon(TOKEN, newSnap); t.after(() => d.server.close())
  const ctx = testCtx({ port: d.port }); writeToken(ctx, TOKEN)
  assert.equal(await status(ctx, { json: false }), 0, ctx.text())
  const out = ctx.text()
  assert.match(out, /데몬: 실행 중/)
  assert.match(out, /상황: 회장님 결정 1건: 계획 승인/)
  assert.match(out, /결정 대기: 1건/)
  assert.match(out, /\[sonnet\] 로그인 화면 · running · Edit src\/a\.ts/)
  assert.match(out, /5시간 42% · 7일 10%/)
})

test('status tolerates an older snapshot without workers/headline/quota', async (t) => {
  const d = await fakeDaemon(TOKEN, oldSnap); t.after(() => d.server.close())
  const ctx = testCtx({ port: d.port }); writeToken(ctx, TOKEN)
  assert.equal(await status(ctx, { json: false }), 0, ctx.text())
  assert.match(ctx.text(), /이전 버전 데몬/)
  assert.match(ctx.text(), /결정 대기: 2건/)
  assert.match(ctx.text(), /작업자: 없음/)
  assert.match(ctx.text(), /사용 한도: 정보 없음/)
  const j = testCtx({ port: d.port }); writeToken(j, TOKEN)
  assert.equal(await status(j, { json: true }), 0)
  const v = JSON.parse(j.lines.join('\n'))
  assert.equal(v.olderDaemon, true); assert.equal(v.quota, null); assert.deepEqual(v.workers, [])
})

test('status when down says how to start, exit 1', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await status(ctx, { json: false }), 1)
  assert.match(ctx.text(), /꺼져 있음/)
  assert.match(ctx.text(), /hq start/)
})

test('status with a wrong token reports 401', async (t) => {
  const d = await fakeDaemon(TOKEN, newSnap); t.after(() => d.server.close())
  const ctx = testCtx({ port: d.port }); writeToken(ctx, 'wrong')
  assert.equal(await status(ctx, { json: false }), 1)
  assert.match(ctx.text(), /토큰 불일치/)
})

test('open posts /api/ui-code and opens the returned local url (dry-run)', async (t) => {
  let port = 0
  const d = await fakeDaemon(TOKEN, newSnap, (p) => (p === '/api/ui-code' ? { status: 200, body: { url: `http://127.0.0.1:${port}/ui/open?code=abc` } } : null))
  port = d.port; t.after(() => d.server.close())
  const ctx = testCtx({ port }); writeToken(ctx, TOKEN)
  assert.equal(await openUi(ctx), 0, ctx.text())
  assert.ok(ctx.lines.includes(`[dry-run] open 'http://127.0.0.1:${port}/ui/open?code=abc'`), ctx.text())
})

test('open refuses a non-local url', async (t) => {
  const d = await fakeDaemon(TOKEN, newSnap, (p) => (p === '/api/ui-code' ? { status: 200, body: { url: 'https://evil.example/' } } : null))
  t.after(() => d.server.close())
  const ctx = testCtx({ port: d.port }); writeToken(ctx, TOKEN)
  assert.equal(await openUi(ctx), 1)
  assert.doesNotMatch(ctx.text(), /\[dry-run\] open/)
})
