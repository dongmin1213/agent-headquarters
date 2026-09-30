// Scheduler must survive team commands that cannot be spawned (live crash: ENOENT with no 'error' listener killed the daemon).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Bus } from '../../src/bus.ts'
import { Scheduler } from '../../src/scheduler.ts'
import { Store } from '../../src/store.ts'
import type { TeamConfig } from '../../src/types.ts'
import { tmp } from './helpers.ts'

function setup(team: Partial<TeamConfig>) {
  const dir = tmp('hq-sched-')
  const store = new Store(join(dir, 'hq.db'))
  const bus = new Bus(store)
  const t: TeamConfig = { id: 'revenue', name: '수익', pack: 'digimon', command: ['/bin/sh', '-c', 'exit 0'], cwd: dir, everyMinutes: 60, enabled: true, ...team }
  const sched = new Scheduler([t], store, bus, 'http://127.0.0.1:1', 'tok', { holdUntil: () => null, teamLimited: () => {} })
  return { dir, store, sched }
}

async function ended(store: Store, n: number): Promise<void> {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    const r = store.lastRun('revenue')
    if (r && r.id >= n && r.endedAt) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('run did not end')
}

test('missing command: run ends with -1 and error bubble, daemon survives, rerun works', async () => {
  const { store, sched } = setup({ command: ['/nonexistent/bin/x'] })
  assert.equal(sched.runNow('revenue'), true)
  await ended(store, 1)
  const r = store.lastRun('revenue')!
  assert.equal(r.exitCode, -1)
  assert.match(r.summary ?? '', /ENOENT/)
  const v = sched.views()[0]
  assert.equal(v.state, 'error')
  assert.match(v.bubble, /실행할 수 없어요/)
  assert.match(v.bubble, /ENOENT/)
  assert.ok(v.bubble.length <= 140)
  assert.equal(sched.runNow('revenue'), true, 'running flag reset')
  await ended(store, 2)
  assert.equal(store.lastRun('revenue')!.exitCode, -1)
  // give a stray late 'close' a chance to double-end the run
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(store.lastRun('revenue')!.id, 2)
  store.close()
})

test('invalid cwd: same handling, no crash', async () => {
  const { dir, store, sched } = setup({ cwd: join(tmp('hq-sched-'), 'gone', 'nowhere') })
  void dir
  assert.equal(sched.runNow('revenue'), true)
  await ended(store, 1)
  assert.equal(store.lastRun('revenue')!.exitCode, -1)
  const v = sched.views()[0]
  assert.equal(v.state, 'error')
  assert.match(v.bubble, /실행할 수 없어요/)
  assert.equal(sched.runNow('revenue'), true)
  await ended(store, 2)
  store.close()
})

test('disabled team: runNow refuses and nothing runs', async () => {
  const { store, sched } = setup({ enabled: false })
  assert.equal(sched.runNow('revenue'), false)
  await new Promise((res) => setTimeout(res, 50))
  assert.equal(store.lastRun('revenue'), null)
  assert.equal(sched.views()[0].state, 'idle')
  store.close()
})

test('normal command still completes idle', async () => {
  const { store, sched } = setup({ command: ['/bin/sh', '-c', 'echo "STATUS: 끝"; exit 0'] })
  assert.equal(sched.runNow('revenue'), true)
  await ended(store, 1)
  assert.equal(store.lastRun('revenue')!.exitCode, 0)
  assert.equal(sched.views()[0].state, 'idle')
  assert.equal(sched.views()[0].bubble, '끝')
  store.close()
})
