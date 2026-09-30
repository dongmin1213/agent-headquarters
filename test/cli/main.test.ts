import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { main, parseArgs } from '../../src/cli/main.ts'
import { runCmd } from '../../src/cli/ctx.ts'
import { testCtx, tmp } from './helpers.ts'

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
