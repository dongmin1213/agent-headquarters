// F11: GET /api/requests/:id/diff reads the task's change from hq's mirror (worker commits are not in the user checkout).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { Scheduler } from '../../src/scheduler.ts'
import { startServer } from '../../src/server.ts'
import { harness, req, task, tsk } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

const TOKEN = 'diff-token-123'

test('F11. diff route: files from the mirror; truly empty; unreadable → 409 with a Korean reason (never an empty 200)', async () => {
  const h = harness()
  const port = 30000 + Math.floor(Math.random() * 20000)
  const scheduler = new Scheduler([], h.store, h.bus, `http://127.0.0.1:${port}`, { hqHome: h.cfg.home, tokenDir: h.dir + '/tokens' }, { holdUntil: () => h.runner.holdUntil(), teamLimited: () => {} })
  const server = startServer({ port, store: h.store, bus: h.bus, scheduler, token: TOKEN, engine: h.engine, runner: h.runner, projects: h.projects })
  await new Promise((r) => server.once('listening', r))
  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    return { status: r.status, body: await r.json() as any }
  }
  try {
    const id = h.plan([task('A')])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const t = tsk(h, `${id}.A`)
    assert.ok(t.base_sha && t.head_sha && t.base_sha !== t.head_sha)
    // The worker's commit exists only in hq's mirror, not in the user's checkout.
    assert.notEqual(spawnSync('git', ['cat-file', '-e', `${t.head_sha}^{commit}`], { cwd: h.repo }).status, 0, 'head not in the user checkout')

    // 1. ok with files
    const ok = await get(`/api/requests/${id}/diff?task=A`)
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.files.map((f: { path: string }) => f.path), ['a/out.txt'])
    assert.ok(ok.body.files[0].added > 0)
    assert.match(ok.body.diff, /^diff --git a\/a\/out\.txt b\/a\/out\.txt/m)
    assert.equal(ok.body.truncated, false)

    // 2. ok but truly empty (same tree)
    h.store.updateTask(t.id, { head_sha: t.base_sha })
    const empty = await get(`/api/requests/${id}/diff?task=A`)
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { files: [], diff: '', truncated: false })

    // 3. unreadable: a commit the mirror does not have, then no mirror at all
    h.store.updateTask(t.id, { head_sha: 'f'.repeat(40) })
    const bad = await get(`/api/requests/${id}/diff?task=A`)
    assert.equal(bad.status, 409)
    assert.equal(bad.body.error, '변경 내용을 읽지 못했어요: 커밋이 hq 미러에 없어요')
    h.store.updateTask(t.id, { head_sha: t.head_sha })
    rmSync(h.runner.mirror('p'), { recursive: true, force: true })
    const gone = await get(`/api/requests/${id}/diff?task=A`)
    assert.equal(gone.status, 409)
    assert.equal(gone.body.error, '변경 내용을 읽지 못했어요: hq 미러가 없어요')
    assert.equal((await get(`/api/requests/${id}/diff?task=Z`)).status, 404)
  } finally {
    server.close()
    await h.close()
  }
})

test('U1. an unexpected server error answers one Korean sentence; the raw error only goes to the log', async () => {
  const { createApi } = await import('../../src/server.ts')
  const boom = new Proxy({}, { get: () => () => { throw new Error('fatal: something raw at /x/y.ts:1:2') } })
  const route = createApi({ port: 1, store: boom, bus: boom, scheduler: boom, token: 't', engine: boom, runner: boom, projects: [] } as never)
  let status = 0, body = ''
  const res = { headersSent: false, writeHead(s: number) { status = s }, end(b?: string) { body = b ?? '' } }
  const logged: unknown[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { logged.push(a) }
  try { await route({ url: '/api/requests/x', method: 'GET', headers: {} } as never, res as never) } finally { console.error = orig }
  assert.equal(status, 500)
  assert.deepEqual(JSON.parse(body), { error: '서버에서 문제가 생겼어요 · hq logs로 원문을 확인할 수 있어요' })
  assert.match(String(logged.flat().join(' ')), /fatal: something raw/)
})
