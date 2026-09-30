// Worker clones carry the project repo's commit identity (execution.md §6.1: hq reads the project config, sets it in the fresh clone).
// HOME/XDG point at an empty temp dir before anything is imported, so no global git identity can leak in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(realpathSync(tmpdir()), 'hq-idhome-'))
process.env.HOME = fakeHome
process.env.XDG_CONFIG_HOME = join(fakeHome, '.config')
delete process.env.GIT_CONFIG_GLOBAL
const { harness, sh, task, tsk } = await import('./helpers.ts')

const cloneConfig = (clone: string, key: string): string | null => {
  try { return execFileSync('git', ['--git-dir', join(clone, '.git'), 'config', '--get', key], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim() } catch { return null }
}

async function cloneOf(o: { email?: string; name?: string }): Promise<{ email: string | null; name: string | null }> {
  const h = harness()
  try {
    sh(h.repo, 'config', '--unset', 'user.email'); sh(h.repo, 'config', '--unset', 'user.name')
    if (o.email) sh(h.repo, 'config', 'user.email', o.email)
    if (o.name) sh(h.repo, 'config', 'user.name', o.name)
    const id = h.plan([task('A')])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).worktree !== null, 'worker clone')
    const clone = tsk(h, `${id}.A`).worktree!
    const r = { email: cloneConfig(clone, 'user.email'), name: cloneConfig(clone, 'user.name') }
    assert.equal(h.runner.cancelRequest(id), null)
    return r
  } finally { await h.close() }
}

test('T7. the worker clone gets the project repo identity', async () => {
  assert.deepEqual(await cloneOf({ email: 'a@example.com', name: 'Project Person' }), { email: 'a@example.com', name: 'Project Person' })
})

test('T7b. no project identity and no global config → the clone has none set', async () => {
  assert.deepEqual(await cloneOf({}), { email: null, name: null })
})
