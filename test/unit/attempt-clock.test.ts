import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttemptClock } from '../../src/exec/attempt-clock.ts'
import { harness, task } from './helpers.ts'

test('sleep and restart preserve the supervised budget without charging hours offline', async () => {
  const h = harness()
  try {
    let clock = new AttemptClock(h.store)
    clock.track('a', 1000)
    assert.equal(clock.sample('a', 31_000), 30_000)
    assert.equal(clock.sample('a', 4 * 3600_000 + 31_000), 30_000)
    const b = JSON.parse(h.store.get('attempt.clock:a')!)
    assert.equal(b.unobservedMs, 4 * 3600_000)
    clock = new AttemptClock(h.store)
    clock.track('a', 8 * 3600_000)
    assert.equal(clock.sample('a', 8 * 3600_000 + 30_000), 60_000)
    assert.equal(clock.sample('a', 0), 60_000, 'clock rollback never subtracts budget')
  } finally { await h.close() }
})

test('live worker survives a four-hour observation gap and still hits its active-time cap', async () => {
  const h = harness()
  h.cfg.attemptWallMinutes = { ...h.cfg.attemptWallMinutes, L1: 0.5 }
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:sleep=60000]]' })])
    await h.approve(id)
    await h.waitFor(() => !!h.store.attempts(`${id}.A`)[0]?.pid)
    const a = h.store.attempts(`${id}.A`)[0]
    h.clock.t += 4 * 3600_000
    await h.runner.tick()
    assert.equal(h.store.attempt(a.id)!.status, 'running')
    assert.equal(h.store.attempt(a.id)!.outcome, null)
    assert.equal(h.store.attempt(a.id)!.pid, a.pid)
    h.clock.t += 31_000
    await h.waitFor(() => h.store.attempt(a.id)!.status === 'runaway')
    assert.match(h.store.attempt(a.id)!.reason!, /시간 초과/)
    assert.equal(new AttemptClock(h.store).spent(h.store.attempt(a.id)!), 31_000)
    h.runner.cancelRequest(id)
  } finally { await h.close() }
})
