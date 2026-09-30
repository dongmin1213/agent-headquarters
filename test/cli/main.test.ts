import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { main, parseArgs } from '../../src/cli/main.ts'
import { runCmd } from '../../src/cli/ctx.ts'
import { freePort, testCtx, tmp } from './helpers.ts'

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['projects', 'add', '/x', '--id', 'a', '--name=B']), { pos: ['projects', 'add', '/x'], flags: new Map([['--id', 'a'], ['--name', 'B']]) })
  assert.equal(typeof parseArgs(['projects', 'add', '--id']), 'string')
})

test('usage errors exit 2', async () => {
  for (const argv of [['nope'], ['doctor', '--bogus'], ['projects', 'add'], ['projects', 'frob'], ['status', 'extra'], ['logs', '-n', 'x']]) {
    const ctx = testCtx()
    assert.equal(await main(argv, ctx), 2, argv.join(' '))
    assert.match(ctx.errors[0], /사용법 오류/)
  }
})

test('help and version exit 0', async () => {
  const ctx = testCtx()
  assert.equal(await main(['help'], ctx), 0)
  assert.match(ctx.text(), /hq doctor|doctor \[--json\]/)
  assert.equal(await main([], ctx), 0)
})

test('bin/hq shim resolves through a symlink', async () => {
  const repo = resolve(import.meta.dirname, '../..')
  const dir = tmp(); mkdirSync(join(dir, 'b'))
  symlinkSync(join(repo, 'bin/hq'), join(dir, 'b', 'hq'))
  const r = await runCmd(join(dir, 'b', 'hq'), ['version'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^hq /)
  const u = await runCmd(join(dir, 'b', 'hq'), ['nonsense'])
  assert.equal(u.code, 2)
})

test('partial HQ_* overrides: every write/delete/signal command refuses before doing anything; status still runs', async () => {
  const msg = '다른 설치를 다루려면 HQ_HOME·HQ_PORT·HQ_TOKEN_FILE·HQ_LAUNCH_AGENTS_DIR를 모두 지정해 주세요'
  const port = await freePort()
  const writes = [['install'], ['uninstall', '--purge', '--yes'], ['start'], ['stop'], ['restart'], ['projects', 'add', '/tmp'], ['projects', 'remove', 'x']]
  for (const missing of ['HQ_HOME', 'HQ_PORT', 'HQ_TOKEN_FILE', 'HQ_LAUNCH_AGENTS_DIR']) {
    for (const argv of writes) {
      const calls: string[] = []
      const ctx = testCtx({ port, dryRun: false, run: async (cmd, args) => { calls.push(cmd); return { code: 113, stdout: '', stderr: '' } } })
      delete ctx.env[missing]
      assert.equal(await main(argv, ctx), 2, `${missing} ${argv.join(' ')}`)
      assert.deepEqual(ctx.errors, [msg])
      assert.deepEqual(ctx.lines, [])
      assert.deepEqual(calls, [], 'nothing run')
      assert.equal(existsSync(ctx.home), false)
      assert.equal(existsSync(join(ctx.root, 'config/projects.json')), false)
    }
  }
  const ro = testCtx({ port }); delete ro.env.HQ_TOKEN_FILE
  assert.equal(await main(['status'], ro), 1) // down, but not refused
  assert.doesNotMatch(ro.text(), /모두 지정해 주세요/)
  const none = testCtx({ port }); for (const k of ['HQ_HOME', 'HQ_PORT', 'HQ_TOKEN_FILE', 'HQ_LAUNCH_AGENTS_DIR']) delete none.env[k]
  assert.equal(await main(['projects', 'remove', 'x'], none), 1, 'no overrides at all is the default installation: allowed')
  assert.doesNotMatch(none.text(), /모두 지정해 주세요/)
})
