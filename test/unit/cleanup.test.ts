import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeRequestScratch, removeRequestCodexHomes } from '../../src/exec/cleanup.ts'
import { sha256 } from '../../src/exec/fsx.ts'
import { harness, sh, task, tmp } from './helpers.ts'

test('finished-request sweep removes legacy registered worktrees and empty parents, preserving the project and active work', async () => {
  const h = harness()
  try {
    const id = h.plan([]), active = h.plan([])
    h.store.updateRequest(id, { status: 'cancelled' })
    h.store.set(`cleaned:${id}`, 'legacy marker')
    const legacy = join(h.runner.home, 'worktrees', id, 'legacy')
    mkdirSync(join(legacy, '..'), { recursive: true })
    sh(h.repo, 'worktree', 'add', '--detach', legacy, 'HEAD')
    const scratch = join(h.runner.home, 'work', id, 'A')
    const keep = join(h.runner.home, 'work', active, 'A')
    for (const p of [scratch, keep]) { mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'draft.txt'), 'draft') }
    await h.runner.reconcile()
    assert.equal(existsSync(join(h.runner.home, 'work', id)), false)
    assert.equal(existsSync(join(h.runner.home, 'worktrees', id)), false)
    assert.ok(!sh(h.repo, 'worktree', 'list', '--porcelain').includes(legacy))
    assert.equal(readFileSync(join(h.repo, 'README.md'), 'utf8'), '# test\n')
    assert.equal(readFileSync(join(keep, 'draft.txt'), 'utf8'), 'draft')
  } finally { await h.close(); rmSync(h.dir, { recursive: true, force: true }) }
})

test('request-owned Codex environments and evidence expire after 30 days, shared environments and failure recovery stay', async () => {
  const h = harness()
  try {
    const id = h.plan([]), failed = h.plan([])
    h.store.updateRequest(id, { status: 'merged' })
    h.store.updateRequest(failed, { status: 'failed' })
    const scratch = join(h.runner.home, 'work', id, 'A')
    const failedScratch = join(h.runner.home, 'work', failed, 'A')
    const logs = join(h.runner.home, 'runs', id)
    const own = join(h.runner.home, 'codex', sha256(scratch))
    const coordinator = join(h.runner.home, 'codex', sha256(`coordinator:${scratch}`))
    const shared = join(h.runner.home, 'codex', sha256(`coordinator:${h.repo}`))
    for (const p of [scratch, failedScratch, logs, own, coordinator, shared]) {
      mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'keep.txt'), 'evidence')
    }
    await h.runner.reconcile()
    assert.ok(!existsSync(scratch))
    for (const p of [logs, own, coordinator, shared, failedScratch]) assert.ok(existsSync(p), p)
    h.clock.t += 31 * 24 * 60 * 60_000
    await h.runner.reconcile()
    for (const p of [logs, own, coordinator]) assert.ok(!existsSync(p), p)
    for (const p of [shared, failedScratch]) assert.ok(existsSync(p), p)
  } finally { await h.close(); rmSync(h.dir, { recursive: true, force: true }) }
})

test('cancelled request cleanup waits for lingering children and uncertain process identity', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A')]), tid = `${id}.A`
    h.store.updateRequest(id, { status: 'cancelled' })
    h.store.insertTask({ id: tid, request_id: id, key: 'A', project: 'p', title: 'A', role: 'implement', grade: 'L1', model: 'sonnet', review_model: 'sonnet', spec: JSON.stringify(task('A')), status: 'cancelled', branch: null, base_sha: null })
    h.store.insertAttempt({ id: `${tid}~a1`, task_id: tid, kind: 'work', n: 1, model: 'sonnet', status: 'failed', attempt_token: 'fixture', dir: join(h.runner.home, 'runs', id, 'A'), session_id: 'fixture' })
    h.store.updateAttempt(`${tid}~a1`, { pid: 999999, lstart: 'original' })
    const scratch = join(h.runner.home, 'work', id, 'A')
    mkdirSync(scratch, { recursive: true })
    h.runner.probe.lstart = async () => null
    h.runner.probe.members = async () => [999998]
    await h.runner.reconcile()
    assert.ok(existsSync(scratch), 'child remains after group leader exit')
    h.runner.probe.members = async () => null
    await h.runner.reconcile()
    assert.ok(existsSync(scratch), 'unknown group must not be deleted')
    h.runner.probe.members = async () => []
    await h.runner.reconcile()
    assert.ok(!existsSync(scratch), 'cleanup retries after the whole group exits')
  } finally { await h.close(); rmSync(h.dir, { recursive: true, force: true }) }
})

test('cleanup refuses substituted parents and unsafe identifiers', async () => {
  const home = tmp(), outside = tmp()
  try {
    mkdirSync(join(outside, 'req-safe')); writeFileSync(join(outside, 'req-safe', 'user.txt'), 'keep')
    symlinkSync(outside, join(home, 'work'))
    await assert.rejects(removeRequestScratch(home, 'req-safe', []), /Unsafe/)
    await assert.rejects(removeRequestScratch(home, '../escape', []), /Invalid/)
    symlinkSync(outside, join(home, 'codex'))
    assert.throws(() => removeRequestCodexHomes(home, [sha256('x')]), /Unsafe/)
    assert.equal(readFileSync(join(outside, 'req-safe', 'user.txt'), 'utf8'), 'keep')
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})
