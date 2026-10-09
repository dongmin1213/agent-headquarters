// End-to-end flows through the runner with the fake claude (exec-engine-spec §G 5-12, 14, 15).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decisionItems } from '../../src/exec/decisions.ts'
import { commitFile, harness, req, sh, task, tsk, type Harness } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

const firstArgv = (dir: string): string[] => JSON.parse(readFileSync(join(dir, 'hq', 'stream.jsonl'), 'utf8').split('\n')[0]).argv

async function toMergeCard(h: Harness, id: string): Promise<void> {
  await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', `${id} awaiting_acceptance`)
  assert.equal(await h.decide(`accept:${id}`, '수락'), null)
  await h.waitFor(() => h.store.approval(`merge:${id}:p`)?.state === 'open', 'merge card')
}

test('6. full success: plan → work → checks → review pass → integration → accept → merge --ff-only', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A')])
    assert.equal(await h.approve(id), null)
    assert.equal(req(h, id).status, 'executing')
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const t = tsk(h, `${id}.A`)
    assert.equal(t.status, 'passed')
    assert.equal(t.attempts, 1)
    assert.equal(h.store.mergeRow(id, 'p')!.state, 'integrated')
    const acc = decisionItems(h.store, h.clock.t).find((d) => d.kind === 'accept')!
    assert.ok(acc.optionHelp['수락'] && acc.optionHelp['반려'], 'accept optionHelp has 수락 and 반려')
    assert.equal(acc.recommendation, null)
    assert.equal(acc.detailPath, `/ui/#request=${id}`)
    const rv = h.store.attempts(t.id).find((a) => a.kind === 'review')!
    assert.equal(rv.status, 'succeeded')
    assert.ok(firstArgv(rv.dir).includes('--output-schema'))
    assert.equal(await h.decide(`accept:${id}`, '수락'), null)
    assert.equal(req(h, id).status, 'accepted')
    await h.waitFor(() => h.store.approval(`merge:${id}:p`)?.state === 'open', 'merge card')
    assert.equal(await h.decide(`merge:${id}:p`, '병합'), null)
    assert.equal(req(h, id).status, 'merged')
    assert.equal(sh(h.repo, 'rev-parse', 'HEAD'), h.store.mergeRow(id, 'p')!.integration_sha)
    assert.ok(existsSync(`${h.repo}/a/out.txt`))
    assert.equal(existsSync(t.worktree!), false, 'worker clone removed')
    assert.ok(t.worktree!.includes('/work/'), 'work happens in a clone under $HQ_HOME/work')
  } finally { await h.close() }
})

test('5. ladder: checks fail every time → sonnet, sonnet, opus → blocked, one notification; diagnosis fills the card', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'A1', text: '파일 없음', check: 'test ! -e a/out.txt', kind: 'regression' }] })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked', 'blocked')
    const works = h.store.attempts(`${id}.A`).filter((a) => a.kind === 'work')
    assert.deepEqual(works.map((a) => a.model), ['sonnet', 'sonnet', 'opus'])
    assert.equal(tsk(h, `${id}.A`).attempts, 3)
    assert.equal(req(h, id).status, 'blocked')
    await h.waitFor(() => tsk(h, `${id}.A`).diagnosis !== null, 'diagnosis')
    await h.runner.tick()
    assert.equal(h.notes.filter(([t]) => t.includes('막혔어요')).length, 1)
    const item = decisionItems(h.store, h.clock.t).find((d) => d.kind === 'blocked')!
    assert.equal(item.situation, '가짜 진단: 검사가 계속 실패했어요')
    assert.equal(item.causeConfirmed, true)
    assert.deepEqual(item.recommendation, { option: 'skip', reason: '가짜 추천 이유' })
    assert.deepEqual(item.options, ['retry', 'skip', 'stop'])
    assert.ok(item.optionHelp.retry.includes('같은 모델'))
    assert.equal(item.detailPath, `/ui/#request=${id}&task=${encodeURIComponent(`${id}.A`)}`)
  } finally { await h.close() }
})

test('diagnosis with an unknown option falls back to hq facts', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:nodone]] [[FAKE:diag=badoption]]' })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked' && tsk(h, `${id}.A`).diagnosis !== null, 'blocked + diagnosis')
    assert.equal(JSON.parse(tsk(h, `${id}.A`).diagnosis!).ok, false)
    const item = decisionItems(h.store, h.clock.t).find((d) => d.kind === 'blocked')!
    assert.equal(item.recommendation, null)
    assert.equal(item.causeConfirmed, true)
    assert.match(item.cause!, /done\.json/)
  } finally { await h.close() }
})

test('7. multiple dependencies: C starts from hq merge of A and B heads; C owns check sees only its own files', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A'), task('B'), task('C', { depends_on: ['A', 'B'] })])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance', 90_000)
    const [a, b, c] = ['A', 'B', 'C'].map((k) => tsk(h, `${id}.${k}`))
    const mirror = ['--git-dir', join(h.runner.home, 'repos', 'p.git')]
    const parents = sh(h.repo, ...mirror, 'rev-list', '--parents', '-n1', c.base_sha!).split(' ').slice(1)
    assert.deepEqual(parents.sort(), [a.head_sha!, b.head_sha!].sort())
    assert.deepEqual(sh(h.repo, ...mirror, 'diff', '--name-only', c.base_sha!, c.head_sha!).split('\n'), ['c/out.txt'])
  } finally { await h.close() }
})

test('8. invalidation: rejecting A after C passed resets C (pending, attempts 0, new generation), drops its clone and keeps its mirror refs', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A'), task('C', { depends_on: ['A'] })])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance', 90_000)
    const c0 = tsk(h, `${id}.C`)
    const card = h.store.approval(`accept:${id}`)!
    assert.equal(h.runner.rejectResult(id, '다시 해 주세요', card.subjectHash, ['A']), null)
    const c = tsk(h, `${id}.C`)
    assert.equal(c.status, 'pending')
    assert.equal(c.attempts, 0)
    assert.equal(c.head_sha, null)
    assert.equal(c.generation, c0.generation + 1)
    assert.equal(tsk(h, `${id}.A`).status, 'rework')
    assert.equal(h.store.approval(`accept:${id}`)?.state, 'superseded')
    await h.waitFor(() => !existsSync(c0.worktree!), 'old clone removed')
    const refs = sh(h.repo, '--git-dir', join(h.runner.home, 'repos', 'p.git'), 'for-each-ref', '--format=%(refname)', `refs/hq/${id}/C/`)
    assert.match(refs, /\/a1$/m, 'old result ref kept in the mirror')
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance again', 90_000)
    assert.notEqual(tsk(h, `${id}.C`).base_sha, c0.base_sha)
    assert.ok(h.store.attempts(`${id}.C`).filter((a) => a.kind === 'work').map((a) => a.n).join(',').startsWith('1,2'), 'attempt numbers keep growing')
  } finally { await h.close() }
})

test('9. worker questions: partial answer keeps question, stale revision is refused, full answer resumes the same session uncounted', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:write=a/out.txt]] [[FAKE:outcome=question]] [[FAKE:questions=2]]' })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => tsk(h, tid).status === 'question', 'question')
    const qs = h.store.taskQuestions(tid)
    assert.equal(qs.length, 2)
    assert.equal(h.runner.answerTask(tid, qs[0].id, '예', 0), null)
    assert.equal(tsk(h, tid).status, 'question')
    assert.match(h.runner.answerTask(tid, qs[1].id, '예', 1)!, /revision/)
    assert.equal(h.runner.answerTask(tid, qs[1].id, '아니오', 0), null)
    assert.equal(tsk(h, tid).status, 'pending')
    await h.waitFor(() => ['reviewing', 'passed'].includes(tsk(h, tid).status), 'resumed and succeeded')
    const [a1, a2] = h.store.attempts(tid).filter((a) => a.kind === 'work')
    const argv = firstArgv(a2.dir)
    assert.equal(argv[argv.indexOf('resume') + 1], a1.session_id.replace(/^codex:/, ''))
    assert.equal(tsk(h, tid).attempts, 1)
    assert.match(readFileSync(join(a2.dir, 'hq', 'prompt.md'), 'utf8'), /질문 2\? → 아니오/)
  } finally { await h.close() }
})

test('10. brief_blocked → revise turn: same owns auto-applies (revision+1); widened owns → revise card; third block → blocked', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:outcome=blocked]]' }), task('B', { brief: '[[FAKE:outcome=blocked]] [[FAKE:revise=widen]]' })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked', 'A blocked after two revisions', 90_000)
    const a = tsk(h, `${id}.A`)
    assert.equal(a.revision, 2)
    assert.equal(a.revise_turns, 2)
    assert.match(JSON.parse(a.spec).brief, /\(수정됨\) \(수정됨\)/)
    assert.equal(h.store.attempts(a.id).filter((x) => x.status === 'brief_blocked').length, 3)
    assert.equal(a.attempts, 1, 'brief_blocked restarts are not counted')
    await h.waitFor(() => h.store.approval(`revise:${id}.B`)?.state === 'open', 'revise card for widened owns')
    assert.equal(tsk(h, `${id}.B`).status, 'revising')
    assert.equal(tsk(h, `${id}.B`).revision, 0)
    assert.equal(await h.decide(`revise:${id}.B`, '승인'), null)
    const b = tsk(h, `${id}.B`)
    assert.equal(b.revision, 1)
    assert.deepEqual(JSON.parse(b.spec).owns, ['b/**', 'extra/**'])
  } finally { await h.close() }
})

test('11. limits: rejected event → held, no new starts until the latest blocking reset, then --resume uncounted; 3 in a row → blocked', async () => {
  const h = harness()
  try {
    const resets = Math.floor(h.clock.t / 1000) + 3600
    const id = h.plan([task('A', { brief: `[[FAKE:write=a/out.txt]] [[FAKE:rejectfirst]] [[FAKE:resets=${resets}]]` }), task('B', { depends_on: ['A'] })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => tsk(h, tid).status === 'held', 'held')
    const q = h.runner.quota()
    assert.equal(q.mode, 'hold')
    assert.equal(q.until, new Date(resets * 1000).toISOString())
    for (let i = 0; i < 5; i++) await h.runner.tick()
    assert.equal(h.store.liveAttempts().length, 0, 'no new start while holding')
    assert.equal(h.store.attempts(tid).length, 1)
    h.clock.t = resets * 1000 + 1000
    await h.waitFor(() => ['reviewing', 'passed'].includes(tsk(h, tid).status), 'resumed')
    const [a1, a2] = h.store.attempts(tid).filter((a) => a.kind === 'work')
    assert.equal(a1.status, 'limited')
    const argv = firstArgv(a2.dir)
    assert.equal(argv[argv.indexOf('resume') + 1], a1.session_id.replace(/^codex:/, ''))
    assert.equal(tsk(h, tid).attempts, 1)
  } finally { await h.close() }
  const h2 = harness()
  try {
    const id = h2.plan([task('A', { brief: '[[FAKE:rejectalways]]' })])
    await h2.approve(id)
    await h2.waitFor(() => {
      if (tsk(h2, `${id}.A`).status === 'held') h2.clock.t += 2 * 3600_000
      return tsk(h2, `${id}.A`).status === 'blocked'
    }, 'blocked after 3 limited')
    assert.equal(tsk(h2, `${id}.A`).limited_streak, 3)
    assert.equal(h2.store.attempts(`${id}.A`).filter((a) => a.status === 'limited').length, 3)
  } finally { await h2.close() }
})

test('12. runaway: wall time exceeded → group SIGTERM → runaway → rework; 3 identical errors → runaway', async () => {
  const h = harness()
  h.cfg.attemptWallMinutes = { ...h.cfg.attemptWallMinutes, L1: 0.01 }
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:sleep=60000]]' })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => h.store.attempts(tid).some((a) => a.status === 'running' && a.pid), 'running')
    h.clock.t += 610 // observed time exceeds 600ms; long unobserved sleep gaps are tested separately
    await h.waitFor(() => h.store.attempts(tid)[0].status === 'runaway', 'runaway')
    assert.match(h.store.attempts(tid)[0].reason!, /시간 초과/)
    assert.ok(['rework', 'running'].includes(tsk(h, tid).status))
    assert.equal(h.runner.cancelRequest(id), null)
  } finally { await h.close() }
  const h2 = harness()
  try {
    const id = h2.plan([task('A', { brief: '[[FAKE:errors=3]] [[FAKE:sleep=60000]]' })])
    await h2.approve(id)
    await h2.waitFor(() => h2.store.attempts(`${id}.A`)[0]?.status === 'runaway', 'runaway by repeated errors')
    assert.match(h2.store.attempts(`${id}.A`)[0].reason!, /같은 도구 오류 3회/)
    assert.equal(h2.runner.cancelRequest(id), null)
  } finally { await h2.close() }
})

test('14. stale merge: target moved / dirty / detached → no merge, re-integration and a new card', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A')])
    await h.approve(id)
    await toMergeCard(h, id)
    const rev0 = h.store.approval(`merge:${id}:p`)!
    // (a) a new commit on the target
    const moved = commitFile(h.repo, 'other.txt', 'x\n', 'user work')
    assert.match((await h.decide(`merge:${id}:p`, '병합'))!, /새 커밋/)
    assert.equal(sh(h.repo, 'rev-parse', 'HEAD'), moved, 'not merged')
    await h.waitFor(() => h.store.approval(`merge:${id}:p`)!.revision > rev0.revision && h.store.approval(`merge:${id}:p`)!.state === 'open', 'new card')
    const rev1 = h.store.approval(`merge:${id}:p`)!
    assert.notEqual(rev1.subjectHash, rev0.subjectHash)
    assert.match(rev1.body.split('\n')[0], /새 커밋/)
    assert.equal(h.store.mergeRow(id, 'p')!.target_sha, moved)
    // (b) dirty checkout
    const { writeFileSync, rmSync } = await import('node:fs')
    writeFileSync(join(h.repo, 'README.md'), 'dirty\n')
    assert.match((await h.decide(`merge:${id}:p`, '병합'))!, /커밋되지 않은/)
    await h.waitFor(() => h.store.approval(`merge:${id}:p`)!.revision > rev1.revision && h.store.approval(`merge:${id}:p`)!.state === 'open', 'card after dirty')
    assert.match(h.store.mergeRow(id, 'p')!.note ?? '', /커밋되지 않은|새 커밋/)
    sh(h.repo, 'checkout', '--', 'README.md')
    // (c) detached HEAD
    const head = sh(h.repo, 'rev-parse', 'HEAD')
    sh(h.repo, 'checkout', '-q', '--detach', head)
    const rev2 = h.store.approval(`merge:${id}:p`)!
    assert.equal(await h.decide(`merge:${id}:p`, '병합'), 'detached HEAD')
    assert.equal(h.store.mergeRow(id, 'p')!.state, 'detached')
    assert.equal(req(h, id).status, 'accepted')
    assert.equal(sh(h.repo, 'rev-parse', 'HEAD'), head)
    sh(h.repo, 'checkout', '-q', 'main')
    assert.equal(h.runner.reofferMerge(id), null)
    await h.waitFor(() => h.store.approval(`merge:${id}:p`)!.revision > rev2.revision && h.store.approval(`merge:${id}:p`)!.state === 'open', 'reoffered card')
    assert.equal(await h.decide(`merge:${id}:p`, '병합'), null)
    assert.equal(req(h, id).status, 'merged')
    rmSync(join(h.repo, 'nonexistent'), { force: true })
  } finally { await h.close() }
})

test('15. integration conflict: two requests change the same file, accepted in sequence → integration card, request blocked', async () => {
  const h = harness()
  try {
    const r1 = h.plan([task('A', { owns: ['shared.txt'], brief: '[[FAKE:write=shared.txt]] [[FAKE:content=one]]' })], '첫 요청')
    const r2 = h.plan([task('B', { owns: ['shared.txt'], brief: '[[FAKE:write=shared.txt]] [[FAKE:content=two]]' })], '둘째 요청')
    await h.approve(r1); await h.approve(r2)
    await h.waitFor(() => req(h, r1).status === 'awaiting_acceptance' && req(h, r2).status === 'awaiting_acceptance', 'both awaiting', 90_000)
    await h.decide(`accept:${r1}`, '수락')
    await h.waitFor(() => h.store.approval(`merge:${r1}:p`)?.state === 'open', 'r1 merge card')
    assert.equal(await h.decide(`merge:${r1}:p`, '병합'), null)
    assert.equal(req(h, r1).status, 'merged')
    await h.decide(`accept:${r2}`, '수락')
    await h.waitFor(() => h.store.approval(`merge:${r2}:p`)?.state === 'open', 'r2 merge card')
    assert.match((await h.decide(`merge:${r2}:p`, '병합'))!, /새 커밋/)
    await h.waitFor(() => req(h, r2).status === 'blocked', 'r2 blocked')
    const m = h.store.mergeRow(r2, 'p')!
    assert.equal(m.state, 'conflict')
    assert.match(m.note!, /shared\.txt/)
    const card = h.store.approval(`integration:${r2}:p`)!
    assert.equal(card.state, 'open')
    assert.deepEqual(card.options, ['다시 통합', '해당 작업 재작업', '요청 중단'])
    const item = decisionItems(h.store, h.clock.t).find((d) => d.kind === 'integration')!
    assert.ok(item.optionHelp['다시 통합'] && item.optionHelp['요청 중단'])
  } finally { await h.close() }
})


test('known quota reset keeps interrupted work resumable even after earlier unknown-limit failures', async () => {
  const h = harness()
  try {
    const resets = Math.floor(h.clock.t / 1000) + 3600
    const id = h.plan([task('A', {brief:`[[FAKE:write=a/out.txt]] [[FAKE:rejectfirst]] [[FAKE:resets=${resets}]]`})])
    await h.approve(id)
    const tid = `${id}.A`
    h.store.updateTask(tid,{limited_streak:2})
    await h.waitFor(()=>tsk(h,tid).status==='held','scheduled quota hold remains resumable')
    assert.equal(tsk(h,tid).limited_streak,3)
    assert.equal(h.runner.quota().until,new Date(resets*1000).toISOString())
    h.clock.t=resets*1000+1000
    await h.waitFor(()=>['reviewing','passed'].includes(tsk(h,tid).status),'resumed at known reset')
    assert.equal(tsk(h,tid).attempts,1)
  } finally {await h.close()}
})
