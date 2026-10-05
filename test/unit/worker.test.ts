// ps may be unavailable (setuid exec is denied inside a sandbox): a launched worker must still be tracked,
// but its identity is then `unknown` (never treated as ours from liveness alone).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { identify, killGroup, launch, pidAlive, readProcessInfo } from '../../src/exec/worker.ts'
import { tmp } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

const throwingPs = (): Promise<string | null> => { throw new Error('spawn EPERM') }
const rejectingPs = (): Promise<string | null> => Promise.reject(new Error('spawn EPERM'))

async function launchSleep(ps: (pid: number) => Promise<string | null>) {
  const dir = tmp('hq-worker-')
  const home = join(dir, 'home'), wt = join(dir, 'wt'), hqDir = join(dir, 'run', 'hq')
  mkdirSync(wt, { recursive: true }); mkdirSync(join(dir, 'tok'), { recursive: true })
  const l = await launch({ codexBin: '/bin/sleep', argv: ['30'], cwd: wt, hqDir, outDir: null, prompt: 'x', sessionId: 's1', spec: {},
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
      assert.equal(await identify(l.info.pid, l.info.lstart, ps), 'unknown', 'alive but unconfirmable')
    } finally { killGroup(l.info.pid, 'SIGKILL') }
  })
}

test('identify: ps failing → unknown (no liveness fallback); a dead pid is gone; lstart mismatch is other; match is same', async () => {
  for (const ps of [throwingPs, rejectingPs, async () => null]) {
    assert.equal(await identify(process.pid, 'Mon Jan  1 00:00:00 2001', ps), 'unknown')
  }
  const c = spawn('/usr/bin/true')
  await new Promise((r) => c.on('exit', r))
  assert.equal(await identify(c.pid!, 'A', throwingPs), 'gone')
  assert.equal(await identify(process.pid, 'A', async () => 'B'), 'other')
  assert.equal(await identify(process.pid, 'A', async () => 'A'), 'same')
  assert.equal(await identify(process.pid, null, async () => 'A'), 'unknown', 'no recorded start time')
})
