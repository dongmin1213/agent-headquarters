import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { harness, req, sh, tsk, task } from './helpers.ts'

test('6. full success: approve → work → checks → review pass → integration → accept → merge (--ff-only)', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A')])
    assert.equal(await h.approve(id), null)
    assert.equal(req(h, id).status, 'executing')
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const t = tsk(h, `${id}.A`)
    assert.equal(t.status, 'passed')
    assert.equal(t.attempts, 1)
    const m = h.store.mergeRow(id, 'p')!
    assert.equal(m.state, 'integrated')
    assert.equal(await h.decide(`accept:${id}`, '수락'), null)
    assert.equal(req(h, id).status, 'accepted')
    assert.ok(h.store.approval(`merge:${id}:p`)?.state === 'open')
    assert.equal(await h.decide(`merge:${id}:p`, '병합'), null)
    assert.equal(req(h, id).status, 'merged')
    assert.equal(sh(h.repo, 'rev-parse', 'HEAD'), h.store.mergeRow(id, 'p')!.integration_sha)
    assert.ok(existsSync(`${h.repo}/a/out.txt`))
    assert.equal(existsSync(t.worktree!), false, 'worktree cleaned')
    assert.equal(sh(h.repo, 'branch', '--list', t.branch!), '', 'branch deleted')
  } finally { h.close() }
})
