// Opt-in: real CEO → worker → reviewer → checked fast-forward merge, entirely in a disposable repository.
// The approval decisions below belong only to this synthetic test request, never to the user's daemon.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { harness, req, sh } from './helpers.ts'
import { NESTED_SKIP, nestedSandbox } from '../nested.ts'

const check = `import assert from 'node:assert/strict';
import { sum } from './sum.mjs';
assert.equal(sum(1, 2), 3);
assert.equal(sum(-3, 1), -2);
assert.equal(sum(0, 0), 0);
console.log('SUM-OK');
`

test('live Codex: CEO plan → implementation → independent review → acceptance → merge', {
  skip: (nestedSandbox && NESTED_SKIP) || (!process.env.HQ_LIVE_FLOW && 'HQ_LIVE_FLOW=1 uses ChatGPT for a full disposable request'),
  timeout: 360_000,
}, async (t) => {
  const h = harness({ cfg: { codexBin: process.env.HQ_CODEX_BIN ?? 'codex', maxAttempts: 1 }, repoFiles: {
    'README.md': '# Disposable Codex migration test\n',
    'sum.mjs': 'export function sum(a, b) { throw new Error("not implemented"); }\n',
    'check.mjs': check,
  } })
  t.diagnostic(`disposable evidence: ${h.dir}`)
  try {
    const id = h.engine.submit('테스트 저장소에서 sum.mjs의 sum(a,b)를 숫자 덧셈으로 구현하세요. '
      + 'check.mjs는 이미 존재하고 수정 금지입니다. 질문 없이 작업 하나의 계획을 만드세요. '
      + 'project=p, role=implement, grade=L1, model=sonnet, owns=["sum.mjs"], review.model=sonnet. '
      + '수용 기준은 kind=new, check="node check.mjs" 하나이며 통과해야 합니다. README 및 다른 파일 수정 금지.', 'p')
    await h.waitFor(() => !['queued', 'thinking'].includes(req(h, id).status), 'CEO plan', 120_000)
    assert.equal(req(h, id).status, 'planned', req(h, id).note ?? req(h, id).status)
    assert.match(req(h, id).session_id ?? '', /^codex:/)
    const plan = JSON.parse(req(h, id).plan!)
    assert.equal(plan.tasks.length, 1)
    assert.equal(plan.tasks[0].review?.model, 'sonnet')
    assert.deepEqual(plan.tasks[0].owns, ['sum.mjs'])
    t.diagnostic('CEO plan verified')
    assert.equal(await h.approve(id), null)
    await h.waitFor(() => ['awaiting_acceptance', 'blocked', 'failed'].includes(req(h, id).status), 'work and review', 200_000)
    assert.equal(req(h, id).status, 'awaiting_acceptance', JSON.stringify(h.store.tasks(id).map(x => ({ status: x.status, note: x.note }))))
    const task = h.store.tasks(id)[0]
    const attempts = h.store.attempts(task.id)
    for (const kind of ['work', 'review']) {
      const attempt = attempts.find(a => a.kind === kind && a.status === 'succeeded')
      assert.ok(attempt, JSON.stringify(attempts.map(a => ({ kind: a.kind, status: a.status, reason: a.reason }))))
      assert.match(attempt.session_id, /^codex:/)
    }
    assert.equal(readFileSync(join(h.repo, 'check.mjs'), 'utf8'), check)
    t.diagnostic('worker, checks, and independent review passed')
    assert.equal(await h.decide(`accept:${id}`, '수락'), null)
    await h.waitFor(() => h.store.approval(`merge:${id}:p`)?.state === 'open', 'merge card')
    assert.equal(await h.decide(`merge:${id}:p`, '병합'), null)
    assert.equal(req(h, id).status, 'merged')
    assert.equal(sh(h.repo, 'rev-parse', 'HEAD'), h.store.mergeRow(id, 'p')!.integration_sha)
    assert.equal(readFileSync(join(h.repo, 'check.mjs'), 'utf8'), check)
    assert.equal(sh(h.repo, 'diff', '--name-only', 'HEAD~1', 'HEAD'), 'sum.mjs')
    t.diagnostic('checked fast-forward merge completed')
  } finally {
    await h.close()
    // Always remove authentication; retain only non-secret test evidence on failure.
    rmSync(join(h.cfg.home, 'codex'), { recursive: true, force: true })
    rmSync(join(h.dir, 'home/codex'), { recursive: true, force: true })
  }
})
