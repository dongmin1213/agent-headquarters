import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness, task } from './helpers.ts'
import { flowSignature } from '../../src/game-flow.ts'
import { checkVerdict } from '../../src/exec/review.ts'
import { TASK_SCHEMA } from '../../src/ceo.ts'
import type { GameFinding } from '../../src/game-feedback.ts'

async function fixture() {
  const h = harness(); h.runner.stop(); h.projects[0].workflow = 'game'
  const departments = ['research', 'direction', 'gameplay', 'art', 'level', 'qa', 'delivery'] as const
  const specs = departments.map((d, i) => task(d, { department: d, grade: 'L2', review: { model: 'sonnet', brief: '독립 검수' }, depends_on: i ? [departments[i - 1]] : [] }))
  const id = h.plan(specs); await h.approve(id)
  h.store.updateTask(`${id}.gameplay`, { status: 'running' })
  const dir = join(h.cfg.home, 'quality-feedback/p'); mkdirSync(dir, { recursive: true })
  const data = Buffer.from('fixture image'); writeFileSync(join(dir, 'ui-before.png'), data)
  const finding: GameFinding = { id: 'UI-001', owner: 'art', observation: '선택 장식이 글자에 겹침', repair: '선택 장식과 글자 영역을 분리하고 실제 화면에서 비교',
    sourceHead: 'a'.repeat(40), evidence: [{ file: 'ui-before.png', sha256: createHash('sha256').update(data).digest('hex') }] }
  return { h, id, finding, rows: () => h.store.tasks(id) }
}

test('observed defects bind pending owners and the downstream quality gate without touching live work or weakening criteria', async () => {
  const { h, id, finding, rows } = await fixture()
  try {
    const before = rows(), old = JSON.parse(h.store.task(`${id}.art`)!.spec)
    assert.equal(h.runner.registerGameFindings(id, [finding], 'qa', flowSignature(rows())), null)
    const current = JSON.parse(h.store.task(`${id}.art`)!.spec)
    assert.deepEqual(current.acceptance.slice(0, old.acceptance.length), old.acceptance)
    assert.equal(current.acceptance.at(-1).id, 'QF-UI-001')
    assert.equal(current.acceptance.at(-1).check, 'manual')
    assert.match(current.review.brief, /승인 차단/)
    assert.match(current.brief, /ui-before.png/)
    assert.match(current.brief, /이미 해결했다면 재생성하지 말고/)
    for (const row of before.filter(r => !['art', 'qa'].includes(r.key))) assert.deepEqual(h.store.task(row.id), row)
    const qa = JSON.parse(h.store.task(`${id}.qa`)!.spec)
    assert.ok(qa.depends_on.includes('art'))
    assert.ok(qa.acceptance.some((a: { id: string }) => a.id === 'QF-BATCH-UI-001'))
    assert.equal(JSON.parse(h.store.request(id)!.plan!).tasks.find((t: { id: string }) => t.id === 'art').acceptance.at(-1).id, 'QF-UI-001')
    assert.ok(h.store.get(`game.finding:${id}:UI-001`))
    const after = rows()
    assert.match(h.runner.registerGameFindings(id, [finding], 'qa', flowSignature(after))!, /이미 등록/)
    assert.deepEqual(rows(), after, 'duplicate is atomic')
  } finally { await h.close() }
})

test('stale state, missing/tampered evidence, running owner and cyclic prerequisite refuse the entire update', async () => {
  const { h, id, finding, rows } = await fixture()
  try {
    const before = rows()
    assert.match(h.runner.registerGameFindings(id, [finding], 'qa', 'stale')!, /상태/)
    assert.match(h.runner.registerGameFindings(id, [{ ...finding, evidence: [{ ...finding.evidence[0], sha256: '0'.repeat(64) }] }], 'qa', flowSignature(rows()))!, /해시/)
    assert.match(h.runner.registerGameFindings(id, [{ ...finding, owner: 'gameplay' }], 'qa', flowSignature(rows()))!, /미실행/)
    assert.match(h.runner.registerGameFindings(id, [{ ...finding, prerequisite: 'delivery' }], 'qa', flowSignature(rows()))!, /순환/)
    assert.deepEqual(rows(), before)
    assert.equal(h.store.get(`game.finding:${id}:UI-001`), null)
  } finally { await h.close() }
})

test('a pass cannot omit or leave evidence blank for registered defect criteria; follow-up schema accepts expanded contracts', () => {
  const options = { acceptanceIds: ['old', 'QF-UI-001'], codeChanged: false, bashRuns: [], judgeIds: ['QF-UI-001'] }
  const v = { pass: true, blocking: [], advisory: [], tests_run: [], criteria: [{ id: 'old', result: 'pass', evidence: 'existing check' }] }
  assert.equal(checkVerdict(v, options).kind, 'invalid')
  v.criteria.push({ id: 'QF-UI-001', result: 'pass', evidence: ' ' })
  assert.equal(checkVerdict(v, options).kind, 'invalid')
  v.criteria[1].evidence = 'after.png: 실제 선택 글자와 장식이 겹치지 않음'
  assert.equal(checkVerdict(v, options).kind, 'pass')
  assert.equal(TASK_SCHEMA.properties.acceptance.maxItems, 16)
})

test('corrective execution budget is bounded, durable, and does not reset paid attempt history', async () => {
  const { h, id } = await fixture()
  try {
    assert.equal(h.runner.gameAttemptLimit(id), 100)
    assert.equal(h.runner.grantGameRepairBudget(id, 112, '사용자 품질 개선 지시에 따른 추가 수정과 필수 검수'), null)
    assert.equal(h.runner.gameAttemptLimit(id), 112)
    assert.match(h.runner.grantGameRepairBudget(id, 125, 'more')!, /124/)
    assert.match(h.runner.grantGameRepairBudget(id, 99, 'less')!, /124/)
    assert.equal(h.runner.gameAttemptLimit(id), 112)
    const t = h.store.task(`${id}.research`)!
    for (let n = 1; n <= 112; n++) h.store.insertAttempt({ id: `${t.id}~a${n}`, task_id: t.id, kind: 'work', n, model: 'sonnet', status: 'failed', attempt_token: 'fixture', dir: h.dir, session_id: 'fixture', generation: t.generation })
    assert.equal(h.runner.readyTasks().length, 0, 'no further paid dispatch after the cap')
    assert.equal(h.store.attempts(t.id).length, 112)
    h.store.set(`game.attempt-budget:${id}`, JSON.stringify({ limit: 999, reason: 'bad' }))
    assert.equal(h.runner.gameAttemptLimit(id), 100, 'invalid stored cap fails closed')
  } finally { await h.close() }
})
