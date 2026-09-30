// §9 baseline: environment failures stop the task before the worker starts; ordinary base failures still run on the candidate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BaseResult } from '../../src/exec/checks.ts'
import { harness, req, sh, task, tsk, type Harness } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

const baselineRows = (h: Harness) => h.store.raw().prepare("select key, value from kv where key like 'baseline:%'").all() as { key: string; value: string }[]
const workAttempts = (h: Harness, taskId: string) => h.store.attempts(taskId).filter((a) => a.kind === 'work')

async function blocked(h: Harness, taskId: string, count = 1): Promise<void> {
  await h.waitFor(() => tsk(h, taskId).status === 'blocked' && tsk(h, taskId).block_count >= count, `blocked #${count}`)
}

function assertNoWorker(h: Harness, taskId: string): void {
  for (const a of workAttempts(h, taskId)) {
    assert.equal(a.status, 'start_failed', JSON.stringify(a))
    assert.equal(a.pid, null, 'fake claude never launched')
    assert.equal(existsSync(join(a.dir, 'hq', 'prompt.md')), false, 'no worker prompt written')
  }
}

test('T1. a base check exiting 127 blocks the task before the worker starts; nothing cached, a retry runs the baseline again', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'a5', text: '타입 검사', check: 'hq-no-such-command-xyz', kind: 'regression' }] })])
    await h.approve(id)
    await blocked(h, `${id}.A`)
    const note = tsk(h, `${id}.A`).note ?? ''
    assert.match(note, /^검사 명령이 원래 코드에서 실행되지 않아 작업을 시작하지 않았어요/)
    assert.match(note, /- \[a5\] hq-no-such-command-xyz → exit 127 \(명령을 찾지 못함\): .*not found/)
    assert.match(note, /원인 후보: 프로젝트 setup/)
    assertNoWorker(h, `${id}.A`)
    assert.deepEqual(baselineRows(h), [], 'env failure not stored')
    const first = workAttempts(h, `${id}.A`)
    assert.ok(existsSync(join(first[0].dir, 'hq', 'baseline.sb')), 'baseline ran')
    const t = tsk(h, `${id}.A`)
    assert.equal(h.runner.decideTask(t.id, 'retry', t.block_count), null)
    await blocked(h, `${id}.A`, 2)
    const again = workAttempts(h, `${id}.A`).filter((a) => !first.some((f) => f.id === a.id))
    assert.ok(again.length >= 1)
    assert.ok(existsSync(join(again[0].dir, 'hq', 'baseline.sb')), 'baseline ran again on retry')
    assertNoWorker(h, `${id}.A`)
    assert.match(tsk(h, `${id}.A`).note ?? '', /exit 127 \(명령을 찾지 못함\)/)
  } finally { await h.close() }
})

test('T2. a base check that does not finish in time blocks the task', async () => {
  const h = harness({ cfg: { checkTimeoutMinutes: 0.02 } })
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'a4', text: '서버 검사', check: 'sleep 30', kind: 'regression' }] })])
    await h.approve(id)
    await blocked(h, `${id}.A`)
    const note = tsk(h, `${id}.A`).note ?? ''
    assert.match(note, /- \[a4\] sleep 30 → 0\.02분 안에 끝나지 않음$/m)
    assertNoWorker(h, `${id}.A`)
    assert.deepEqual(baselineRows(h), [])
  } finally { await h.close() }
})

test('T3. project setup failing on the base blocks the task with one setup line', async () => {
  // Passes in the worker clone (.git is a folder), fails in the baseline mirror worktree (.git is a file).
  const h = harness({ setup: 'test -d .git || { echo "setup broke here"; exit 3; }' })
  try {
    const id = h.plan([task('A', { acceptance: [
      { id: 'A1', text: 'README 유지', check: 'test -f README.md', kind: 'regression' },
      { id: 'A2', text: '또 하나', check: 'test -f README.md', kind: 'regression' },
    ] })])
    await h.approve(id)
    await blocked(h, `${id}.A`)
    const note = tsk(h, `${id}.A`).note ?? ''
    assert.match(note, /^검사 명령이 원래 코드에서 실행되지 않아/)
    assert.equal(note.match(/- setup 명령 실패: setup broke here/g)?.length, 1, note)
    assert.doesNotMatch(note, /\[A1\]/)
    assertNoWorker(h, `${id}.A`)
    assert.deepEqual(baselineRows(h), [])
  } finally { await h.close() }
})

test('T4. a regression check failing on the base (exit 1) and passing on the candidate is a normal pass', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'R1', text: '결과 파일', check: 'test -f a/out.txt', kind: 'regression' }] })])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const work = workAttempts(h, `${id}.A`).find((a) => a.status === 'succeeded')!
    const checks = JSON.parse(readFileSync(join(work.dir, 'hq', 'checks.json'), 'utf8'))
    assert.equal(checks.pass, true)
    assert.deepEqual(checks.manual, [])
    assert.equal(checks.checks[0].pass, true)
    assert.equal(checks.checks[0].baseFailed, undefined)
    const stored = JSON.parse(baselineRows(h)[0].value) as BaseResult
    assert.equal(stored.pass, false); assert.equal(stored.exitCode, 1); assert.equal(stored.timedOut, false)
  } finally { await h.close() }
})

test('T5. a regression check failing on the base and on the candidate goes to review as manual, with both output tails', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'R1', text: '기존에 깨진 검사', check: 'ls missing.txt', kind: 'regression' }] })])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const atts = h.store.attempts(`${id}.A`)
    assert.equal(atts.filter((a) => a.kind === 'work').length, 1, 'no rework')
    const work = atts.find((a) => a.kind === 'work' && a.status === 'succeeded')!
    const checks = JSON.parse(readFileSync(join(work.dir, 'hq', 'checks.json'), 'utf8'))
    assert.equal(checks.pass, true)
    assert.deepEqual(checks.manual, ['R1'])
    assert.equal(checks.checks[0].pass, false)
    assert.equal(checks.checks[0].baseFailed, true)
    assert.match(checks.baseTails.R1, /missing\.txt/)
    const prompt = readFileSync(join(atts.find((a) => a.kind === 'review')!.dir, 'hq', 'prompt.md'), 'utf8')
    assert.match(prompt, /후보 출력/)
    assert.match(prompt, /base 출력/)
    assert.match(prompt, /base 출력:\n````text\n.*missing\.txt/)
  } finally { await h.close() }
})

const taskEvents = (h: Harness) => (h.store.raw().prepare("select text from events where kind = 'task' order by id").all() as { text: string }[]).map((r) => r.text)
const ADDED = '기존 실패 항목이 있어 검토를 추가해요 · sonnet'

test('T5b. manual items with review none → a sonnet review is added instead of passing', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { review: { brief: '', model: 'none' }, acceptance: [{ id: 'R1', text: '기존에 깨진 검사', check: 'ls missing.txt', kind: 'regression' }] })])
    await h.approve(id)
    assert.equal(tsk(h, `${id}.A`).review_model, 'none')
    await h.waitFor(() => taskEvents(h).includes(ADDED), 'review added')
    const t = tsk(h, `${id}.A`)
    assert.equal(t.review_model, 'sonnet')
    assert.ok(['reviewing', 'passed'].includes(t.status), t.status)
    await h.waitFor(() => h.store.attempts(`${id}.A`).some((a) => a.kind === 'review'), 'review attempt')
    assert.equal(h.store.attempts(`${id}.A`).find((a) => a.kind === 'review')!.model, 'sonnet')
  } finally { await h.close() }
})

test('T5c. no manual items with review none → passed without review, as before', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { review: { brief: '', model: 'none' } })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'passed', 'passed')
    const t = tsk(h, `${id}.A`)
    assert.equal(t.review_model, 'none')
    assert.equal(h.store.attempts(`${id}.A`).filter((a) => a.kind === 'review').length, 0)
    assert.equal(taskEvents(h).includes(ADDED), false)
  } finally { await h.close() }
})

test('T6. legacy baseline values pass/fail are read; unreadable values count as missing', async () => {
  const h = harness()
  try {
    const read = (v: string) => { h.store.set('baseline:x', v); return (h.runner as unknown as { readBase(k: string): BaseResult | null }).readBase('baseline:x') }
    assert.deepEqual(read('pass'), { pass: true, exitCode: 0, timedOut: false, tail: '' })
    assert.deepEqual(read('fail'), { pass: false, exitCode: null, timedOut: false, tail: '' })
    assert.deepEqual(read(JSON.stringify({ pass: false, exitCode: 2, timedOut: false, tail: 't' })), { pass: false, exitCode: 2, timedOut: false, tail: 't' })
    assert.equal(read('{broken'), null)
  } finally { await h.close() }
})

test('T6b. a legacy "fail" baseline for a regression check is run on the candidate and handed over as manual', async () => {
  const h = harness()
  try {
    const check = 'ls missing.txt'
    const base = sh(h.repo, 'rev-parse', 'HEAD')
    h.store.set(`baseline:${h.runner.mirror('p')}:${base}:${createHash('sha256').update(`\n${check}`).digest('hex')}`, 'fail')
    const id = h.plan([task('A', { acceptance: [{ id: 'R1', text: '기존', check, kind: 'regression' }] })])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const work = workAttempts(h, `${id}.A`).find((a) => a.status === 'succeeded')!
    assert.equal(existsSync(join(work.dir, 'hq', 'baseline.sb')), false, 'cached legacy value used')
    const checks = JSON.parse(readFileSync(join(work.dir, 'hq', 'checks.json'), 'utf8'))
    assert.deepEqual(checks.manual, ['R1'])
    assert.equal(checks.baseTails.R1, '')
  } finally { await h.close() }
})
