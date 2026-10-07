import { test } from 'node:test'
import assert from 'node:assert/strict'
import { task, harness } from './helpers.ts'
import { ancestors, containedOwn, flowCandidates, flowDue, flowSignature, FLOW_COOLDOWN_MS, FLOW_MAX_TURNS } from '../../src/game-flow.ts'
import { gameWaitSignature } from '../../src/game.ts'
import type { PlanTask } from '../../src/ceo.ts'

async function fixture(text = '[[FAKE:flowsplit]]') {
  const h = harness()
  h.projects[0].workflow = 'game'; h.runner.stop()
  const departments = ['research', 'direction', 'gameplay', 'art', 'level', 'qa', 'delivery'] as const
  const specs = departments.map((department, i) => task(department, { department, grade: 'L2',
    review: { model: 'sonnet', brief: '검수' }, depends_on: i ? [departments[i - 1]] : [],
    ...(department === 'art' ? { owns: ['assets/**', 'art/**'] } : {}),
  }))
  const id = h.plan(specs, text); await h.approve(id)
  for (const key of ['research', 'direction']) h.store.updateTask(`${id}.${key}`, { status: 'passed' })
  h.store.updateTask(`${id}.gameplay`, { status: 'running' })
  h.store.insertAttempt({ id: `${id}.gameplay~a1`, task_id: `${id}.gameplay`, kind: 'work', n: 1, model: 'sonnet', status: 'running',
    attempt_token: 'fixture', dir: h.dir, session_id: 'fixture', generation: 0 })
  return { h, id, rows: () => h.store.tasks(id), child: (): PlanTask => ({ ...specs[3], id: 'ui-branch', owns: ['assets/ui/**'], depends_on: ['direction'],
    acceptance: [1, 2, 3].map(i => ({ id: `U${i}`, text: '검수', check: 'manual', kind: 'new' })) }) }
}

test('unobserved quota permits a supervisor beside one worker, respects capacity and login holds', async () => {
  const { h, id } = await fixture()
  try {
    assert.equal(h.runner.quota().mode, 'unobserved')
    assert.equal(h.runner.canStartCeo(), false)
    assert.equal(h.runner.canStartGameSupervisor(), true)
    h.cfg.maxWorkers = 1; assert.equal(h.runner.canStartGameSupervisor(), false); h.cfg.maxWorkers = 2
    h.store.set('login.required', 'yes'); assert.equal(h.runner.canStartGameSupervisor(), false); h.store.set('login.required', null)
    h.store.insertAttempt({ id: `${id}.art~a1`, task_id: `${id}.art`, kind: 'work', n: 1, model: 'sonnet', status: 'starting',
      attempt_token: 'fixture', dir: h.dir, session_id: 'second', generation: 0 })
    assert.equal(h.runner.canStartGameSupervisor(), false)
  } finally { await h.close() }
})

test('engine actually resolves an internal blocked task while another worker stays active', async () => {
  const { h, id } = await fixture('ordinary repair')
  try {
    const tid = `${id}.art`
    h.store.updateTask(tid, { status: 'blocked', note: '작업 판단 필요', worktree: h.repo })
    const before = gameWaitSignature(h.store, h.store.task(tid)!)
    await h.engine.tick()
    assert.ok(h.store.get(`game.decision:${tid}:1`))
    assert.notEqual(gameWaitSignature(h.store, h.store.task(tid)!), before)
    assert.equal(h.store.task(`${id}.gameplay`)!.status, 'running')
    assert.equal(h.store.liveAttempts().length, 1)
  } finally { await h.close() }
})

test('an independent worker starts beside a busy supervisor without exceeding the two-slot limit', async () => {
  const h = harness()
  try {
    h.runner.ceoLock.tryAcquire()
    const id = h.plan(['A', 'B'].map(k => task(k, { brief: `[[FAKE:sleep=10000]] [[FAKE:write=${k.toLowerCase()}/out.txt]]` })))
    await h.approve(id)
    await h.waitFor(() => h.store.liveAttempts().length === 1, 'one worker alongside supervisor')
    for (let i = 0; i < 3; i++) await h.runner.tick()
    assert.equal(h.store.liveAttempts().length, 1)
    assert.equal(h.store.tasks(id).filter(t => t.status === 'pending').length, 1)
  } finally { h.runner.ceoLock.release(); await h.close() }
})

test('flow watch counts observed waiting, persists dedupe/cooldown/cap and ignores sleep gaps', async () => {
  const { h, id, rows } = await fixture()
  try {
    const now = () => h.clock.t
    assert.equal(flowDue(h.store, id, rows(), now(), true), false)
    h.clock.t += 4 * 60 * 60_000
    assert.equal(flowDue(h.store, id, rows(), now(), true), false)
    for (let i = 0; i < 3; i++) { h.clock.t += 60_000; assert.equal(flowDue(h.store, id, rows(), now(), true), i === 2) }
    h.store.set(`game.flow-seen:${id}:${flowSignature(rows())}`, 'done')
    assert.equal(flowDue(h.store, id, rows(), now(), true), false)
    h.store.set(`game.flow-seen:${id}:${flowSignature(rows())}`, null)
    h.store.set(`game.flow-last:${id}`, JSON.stringify({ at: now() }))
    assert.equal(flowDue(h.store, id, rows(), now(), true), false)
    h.store.set(`game.flow-last:${id}`, JSON.stringify({ at: now() - FLOW_COOLDOWN_MS }))
    assert.equal(flowDue(h.store, id, rows(), now(), true), true)
    h.store.set(`game.flow-count:${id}`, String(FLOW_MAX_TURNS))
    assert.equal(flowDue(h.store, id, rows(), now(), true), false)
    flowDue(h.store, id, rows(), now(), false)
    assert.equal(h.store.get(`game.flow-watch:${id}`), null)
  } finally { await h.close() }
})

test('pending split preserves active task, every parent criterion, old dependency and final gate', async () => {
  const { h, id, rows, child } = await fixture()
  try {
    const active = h.store.task(`${id}.gameplay`), parent = JSON.parse(h.store.task(`${id}.art`)!.spec)
    assert.equal(h.runner.splitPendingGameTask(id, 'art', child(), flowSignature(rows())), null)
    const updated = JSON.parse(h.store.task(`${id}.art`)!.spec)
    assert.deepEqual(updated.acceptance, parent.acceptance)
    assert.deepEqual(updated.review, parent.review)
    assert.deepEqual(updated.depends_on, ['gameplay', 'ui-branch'])
    assert.deepEqual(h.store.task(`${id}.gameplay`), active)
    assert.ok(ancestors(rows(), 'delivery').some(t => t.key === 'ui-branch'))
    assert.ok(h.runner.readyTasks().some(t => t.key === 'ui-branch'))
    assert.equal(JSON.parse(h.store.request(id)!.plan!).tasks.length, 8)
  } finally { await h.close() }
})

test('split rejects stale state, ownership expansion/conflict, changed models and incomplete quality gate', async () => {
  const { h, id, rows, child } = await fixture()
  try {
    const sig = () => flowSignature(rows())
    assert.match(h.runner.splitPendingGameTask(id, 'art', child(), 'stale')!, /상태/)
    assert.match(h.runner.splitPendingGameTask(id, 'art', { ...child(), owns: ['../secret'] }, sig())!, /범위/)
    assert.match(h.runner.splitPendingGameTask(id, 'art', { ...child(), model: 'opus' }, sig())!, /모델/)
    assert.match(h.runner.splitPendingGameTask(id, 'art', { ...child(), depends_on: ['gameplay'] }, sig())!, /승인/)
    const g = h.store.task(`${id}.gameplay`)!
    h.store.updateTask(g.id, { spec: JSON.stringify({ ...JSON.parse(g.spec), owns: ['assets/ui/**'] }) })
    assert.match(h.runner.splitPendingGameTask(id, 'art', child(), sig())!, /소유 경로/)
    h.store.updateTask(g.id, { spec: JSON.stringify({ ...JSON.parse(g.spec), department: 'qa' }) })
    assert.match(h.runner.splitPendingGameTask(id, 'art', child(), sig())!, /품질 관문/)
    assert.equal(flowCandidates(h.store, rows()).length, 0)
    h.store.updateTask(g.id, { spec: JSON.stringify({ ...JSON.parse(g.spec), department: 'direction' }) })
    assert.match(h.runner.splitPendingGameTask(id, 'art', child(), sig())!, /기획/)
    assert.equal(flowCandidates(h.store, rows()).length, 0)
    assert.equal(h.store.task(`${id}.ui-branch`), null)
    assert.equal(containedOwn('assets2/x', ['assets/**']), false)
  } finally { await h.close() }
})

test('proactive engine audit dispatches a bounded split without waiting for a failed task', async () => {
  const { h, id } = await fixture()
  try {
    await h.engine.tick()
    for (let i = 0; i < 3; i++) { h.clock.t += 60_000; await h.engine.tick() }
    assert.equal(h.store.task(`${id}.ui-branch`)?.status, 'pending')
    assert.equal(h.store.get(`game.flow-count:${id}`), '1')
    await h.engine.tick()
    assert.equal(h.store.get(`game.flow-count:${id}`), '1')
    assert.equal(h.store.task(`${id}.gameplay`)?.status, 'running')
  } finally { await h.close() }
})

test('a legitimate sequence is retained and the same bottleneck never buys another audit', async () => {
  const { h, id, rows } = await fixture('keep the real dependency')
  try {
    await h.engine.tick()
    for (let i = 0; i < 3; i++) { h.clock.t += 60_000; await h.engine.tick() }
    assert.equal(h.store.task(`${id}.ui-branch`), null)
    const record = JSON.parse(h.store.get(`game.flow-seen:${id}:${flowSignature(rows())}`)!)
    assert.match(record.reason, /real dependency/)
    h.clock.t += FLOW_COOLDOWN_MS
    for (let i = 0; i < 4; i++) { h.clock.t += 60_000; await h.engine.tick() }
    assert.equal(h.store.get(`game.flow-count:${id}`), '1')
    assert.equal(h.store.openApprovals().filter(a => a.id.startsWith('game.flow')).length, 0)
  } finally { await h.close() }
})
