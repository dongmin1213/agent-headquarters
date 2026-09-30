// Judgement integrity (w2): setup/check changes to tracked files, integration without the base-failure exemption,
// mandatory judgement of manual criteria, one command rule, accept card facts, revise limits and CEO revise questions,
// object checks on fetches from worker clones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as ceo from '../../src/ceo.ts'
import { baseline, runChecks } from '../../src/exec/checks.ts'
import { decisionItems, hqDirOf, outDirOf } from '../../src/exec/decisions.ts'
import { integrate } from '../../src/exec/integration.ts'
import { ensureMirror, fetchWork, newWorkClone, verifyWorktree } from '../../src/exec/repos.ts'
import { checkVerdict } from '../../src/exec/review.ts'
import * as revise from '../../src/exec/revise.ts'
import type { SandboxOpts } from '../../src/exec/sandbox.ts'
import { commitFile, harness, makeRepo, req, sh, task, tmp, tsk, type Harness } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

async function repoEnv(files: Record<string, string>) {
  const dir = tmp('hq-judge-')
  const repo = makeRepo(join(dir, 'repo'), files)
  const base = sh(repo, 'rev-parse', 'HEAD')
  const home = join(dir, 'home')
  const mirror = await ensureMirror({ id: 'p', path: repo }, join(home, 'repos', 'p.git'))
  const sb = (wt: string): SandboxOpts => ({ worktree: wt, out: null, hqHome: home, tokenDir: join(dir, 'tok'), hqPort: 17998, extraWritable: [], projects: [repo] })
  return { dir, repo, base, home, mirror, sb }
}

const taskEvents = (h: Harness) => (h.store.raw().prepare("select text from events where kind = 'task' order by id").all() as { text: string }[]).map((r) => r.text)

// ----- F01 -----
test('F01. integration: setup rewriting a tracked file fails before any check (the merged commit would differ)', async () => {
  const e = await repoEnv({ 'README.md': '# t\n', 'value.txt': 'BROKEN\n' })
  const head = commitFile(e.repo, 'src/a.txt', 'x\n')
  await ensureMirror({ id: 'p', path: e.repo }, e.mirror)
  const path = join(e.home, 'worktrees', 'r', '_integration-p')
  const res = await integrate({ mirror: e.mirror, requestId: 'r', project: 'p', path, target: 'main', heads: [{ taskId: 'r.A', title: 'A', sha: head }],
    setup: "printf 'GOOD\\n' > value.txt", checks: [{ id: 'A.c', command: 'grep -qx GOOD value.txt' }], timeoutMs: 20_000, sandbox: e.sb(path), profilePath: join(e.dir, 'i.sb') })
  assert.equal(res.kind, 'failed', JSON.stringify(res))
  assert.match((res as { reason: string }).reason, /^setup이 추적 파일을 바꿨어요: value\.txt/)
})

test('F01. runChecks: a tracked change before the first check is a setup change; checks may create untracked files; a check changing tracked content fails', async () => {
  const e = await repoEnv({ 'README.md': '# t\n', 'value.txt': 'BROKEN\n' })
  const wt = await verifyWorktree(e.mirror, join(e.home, 'worktrees', 'r', 'v'), e.base)
  const run = (checks: { id: string; command: string }[]) => runChecks({ wt, base: e.base, head: e.base, checks, timeoutMs: 20_000, sandbox: e.sb(wt.path), profilePath: join(e.dir, 'c.sb') })
  const out = await run([{ id: 'build', command: 'mkdir -p dist' }, { id: 'out', command: 'touch dist/app.js' }, { id: 'ok', command: 'test -f dist/app.js' }])
  assert.equal(out.pass, true, JSON.stringify(out.checks.map((c) => [c.id, c.pass, c.outputTail])))
  const mut = await run([{ id: 'mut', command: "printf 'GOOD\\n' > value.txt" }])
  assert.equal(mut.checks[0].exitCode, 0)
  assert.equal(mut.checks[0].pass, false)
  assert.match(mut.checks[0].outputTail, /추적 파일.*value\.txt/)
  // value.txt is now GOOD in the worktree: the next run must refuse to start.
  const again = await run([{ id: 'ok', command: 'true' }])
  assert.equal(again.pass, false)
  assert.equal(again.setupChanged, true)
  assert.match(again.error ?? '', /^setup이 추적 파일을 바꿨어요: value\.txt/)
})

test('F01. baseline: setup rewriting a tracked file is an environment failure', async () => {
  const e = await repoEnv({ 'README.md': '# t\n', 'value.txt': 'BROKEN\n' })
  const b = await baseline({ mirror: e.mirror, base: e.base, path: join(e.home, 'worktrees', 'r', 'bl'), checks: [{ id: 'c', command: 'grep -qx GOOD value.txt' }],
    setup: "printf 'GOOD\\n' > value.txt", timeoutMs: 20_000, sandbox: e.sb, profilePath: join(e.dir, 'b.sb') })
  assert.equal(b.c.setupFailed, true)
  assert.match(b.c.tail, /setup이 추적 파일을 바꿨어요: value\.txt/)
})

test('F01. runner: setup that rewrites a tracked file blocks the task before the worker starts', async () => {
  const h = harness({ repoFiles: { 'README.md': '# t\n', 'value.txt': 'BROKEN\n' }, setup: "printf 'GOOD\\n' > value.txt" })
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'V', text: '값', check: 'grep -qx GOOD value.txt', kind: 'regression' }] })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked', 'blocked')
    assert.match(tsk(h, `${id}.A`).note ?? '', /setup이 추적 파일을 바꿨어요: value\.txt/)
    assert.ok(h.store.attempts(`${id}.A`).every((a) => a.pid === null), 'no worker launched')
  } finally { await h.close() }
})

test('F01. runner: setup that rewrites a tracked file only in the verification worktree blocks (not rework)', async () => {
  // a/out.txt exists only after the worker's commit, so the baseline and the worker clone setup leave value.txt alone.
  const h = harness({ repoFiles: { 'README.md': '# t\n', 'value.txt': 'BROKEN\n' }, setup: "if test -f a/out.txt; then printf 'GOOD\\n' > value.txt; fi" })
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'V', text: '파일', check: 'test -f a/out.txt', kind: 'new' }] })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked', 'blocked')
    const t = tsk(h, `${id}.A`)
    assert.match(t.note ?? '', /^setup이 추적 파일을 바꿨어요: value\.txt/)
    assert.equal(t.attempts, 1, 'no rework')
  } finally { await h.close() }
})

// ----- F02 -----
test('F02. integration: a base-failed regression check that fails on the integration commit fails the integration', async () => {
  const e = await repoEnv({ 'README.md': '# t\n' })
  const head = commitFile(e.repo, 'src/a.txt', 'x\n')
  await ensureMirror({ id: 'p', path: e.repo }, e.mirror)
  const path = join(e.home, 'worktrees', 'r', '_integration-p')
  const res = await integrate({ mirror: e.mirror, requestId: 'r', project: 'p', path, target: 'main', heads: [{ taskId: 'r.A', title: 'A', sha: head }],
    setup: null, checks: [{ id: 'A.R1', command: 'ls missing.txt', kind: 'regression', baseFailed: true }], timeoutMs: 20_000, sandbox: e.sb(path), profilePath: join(e.dir, 'i.sb') })
  assert.equal(res.kind, 'failed', JSON.stringify(res))
  const f = res as { reason: string; checks: { checks: { baseFailed?: boolean; pass: boolean }[]; pass: boolean } }
  assert.equal(f.reason, '기존 실패 검사 A.R1(ls missing.txt)가 통합본에서도 실패해요 · 작업 검토 뒤 대상 브랜치가 바뀌었을 수 있어 확인이 필요해요')
  assert.equal(f.checks.pass, false)
  assert.equal(f.checks.checks[0].baseFailed, undefined, 'no exemption mark in integration')
})

test('F02. task verification: a base-failed check exiting 127 / timing out on the candidate is a plain failure, not manual', async () => {
  const e = await repoEnv({ 'README.md': '# t\n' })
  const wt = await verifyWorktree(e.mirror, join(e.home, 'worktrees', 'r', 'v'), e.base)
  const r = await runChecks({ wt, base: e.base, head: e.base, timeoutMs: 800, sandbox: e.sb(wt.path), profilePath: join(e.dir, 'c.sb'),
    checks: [{ id: 'nf', command: 'hq-no-such-command-xyz', kind: 'regression', baseFailed: true }, { id: 'slow', command: 'sleep 5', kind: 'regression', baseFailed: true },
      { id: 'old', command: 'ls missing.txt', kind: 'regression', baseFailed: true }] })
  assert.equal(r.checks[0].exitCode, 127)
  assert.equal(r.checks[0].baseFailed, undefined)
  assert.equal(r.checks[1].baseFailed, undefined)
  assert.equal(r.checks[2].baseFailed, true, 'ordinary failure stays manual')
  assert.equal(r.pass, false)
})

const KNOWN = '기존 실패로 인정하고 진행'
const knownOffer = (h: Harness, id: string) => JSON.parse(h.store.get(`integration.known:${id}:p`) ?? 'null') as { sha: string } | null

test('F02. runner: a base-failed item passes task review but stops at the integration card; the chairman may accept it for that SHA', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'R1', text: '기존에 깨진 검사', check: 'ls missing.txt', kind: 'regression' }] })])
    await h.approve(id)
    await h.waitFor(() => h.store.approval(`integration:${id}:p`)?.state === 'open', 'integration card')
    assert.equal(tsk(h, `${id}.A`).status, 'passed')
    const m = h.store.mergeRow(id, 'p')!
    assert.equal(m.state, 'failed')
    assert.equal(m.note, '기존 실패 검사 A.R1(ls missing.txt)가 통합본에서도 실패해요 · 작업 검토 뒤 대상 브랜치가 바뀌었을 수 있어 확인이 필요해요')
    assert.deepEqual(JSON.parse(h.store.get(`integration.tasks:${id}:p`) ?? '[]'), [`${id}.A`])
    // Option present: the only failure is base-failed and the reviewer judged it pass.
    const card = h.store.approval(`integration:${id}:p`)!
    assert.ok(card.options.includes(KNOWN), JSON.stringify(card.options))
    const offer = knownOffer(h, id)!
    const item = decisionItems(h.store, h.clock.t).find((d) => d.id === card.id)!
    assert.equal(item.optionHelp[KNOWN], `이 검사들은 작업 전부터 실패했고 검토자가 악화 없음으로 판정했어요 · 통합본(${offer.sha.slice(0, 10)})을 그대로 병합 단계로 넘겨요`)
    // Choosing it: merge row carries the acknowledgment for that SHA; accept → merge card for the same SHA.
    await h.decide(card.id, KNOWN)
    const acked = h.store.mergeRow(id, 'p')!
    assert.equal(acked.state, 'integrated')
    assert.equal(acked.integration_sha, offer.sha)
    assert.deepEqual(JSON.parse(acked.known_failures!), { sha: offer.sha, items: [{ id: 'A.R1', command: 'ls missing.txt' }] })
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    await h.decide(`accept:${id}`, '수락')
    await h.waitFor(() => h.store.approval(`merge:${id}:p`)?.state === 'open', 'merge card')
    assert.equal(h.store.mergeRow(id, 'p')!.integration_sha, offer.sha)
    assert.match(h.store.approval(`merge:${id}:p`)!.body, /^회장이 인정한 기존 실패: \[A\.R1\] ls missing\.txt$/m)
    // The target moves: the merge re-integrates on a new SHA; the acknowledgment does not carry over and a new card asks again.
    const rev = h.store.approval(`integration:${id}:p`)!.revision
    commitFile(h.repo, 'other.txt', 'x\n', 'target moved')
    assert.match((await h.decide(`merge:${id}:p`, '병합')) ?? '', /./)
    await h.waitFor(() => h.store.approval(`integration:${id}:p`)!.revision > rev && h.store.approval(`integration:${id}:p`)!.state === 'open', 'new integration card')
    const again = h.store.mergeRow(id, 'p')!
    assert.equal(again.known_failures, null)
    const offer2 = knownOffer(h, id)!
    assert.notEqual(offer2.sha, offer.sha)
    assert.ok(h.store.approval(`integration:${id}:p`)!.options.includes(KNOWN))
  } finally { await h.close() }
})

test('F02. no 기존 실패 option when the reviewer did not judge the item pass', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'R1', text: '기존에 깨진 검사', check: 'ls missing.txt', kind: 'regression' }] })])
    await h.approve(id)
    await h.waitFor(() => h.store.approval(`integration:${id}:p`)?.state === 'open', 'integration card')
    // Doctor the stored verdict (a reviewer that left the item unjudged), then integrate again.
    const review = h.store.attempts(`${id}.A`).find((a) => a.kind === 'review' && a.outcome === 'pass')!
    const vpath = join(hqDirOf(review), 'verdict.json')
    const v = JSON.parse(readFileSync(vpath, 'utf8'))
    v.criteria = v.criteria.map((c: { id: string }) => (c.id === 'R1' ? { ...c, result: 'manual' } : c))
    writeFileSync(vpath, JSON.stringify(v))
    const rev = h.store.approval(`integration:${id}:p`)!.revision
    await h.decide(`integration:${id}:p`, '다시 통합')
    await h.waitFor(() => h.store.approval(`integration:${id}:p`)!.revision > rev && h.store.approval(`integration:${id}:p`)!.state === 'open', 'new card')
    assert.equal(h.store.approval(`integration:${id}:p`)!.options.includes(KNOWN), false)
    assert.equal(knownOffer(h, id), null)
  } finally { await h.close() }
})

test('F02. integrate(): a failing check that is not base-failed means no acknowledgment offer', async () => {
  const e = await repoEnv({ 'README.md': '# t\n' })
  const head = commitFile(e.repo, 'src/a.txt', 'x\n')
  await ensureMirror({ id: 'p', path: e.repo }, e.mirror)
  const path = join(e.home, 'worktrees', 'r', '_integration-p')
  const res = await integrate({ mirror: e.mirror, requestId: 'r', project: 'p', path, target: 'main', heads: [{ taskId: 'r.A', title: 'A', sha: head }], setup: null,
    checks: [{ id: 'A.R1', command: 'ls missing.txt', kind: 'regression', baseFailed: true }, { id: 'A.N', command: 'ls nope.txt', kind: 'regression' }],
    timeoutMs: 20_000, sandbox: e.sb(path), profilePath: join(e.dir, 'i.sb') })
  assert.equal(res.kind, 'failed')
  assert.equal((res as { known?: unknown }).known, undefined)
  assert.match((res as { reason: string }).reason, /통합 검사 실패: A\.N/)
})

// ----- F03 -----
const JUDGE_ADDED = '사람 확인이 필요한 기준이 있어 검토를 추가해요 · sonnet'

test('F03. explicit manual criterion + review none → a sonnet review is added', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { review: { brief: '', model: 'none' }, acceptance: [
      { id: 'A1', text: 'README 유지', check: 'test -f README.md', kind: 'regression' }, { id: 'M1', text: '문구가 자연스러움', check: 'manual', kind: 'new' }] })])
    await h.approve(id)
    await h.waitFor(() => taskEvents(h).includes(JUDGE_ADDED), 'review added')
    await h.waitFor(() => h.store.attempts(`${id}.A`).some((a) => a.kind === 'review'), 'review attempt')
    assert.equal(tsk(h, `${id}.A`).review_model, 'sonnet')
    assert.equal(h.store.attempts(`${id}.A`).find((a) => a.kind === 'review')!.model, 'sonnet')
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const body = h.store.approval(`accept:${id}`)!.body
    assert.match(body, /검토자 판정: \[M1\] pass — checked/)
    assert.doesNotMatch(body, /검토자 판정: \[A1\]/)
  } finally { await h.close() }
})

test('F03. reviewer answering manual on a handed item → invalid → one retry → blocked', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:write=a/out.txt]] [[FAKE:review=manualall]]', acceptance: [
      { id: 'A1', text: 'README 유지', check: 'test -f README.md', kind: 'regression' }, { id: 'M1', text: '문구', check: 'manual', kind: 'new' }] })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked', 'blocked')
    const reviews = h.store.attempts(`${id}.A`).filter((a) => a.kind === 'review')
    assert.equal(reviews.length, 2)
    assert.ok(reviews.every((a) => a.status === 'unverifiable' && /M1/.test(a.reason ?? '')), JSON.stringify(reviews.map((a) => a.reason)))
    assert.match(tsk(h, `${id}.A`).note ?? '', /검토가 2번 무효였어요/)
  } finally { await h.close() }
})

test('F03. checkVerdict: items to judge must be pass or fail', () => {
  const runs = [{ command: 'npm test', exitCode: 0 }]
  const v = (m: string) => ({ pass: true, blocking: [], advisory: [], criteria: [{ id: 'A1', result: 'manual', evidence: 'e' }, { id: 'M1', result: m, evidence: 'e' }],
    tests_run: [{ command: 'npm test', exit_code: 0, summary: '' }] })
  const o = { acceptanceIds: ['A1', 'M1'], codeChanged: true, bashRuns: runs, judgeIds: ['M1'] }
  assert.equal(checkVerdict(v('pass'), o).kind, 'pass', 'A1 is not handed over: manual is allowed there')
  const bad = checkVerdict(v('manual'), o)
  assert.equal(bad.kind, 'invalid')
  assert.match((bad as { reason: string }).reason, /M1/)
})

// ----- F2 -----
test('F2. one command rule on raw strings, shared by plan checks and tests_run', () => {
  const bad = ['npm test\nexit 0', 'npm test\r\nexit 0', 'npm test; true', 'npm test | tee x', 'npm test || true', 'npm test && echo ok', 'npm test & wait',
    'npm test &', 'echo `id`', 'echo $(id)', 'exit 0', 'npm test || exit 0', 'npm test :', 'npm test true', 'true']
  for (const c of bad) assert.notEqual(ceo.unsafeCommand(c), null, JSON.stringify(c))
  for (const c of ['npm test', 'node --test test/a.test.ts', 'npx tsc --noEmit 2>&1', 'grep -qx GOOD value.txt']) assert.equal(ceo.unsafeCommand(c), null, c)
  const runs = [{ command: 'npm test\nexit 0', exitCode: 0 }, { command: 'npm test & wait', exitCode: 0 }]
  for (const c of ['npm test\nexit 0', 'npm test & wait']) {
    const r = checkVerdict({ pass: true, blocking: [], advisory: [], criteria: [{ id: 'A1', result: 'pass', evidence: 'e' }], tests_run: [{ command: c, exit_code: 0, summary: '' }] },
      { acceptanceIds: ['A1'], codeChanged: true, bashRuns: runs })
    assert.equal(r.kind, 'invalid', c)
  }
  const projects = [{ id: 'p', name: 'P', path: '/tmp' }]
  for (const c of ['npm test\nexit 0', 'npm test & wait', 'npm test; exit 0'])
    assert.match(ceo.validateTasks([task('A', { acceptance: [{ id: 'A1', text: 't', check: c, kind: 'regression' }] })], projects) ?? '', /명령 하나여야 합니다/, c)
  // N6: quoting does not help (kept conservative); the rejection says how to get such arguments through.
  const quoted = ceo.validateTasks([task('A', { acceptance: [{ id: 'A1', text: 't', check: "grep -E 'a|b' x.txt", kind: 'regression' }] })], projects) ?? ''
  assert.match(quoted, /명령 하나여야 합니다 \(\| 사용 금지\)/)
  assert.ok(quoted.endsWith(' · 인자에 | ; & 같은 문자가 필요하면 스크립트 파일로 감싸 한 명령으로 실행하게 해 주세요'), quoted)
  assert.equal(ceo.validateTasks([task('A', { acceptance: [{ id: 'A1', text: 't', check: 'manual', kind: 'new' }] })], projects), null)
})

// ----- F3 -----
test('F3. accept card: worker summary is labelled as the worker report; file count comes from the mirror diff', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:write=a/one.txt]] [[FAKE:write=a/two.txt]]' })])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const body = h.store.approval(`accept:${id}`)!.body
    assert.match(body, /— 작업자 보고: 가짜 작업 succeeded/)
    assert.match(body, /변경 파일 2개/)
    // The worker-written done.json is not a source of facts: a doctored list does not change the count.
    const work = h.store.attempts(`${id}.A`).find((a) => a.kind === 'work' && a.status === 'succeeded')!
    writeFileSync(join(outDirOf(work), 'done.json'), JSON.stringify({ summary: '가짜', files_modified: ['1', '2', '3', '4', '5'] }))
    ;(h.runner as unknown as { putAcceptCard(id: string): void }).putAcceptCard(id)
    assert.match(h.store.approval(`accept:${id}`)!.body, /변경 파일 2개/)
  } finally { await h.close() }
})

// ----- F10 -----
test('F10. revise cannot change id, project or role', async () => {
  const t = task('A')
  assert.equal(revise.reviseProblem(t, { ...t, brief: 'x' }), null)
  for (const rev of [{ ...t, role: 'collect' as const }, { ...t, project: 'q' }, { ...t, id: 'B' }]) assert.equal(revise.reviseProblem(t, rev), '지시서 수정으로 프로젝트·역할은 바꿀 수 없어요')
  assert.match(revise.reviseDiff(t, { ...t, owns: ['x/**'] }), /프로젝트: p/)
  assert.match(revise.reviseDiff(t, { ...t, owns: ['x/**'] }), /역할: implement/)
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:outcome=blocked]] [[FAKE:revise=role]]' })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked', 'blocked')
    assert.match(tsk(h, `${id}.A`).note ?? '', /지시서 수정으로 프로젝트·역할은 바꿀 수 없어요/)
    assert.equal(h.store.approval(`revise:${id}.A`), null, 'no revise card')
    assert.equal(JSON.parse(tsk(h, `${id}.A`).spec).role, 'implement')
    // The approval path refuses too (defence in depth).
    h.store.updateTask(`${id}.A`, { status: 'revising' })
    h.store.tx(() => h.runner.applyRevision(`${id}.A`, { ...task('A'), role: 'collect' }))
    assert.equal(tsk(h, `${id}.A`).status, 'blocked')
    assert.equal(tsk(h, `${id}.A`).role, 'implement')
  } finally { await h.close() }
})

// ----- F16 -----
test('F16. revise questions become task questions; answering re-runs the revise turn with the answers', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:outcome=blocked]] [[FAKE:revise=question]]' })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => tsk(h, tid).status === 'question', 'question')
    const qs = h.store.taskQuestions(tid).filter((q) => q.answer === null)
    assert.equal(qs.length, 1)
    assert.equal(qs[0].question, '어느 쪽?')
    const item = decisionItems(h.store, h.clock.t).find((d) => d.id === qs[0].id)!
    assert.equal(item.kind, 'worker_question')
    assert.equal(item.label, '사장 질문')
    assert.match(item.situation, /사장이/)
    assert.equal(h.runner.answerTask(tid, qs[0].id, 'B', tsk(h, tid).revision), null)
    assert.equal(tsk(h, tid).status, 'revising')
    await h.waitFor(() => tsk(h, tid).revision === 1, 'revision applied')
    assert.match(JSON.parse(tsk(h, tid).spec).brief, /답 반영: - 어느 쪽\? → B/)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
  } finally { await h.close() }
})

// ----- S6 -----
test('S6. fetching a worker clone checks objects: a tree entry named .git is refused with a Korean reason', async () => {
  const e = await repoEnv({ 'README.md': '# t\n' })
  const clone = join(e.dir, 'work')
  await newWorkClone(e.mirror, clone, e.base)
  const g = (...a: string[]) => sh(clone, '-c', 'user.name=x', '-c', 'user.email=x@example.com', ...a)
  const gi = (input: string, ...a: string[]) => execFileSync('git', a, { cwd: clone, input, encoding: 'utf8' }).trim()
  const blob = gi('evil\n', 'hash-object', '-w', '--stdin')
  const tree = gi(`100644 blob ${blob}\t.git\n`, 'mktree')
  g('update-ref', 'refs/heads/hq-work', g('commit-tree', tree, '-p', 'HEAD', '-m', 'evil'))
  const r = await fetchWork(e.mirror, clone, 'refs/hq/r/A/a1') as unknown as { sha: string | null; error: string | null }
  assert.equal(r?.sha, null, JSON.stringify(r))
  assert.match(r.error ?? '', /git 객체 검사/)
  assert.match(r.error ?? '', /hasDotgit|\.git/)
})

test('S6. runner: a worker commit with a .git tree entry makes the attempt failed with the object check reason', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:write=a/out.txt]] [[FAKE:evilgit]]' })])
    await h.approve(id)
    await h.waitFor(() => h.store.attempts(`${id}.A`).some((a) => a.kind === 'work' && a.status === 'failed'), 'failed attempt')
    const a = h.store.attempts(`${id}.A`).find((x) => x.kind === 'work' && x.status === 'failed')!
    assert.match(a.reason ?? '', /git 객체 검사/)
    assert.ok(hqDirOf(a))
  } finally { await h.close() }
})
