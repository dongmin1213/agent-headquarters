// Process lifecycle (execution.md §7, §22): signals only to a confirmed process group, no start after a cancel,
// exits observed from spawn time, background job retries back off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Runner } from '../../src/exec/runner.ts'
import { atomicJson } from '../../src/exec/fsx.ts'
import { defaultProbe, killGroup, launch, pidAlive, psLstart, terminateGroup, type Probe } from '../../src/exec/worker.ts'
import { harness, ROOT, task, tmp, tsk, type Harness } from './helpers.ts'
import { nestedSandbox, NESTED_PS_SKIP, useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

const UNKNOWN_NOTE = '작업자 프로세스를 확인할 수 없어 멈췄어요 · 직접 확인한 뒤 다시 시도해 주세요'
const FAILING_NOTE = '내부 작업이 계속 실패해요 · hq logs를 확인해 주세요'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A detached /bin/sleep: its own process group, like a worker — the "new owner" of a reused pid. */
function owner(args = ['30'], cmd = '/bin/sleep') {
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  c.unref()
  return c
}
const reap = (pid: number | undefined) => { if (pid) try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }

/** The daemon after a restart, on the same DB, with an optional identity probe. */
function restart(h: Harness, probe?: Partial<Probe>, hqRoot = ROOT): Runner {
  h.runner.stop()
  const r = new Runner({ store: h.store, bus: h.bus, cfg: h.cfg, projects: h.projects, hqRoot, hqPort: 17999, notify: () => {}, now: () => h.clock.t, tokenDir: join(h.dir, 'tok'), probe })
  ;(h as { runner: Runner }).runner = r
  return r
}

/** A task with an attempt row that claims to be running `pid` (recorded start time `lstart`). */
async function runningAttempt(h: Harness, pid: number | null, lstart: string | null): Promise<{ tid: string; aid: string; dir: string }> {
  const id = h.plan([task('A')])
  h.runner.stop()
  await h.approve(id)
  const tid = `${id}.A`, aid = `${tid}~a1`
  const t = tsk(h, tid)
  const dir = h.runner.runDir(t.request_id, t.key, aid)
  h.store.tx(() => {
    h.store.insertAttempt({ id: aid, task_id: tid, kind: 'work', n: 1, model: 'sonnet', status: pid ? 'running' : 'starting', attempt_token: 'tok', dir, session_id: randomUUID(), generation: t.generation })
    if (pid) h.store.updateAttempt(aid, { pid, lstart, started_at: new Date().toISOString() })
    h.store.updateTask(tid, { status: 'running', attempts: 1 })
  })
  mkdirSync(join(dir, 'hq'), { recursive: true }); mkdirSync(join(dir, 'out'), { recursive: true })
  return { tid, aid, dir }
}

// ----- worker level -----

test('killGroup: a failed group kill never falls back to the bare pid', async () => {
  const c = spawn('/bin/sleep', ['30'], { stdio: 'ignore' }) // same process group as the test: no group named by its pid
  try {
    assert.equal(killGroup(c.pid!, 'SIGKILL'), false)
    await sleep(100)
    assert.equal(pidAlive(c.pid!), true, 'the pid itself was not signalled')
  } finally { c.kill('SIGKILL') }
})

test('terminateGroup: the delayed SIGKILL re-checks identity — swapped before the delay → not killed; unchanged → killed', { skip: nestedSandbox && NESTED_PS_SKIP }, async () => {
  const stubborn = () => owner(['-c', 'trap "" TERM; sleep 30'], '/bin/sh')
  const a = stubborn(), b = stubborn()
  try {
    await sleep(100)
    const la = (await psLstart(a.pid!))!, lb = (await psLstart(b.pid!))!
    let swapped = false
    const swapping: Probe = { ...defaultProbe, lstart: async (pid) => (swapped ? 'Mon Jan  1 00:00:00 2001' : psLstart(pid)) }
    assert.equal(await terminateGroup(a.pid!, la, 300, swapping), 'same')
    assert.equal(await terminateGroup(b.pid!, lb, 300), 'same')
    swapped = true
    await sleep(900)
    assert.equal(pidAlive(a.pid!), true, 'identity changed before the delayed SIGKILL → no kill')
    assert.equal(pidAlive(b.pid!), false, 'still ours → SIGKILL after the grace period')
  } finally { reap(a.pid); reap(b.pid) }
})

test('launch: a child that exits before ps answers is observed as exited (exit watched from spawn)', async () => {
  const dir = tmp('hq-fast-')
  const wt = join(dir, 'wt'), hqDir = join(dir, 'run', 'hq')
  mkdirSync(wt, { recursive: true }); mkdirSync(join(dir, 'tok'), { recursive: true })
  const slowPs = async (pid: number) => { await sleep(400); return psLstart(pid) }
  const l = await launch({ claudeBin: '/usr/bin/true', argv: [], cwd: wt, hqDir, outDir: null, prompt: 'x', sessionId: 's', spec: {},
    sandbox: { worktree: wt, out: null, hqHome: join(dir, 'home'), tokenDir: join(dir, 'tok'), hqPort: 17999, extraWritable: [], projects: [] } }, slowPs)
  assert.equal(l.exit.exited, true, 'exit seen although it happened before launch() returned')
  assert.equal(l.exit.code, 0)
  let called = false
  l.exit.onExit(() => { called = true })
  assert.equal(called, true, 'a late listener runs at once')
})

// ----- runner level -----

test('reused pid (recorded start time differs) → never signalled by recover() + pollLive(); the attempt is finished from its evidence', { skip: nestedSandbox && NESTED_PS_SKIP }, async () => {
  const h = harness()
  const o = owner()
  try {
    await sleep(100)
    const { tid, aid } = await runningAttempt(h, o.pid!, 'Mon Jan  1 00:00:00 2001')
    const r = restart(h)
    await r.recover()
    for (let i = 0; i < 3; i++) { await r.tick(); await r.drain() }
    assert.equal(pidAlive(o.pid!), true, 'the new owner of the pid survives')
    assert.ok(!['starting', 'running'].includes(h.store.attempt(aid)!.status), 'attempt finished')
    assert.ok(!r.live.has(aid))
    assert.notEqual(tsk(h, tid).status, 'running')
  } finally { reap(o.pid); await h.close() }
})

test('reused pid found through process.json (no pid in the DB) → not signalled, finished from evidence', { skip: nestedSandbox && NESTED_PS_SKIP }, async () => {
  const h = harness()
  const o = owner()
  try {
    await sleep(100)
    const { aid, dir } = await runningAttempt(h, null, null)
    atomicJson(join(dir, 'hq', 'process.json'), { pid: o.pid, lstart: 'Mon Jan  1 00:00:00 2001', startedAt: new Date().toISOString(), sessionId: 's' })
    const r = restart(h)
    await r.recover()
    for (let i = 0; i < 3; i++) { await r.tick(); await r.drain() }
    assert.equal(pidAlive(o.pid!), true)
    assert.ok(!['starting', 'running'].includes(h.store.attempt(aid)!.status))
  } finally { reap(o.pid); await h.close() }
})

test('unknown identity (ps failing) → not signalled even when cancelled; attempt and task stop with the note', async () => {
  const h = harness()
  const o = owner()
  try {
    await sleep(100)
    const { tid, aid } = await runningAttempt(h, o.pid!, 'Wed Sep 30 00:00:00 2026')
    h.store.updateAttempt(aid, { outcome: 'runaway' }) // would be killed if it were confirmed ours
    const r = restart(h, { lstart: () => { throw new Error('spawn EPERM') }, members: async () => null })
    await r.recover()
    for (let i = 0; i < 3; i++) { await r.tick(); await r.drain() }
    await sleep(100)
    assert.equal(pidAlive(o.pid!), true, 'never signalled')
    const att = h.store.attempt(aid)!
    assert.equal(att.status, 'unverifiable')
    assert.equal(att.reason, UNKNOWN_NOTE)
    assert.equal(tsk(h, tid).status, 'blocked')
    assert.equal(tsk(h, tid).note, UNKNOWN_NOTE)
  } finally { reap(o.pid); await h.close() }
})

test('cancel during setup (collect task, setup sleep 0.5) → no spawn, no process.json, attempt cancelled', async () => {
  const h = harness({ setup: 'sleep 0.5' })
  try {
    const id = h.plan([task('A', { role: 'collect', owns: [], acceptance: [{ id: 'A1', text: '보고서', check: 'manual', kind: 'new' }], brief: '[[FAKE:sleep=100]]' })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => { const a = h.store.attempts(tid)[0]; return !!a && existsSync(join(a.dir, 'hq', 'setup.sb')) }, 'setup started', 20_000)
    const att = h.store.attempts(tid)[0]
    assert.equal(att.status, 'starting')
    assert.equal(h.runner.cancelRequest(id), null)
    await h.runner.drain()
    const after = h.store.attempt(att.id)!
    assert.equal(after.outcome, 'cancelled')
    assert.ok(!['starting', 'running'].includes(after.status), `ended (${after.status})`)
    assert.equal(after.pid, null, 'never spawned')
    assert.equal(existsSync(join(att.dir, 'hq', 'process.json')), false, 'no process.json')
    assert.equal(h.runner.live.has(att.id), false)
  } finally { await h.close() }
})

test('generation change during the baseline → no spawn, attempt superseded', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'A1', text: '느린 검사', check: 'sleep 1', kind: 'regression' }] })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => { const a = h.store.attempts(tid)[0]; return !!a && existsSync(join(a.dir, 'hq', 'baseline.sb')) }, 'baseline started', 20_000)
    const att = h.store.attempts(tid)[0]
    assert.equal(att.status, 'starting')
    h.store.updateTask(tid, { generation: tsk(h, tid).generation + 1 })
    await h.runner.drain()
    const after = h.store.attempt(att.id)!
    assert.equal(after.outcome, 'superseded')
    assert.ok(!['starting', 'running'].includes(after.status))
    assert.equal(after.pid, null)
    assert.equal(existsSync(join(att.dir, 'hq', 'process.json')), false)
  } finally { await h.close() }
})

test('a background job that throws backs off (1s, 2s, 4s, 8s on the injected clock) and blocks its task after 5 failures', async () => {
  const h = harness()
  const errors: unknown[] = []
  const origErr = console.error
  console.error = (...a: unknown[]) => { errors.push(a) }
  try {
    const id = h.plan([task('A')])
    h.runner.stop()
    await h.approve(id)
    const tid = `${id}.A`
    h.store.updateTask(tid, { status: 'revising' })
    // No skills/ceo.md under this root: every revise turn throws.
    const r = restart(h, undefined, tmp('hq-noroot-'))
    const runs = () => tsk(h, tid).revise_turns
    const step = async () => { await r.tick(); await r.drain() }
    await step()
    assert.equal(runs(), 1)
    for (let i = 0; i < 5; i++) await step()
    assert.equal(runs(), 1, 'no immediate retry (no tight loop)')
    for (const [wait, n] of [[1_000, 2], [2_000, 3], [4_000, 4]] as const) {
      h.clock.t += wait - 1
      await step()
      assert.equal(runs(), n - 1, `not before ${wait}ms`)
      h.clock.t += 1
      await step()
      assert.equal(runs(), n, `retried after ${wait}ms`)
    }
    assert.equal(tsk(h, tid).status, 'revising')
    h.clock.t += 8_000
    await step()
    assert.equal(runs(), 5)
    assert.equal(tsk(h, tid).status, 'blocked', 'the 5th failure in a row stops the task')
    assert.equal(tsk(h, tid).note, FAILING_NOTE)
    assert.ok(errors.some((e) => String((e as unknown[])[0]).includes(`revise:${tid}`)), 'each failure is logged')
  } finally { console.error = origErr; await h.close() }
})
