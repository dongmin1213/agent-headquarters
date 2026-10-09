import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { Runner } from '../../src/exec/runner.ts'
import { harness, ROOT, task, tsk } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'
useFakeSandboxIfNested()

test('partial game result survives daemon recovery, resumes its session, and cannot unlock downstream or skip review', async () => {
  const h = harness()
  try {
    h.store.set('limit.backoffUntil', new Date(h.clock.t + 60_000).toISOString())
    const id = h.plan([
      task('A', { department: 'gameplay', brief: '[[FAKE:write=a/evidence.txt]] [[FAKE:checkpointonce]] [[FAKE:sleep=300]]' }),
      task('B', { department: 'gameplay', depends_on: ['A'] }),
    ])
    await h.approve(id)
    h.projects[0].workflow = 'game'
    h.store.set('limit.backoffUntil', null)
    const tid = `${id}.A`
    await h.waitFor(() => h.store.attempts(tid)[0]?.status === 'running')
    const first = h.store.attempts(tid)[0]
    // Hold new starts while judging the finished attempt so we can inspect its durable pending state.
    h.store.set('limit.backoffUntil', new Date(h.clock.t + 60_000).toISOString())
    await h.waitFor(() => h.store.attempt(first.id)?.status === 'checkpoint')
    const partial = tsk(h, tid)
    assert.equal(partial.status, 'pending')
    assert.equal(partial.head_sha, null)
    assert.equal(partial.checks_state, null)
    assert.equal(partial.resume_session, h.store.attempt(first.id)!.session_id)
    assert.equal(tsk(h, `${id}.B`).status, 'pending')
    assert.equal(h.store.attempts(`${id}.B`).length, 0)
    assert.equal(h.store.attempts(tid).filter(a => a.kind === 'review').length, 0)
    const sealed = JSON.parse(readFileSync(join(first.dir, 'hq/result.json'), 'utf8'))
    assert.equal(sealed.outcome, 'checkpoint')
    assert.ok(sealed.fetched)
    assert.ok(existsSync(join(partial.worktree!, 'a/evidence.txt')))
    h.runner.stop()
    await h.runner.drain()
    const restarted = new Runner({ store: h.store, bus: h.bus, cfg: h.cfg, projects: h.projects, hqRoot: ROOT,
      hqPort: 17999, notify: () => {}, now: () => h.clock.t, tokenDir: join(h.dir, 'tok') })
    h.runner = restarted
    await restarted.recover()
    h.store.set('limit.backoffUntil', null)
    await h.waitFor(() => tsk(h, tid).status === 'passed')
    const works = h.store.attempts(tid).filter(a => a.kind === 'work')
    assert.deepEqual(works.map(a => a.status), ['checkpoint', 'succeeded'])
    assert.equal(works[0].session_id, works[1].session_id)
    assert.equal(tsk(h, tid).attempts, 1, 'checkpoint is not a model-escalating failure')
    assert.equal(works[1].model, works[0].model)
    assert.ok(h.store.attempts(tid).some(a => a.kind === 'review' && a.status === 'succeeded'), 'final result still independently reviewed')
    assert.equal(tsk(h, tid).checks_state, 'passed')
  } finally { await h.close() }
})

test('repeated partial results stop at a durable per-generation cap instead of generating unlimited paid work', async () => {
  const h = harness()
  try {
    h.store.set('limit.backoffUntil', new Date(h.clock.t + 60_000).toISOString())
    const id = h.plan([task('A', { department: 'gameplay', brief: '[[FAKE:write=a/evidence.txt]] [[FAKE:outcome=checkpoint]]' })])
    await h.approve(id)
    h.projects[0].workflow = 'game'
    h.store.set('limit.backoffUntil', null)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked')
    const attempts = h.store.attempts(`${id}.A`)
    assert.deepEqual(attempts.map(a => a.status), ['checkpoint', 'checkpoint', 'checkpoint', 'brief_blocked'])
    assert.match(tsk(h, `${id}.A`).note!, /중간 저장 상한 3회/)
    assert.equal(tsk(h, `${id}.A`).head_sha, null)
    assert.equal(attempts.filter(a => a.kind === 'review').length, 0)
    // A user/supervisor-revised contract has a bounded new continuation allowance.
    // No execution history or global execution budget is reset.
    const before = tsk(h, `${id}.A`)
    h.store.updateTask(before.id, { status: 'pending', revision: before.revision + 1, generation: before.generation + 1, resume_session: null })
    h.store.updateRequest(id, { status: 'executing', note: null })
    await h.waitFor(() => tsk(h, before.id).status === 'blocked')
    const all = h.store.attempts(before.id)
    assert.equal(all.length, 8)
    assert.match(readFileSync(join(all[3].dir, 'hq/prompt.md'), 'utf8'), /현재 계약 중간 저장: 3\/3회 사용, 0회 남음/)
    assert.match(readFileSync(join(all[4].dir, 'hq/prompt.md'), 'utf8'), /현재 계약 중간 저장: 0\/3회 사용, 3회 남음/)
    assert.deepEqual(all.slice(4).map(a => a.status), ['checkpoint', 'checkpoint', 'checkpoint', 'brief_blocked'])
    assert.equal(tsk(h, before.id).head_sha, null, 'continuations never approve the product')
  } finally { await h.close() }
})

test('resubmitting the same fetched commit and evidence cannot obtain another continuation', async () => {
  const h = harness()
  try {
    h.store.set('limit.backoffUntil', new Date(h.clock.t + 60_000).toISOString())
    const id = h.plan([task('A', { department: 'gameplay', brief: '[[FAKE:write=a/evidence.txt]] [[FAKE:outcome=checkpoint]] [[FAKE:checkpointstale]]' })])
    await h.approve(id)
    h.projects[0].workflow = 'game'
    h.store.set('limit.backoffUntil', null)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked')
    assert.deepEqual(h.store.attempts(`${id}.A`).map(a => a.status), ['checkpoint', 'brief_blocked'])
    assert.match(tsk(h, `${id}.A`).note!, /새 변경 일반 파일이 아님/)
    assert.equal(tsk(h, `${id}.A`).head_sha, null)
  } finally { await h.close() }
})
