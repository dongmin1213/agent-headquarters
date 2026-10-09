import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness, task, tsk } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'
useFakeSandboxIfNested()

for (const remaining of [5, 0]) test(`continuation exposes ${remaining} remaining minutes and never launches with exhausted time`, async () => {
  const h = harness()
  try {
    h.store.set('limit.backoffUntil', new Date(h.clock.t + 60000).toISOString())
    const id = h.plan([task('A', { department: 'gameplay', brief: '[[FAKE:write=a/evidence.txt]] [[FAKE:checkpointonce]] [[FAKE:sleep=300]]' })])
    await h.approve(id)
    h.projects[0].workflow = 'game'
    h.store.set('limit.backoffUntil', null)
    const tid = `${id}.A`
    await h.waitFor(() => !!h.store.attempts(tid)[0]?.pid)
    const first = h.store.attempts(tid)[0]
    h.store.set('limit.backoffUntil', new Date(h.clock.t + 60000).toISOString())
    await h.waitFor(() => h.store.attempt(first.id)?.status === 'checkpoint')
    const cap = 3 * h.cfg.attemptWallMinutes.L1 * 60000
    h.store.set(`attempt.clock:${first.id}`, JSON.stringify({ activeMs: cap - remaining * 60000, unobservedMs: 0 }))
    h.store.set('limit.backoffUntil', null)
    if (!remaining) {
      await h.waitFor(() => tsk(h, tid).status === 'blocked')
      assert.equal(h.store.attempts(tid).length, 1, 'no paid continuation is spawned')
      assert.match(tsk(h, tid).note!, /누적 시간 예산 소진/)
    } else {
      await h.waitFor(() => !!h.store.attempts(tid)[1]?.pid)
      const next = h.store.attempts(tid)[1]
      const prompt = readFileSync(join(next.dir, 'hq/prompt.md'), 'utf8')
      assert.match(prompt, /현재 계약 누적 잔여 5\.0분, 실제 사용 가능 5\.0분/)
      assert.match(prompt, /마지막 1\.0분은 커밋/)
      assert.equal(next.session_id, h.store.attempt(first.id)!.session_id)
      h.runner.cancelRequest(id)
    }
    assert.equal(tsk(h, tid).head_sha, null, 'time accounting never approves unfinished work')
  } finally { await h.close() }
})
