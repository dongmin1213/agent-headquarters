// ps may be unavailable (setuid exec is denied inside a sandbox): a launched worker must still be tracked,
// and liveness falls back to kill(pid, 0).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { killGroup, launch, pidAlive, readProcessInfo, sameProcessAlive } from '../../src/exec/worker.ts'
import { tmp } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

const throwingPs = (): Promise<string | null> => { throw new Error('spawn EPERM') }
const rejectingPs = (): Promise<string | null> => Promise.reject(new Error('spawn EPERM'))

async function launchSleep(ps: (pid: number) => Promise<string | null>) {
  const dir = tmp('hq-worker-')
  const home = join(dir, 'home'), wt = join(dir, 'wt'), hqDir = join(dir, 'run', 'hq')
  mkdirSync(wt, { recursive: true }); mkdirSync(join(dir, 'tok'), { recursive: true })
  const l = await launch({ claudeBin: '/bin/sleep', argv: ['30'], cwd: wt, hqDir, outDir: null, prompt: 'x', sessionId: 's1', spec: {},
    sandbox: { worktree: wt, out: null, hqHome: home, tokenDir: join(dir, 'tok'), hqPort: 17999, extraWritable: [], projects: [] } }, ps)
  return { l, hqDir }
}

for (const [name, ps] of [['throws synchronously', throwingPs], ['rejects', rejectingPs]] as const) {
  test(`launch: ps that ${name} → resolves with lstart null and the running worker is recorded`, async () => {
    const { l, hqDir } = await launchSleep(ps)
    try {
      assert.equal(l.info.lstart, null)
      assert.ok(l.info.pid > 0)
      assert.deepEqual(readProcessInfo(hqDir), l.info, 'process.json records the running worker')
      assert.equal(pidAlive(l.info.pid), true)
      assert.equal(await sameProcessAlive(l.info.pid, l.info.lstart, l.info.startedAt, ps), true)
    } finally { killGroup(l.info.pid, 'SIGKILL') }
  })
}

test('sameProcessAlive: ps failing falls back to kill(pid, 0) liveness; a dead pid is dead; a real lstart mismatch is not the same process', async () => {
  for (const ps of [throwingPs, rejectingPs, async () => null]) {
    assert.equal(await sameProcessAlive(process.pid, 'Mon Jan  1 00:00:00 2001', null, ps), true)
  }
  const c = spawn('/usr/bin/true')
  await new Promise((r) => c.on('exit', r))
  assert.equal(await sameProcessAlive(c.pid!, null, new Date().toISOString(), throwingPs), false)
  assert.equal(await sameProcessAlive(process.pid, 'A', null, async () => 'B'), false)
  assert.equal(await sameProcessAlive(process.pid, 'A', null, async () => 'A'), true)
})
