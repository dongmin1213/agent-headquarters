// §G 13 (restart recovery) and §G 16 (invariant check).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Runner } from '../../src/exec/runner.ts'
import { FAKE, harness, ROOT, req, task, tsk, type Harness } from './helpers.ts'

/** A second runner on the same DB = the daemon after a restart. */
function restart(h: Harness): Runner {
  h.runner.stop()
  const r = new Runner({ store: h.store, bus: h.bus, cfg: h.cfg, projects: h.projects, hqRoot: ROOT, hqPort: 17999, notify: () => {}, now: () => h.clock.t, tokenDir: join(h.dir, 'tok') })
  ;(h as { runner: Runner }).runner = r
  return r
}

function startingAttempt(h: Harness, taskId: string, sessionId: string): string {
  const t = tsk(h, taskId)
  const id = `${taskId}~a1`
  h.store.tx(() => {
    h.store.insertAttempt({ id, task_id: taskId, kind: 'work', n: 1, model: 'sonnet', status: 'starting', attempt_token: 'tok', dir: h.runner.runDir(t.request_id, t.key, id), session_id: sessionId })
    h.store.updateTask(taskId, { status: 'running', attempts: 1 })
  })
  return id
}

test('13. starting row without pid + a live process with that session id → adopted, no duplicate start', async () => {
  const h = harness()
  const sid = randomUUID()
  const orphan = spawn(FAKE, ['-p', '--session-id', sid], { stdio: ['pipe', 'ignore', 'ignore'], detached: true })
  orphan.stdin!.end('[[FAKE:sleep=20000]]')
  try {
    const id = h.plan([task('A')])
    await h.approve(id)
    const aid = startingAttempt(h, `${id}.A`, sid)
    await new Promise((r) => setTimeout(r, 300))
    const r = restart(h)
    await r.recover()
    const att = h.store.attempt(aid)!
    assert.equal(att.status, 'running')
    assert.equal(att.pid, orphan.pid)
    assert.ok(r.live.has(aid))
    await r.tick()
    assert.equal(h.store.attempts(`${id}.A`).length, 1, 'no second attempt')
  } finally { try { process.kill(-orphan.pid!, 'SIGKILL') } catch { /* gone */ } await h.close() }
})

test('13. starting row without pid and no orphan → start_failed, task back to pending', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A')])
    await h.approve(id)
    const aid = startingAttempt(h, `${id}.A`, randomUUID())
    await restart(h).recover()
    assert.equal(h.store.attempt(aid)!.status, 'start_failed')
    assert.equal(tsk(h, `${id}.A`).status, 'pending')
  } finally { await h.close() }
})

test('13. dead pid with a valid done.json → judged succeeded after restart', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:write=a/out.txt]] [[FAKE:sleep=700]]' })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => h.store.attempts(tid)[0]?.status === 'running', 'running')
    const att = h.store.attempts(tid)[0]
    h.runner.stop()
    await h.runner.drain()
    await new Promise((r) => { const iv = setInterval(() => { try { process.kill(att.pid!, 0) } catch { clearInterval(iv); r(null) } }, 50) })
    assert.ok(existsSync(join(att.dir, 'out', 'done.json')))
    const r = restart(h)
    await r.recover()
    await h.waitFor(() => h.store.attempt(att.id)!.status !== 'running', 'judged')
    assert.equal(h.store.attempt(att.id)!.status, 'succeeded')
    assert.ok(['verifying', 'reviewing', 'passed'].includes(tsk(h, tid).status))
  } finally { await h.close() }
})

test('13. thinking request → queued; verifying with checks running → checks rerun', async () => {
  const h = harness()
  try {
    h.store.addRequest('req-think001', 'p', '생각 중')
    h.store.updateRequest('req-think001', { status: 'thinking' })
    const id = h.plan([task('A')])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => tsk(h, tid).status === 'passed', 'passed')
    const work = h.store.attempts(tid).find((a) => a.kind === 'work')!
    h.store.updateTask(tid, { status: 'verifying', checks_state: 'running' })
    const { rmSync } = await import('node:fs')
    rmSync(join(work.dir, 'hq', 'checks.json'))
    const r = restart(h)
    await r.recover()
    assert.equal(req(h, 'req-think001').status, 'queued')
    assert.equal(tsk(h, tid).checks_state, null)
    await h.waitFor(() => existsSync(join(work.dir, 'hq', 'checks.json')) && tsk(h, tid).status !== 'verifying', 'checks rerun')
    assert.equal(tsk(h, tid).checks_state, 'passed')
  } finally { await h.close() }
})

test('16. invariants: running task without a process and a blocked request without a card are reported and surfaced as blocked', async () => {
  const h = harness()
  try {
    const r1 = h.plan([task('A')])
    await h.approve(r1)
    h.store.updateTask(`${r1}.A`, { status: 'running' })
    const r2 = h.plan([task('B')])
    await h.approve(r2)
    h.store.updateRequest(r2, { status: 'blocked' })
    const v = await h.runner.reconcile()
    assert.ok(v.some((x) => x.requestId === r1 && x.taskId === `${r1}.A`), 'running without process')
    assert.ok(v.some((x) => x.requestId === r2 && x.taskId === null), 'blocked without card')
    assert.equal(req(h, r1).status, 'blocked')
    assert.equal(tsk(h, `${r1}.A`).status, 'blocked')
    assert.equal(req(h, r2).status, 'blocked')
    assert.equal(tsk(h, `${r2}.B`).status, 'blocked', 'now there is a decision item')
    assert.equal((await h.runner.reconcile()).length, 0, 'no violation left')
    mkdirSync(join(h.dir, 'x'), { recursive: true })
  } finally { await h.close() }
})
