import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCmd } from '../../src/cli/ctx.ts'
import { projectsAdd, projectsList, projectsRemove, slugify } from '../../src/cli/projects.ts'
import { testCtx } from './helpers.ts'

const read = (ctx: { root: string }) => JSON.parse(readFileSync(join(ctx.root, 'config/projects.json'), 'utf8'))

test('add creates projects.json from scratch, stores ~ path, derives id and name', async () => {
  const ctx = testCtx()
  const dir = join(ctx.userHome, 'code', 'My App'); mkdirSync(dir, { recursive: true })
  assert.equal(existsSync(join(ctx.root, 'config/projects.json')), false)
  assert.equal(await projectsAdd(ctx, dir, {}), 0)
  assert.deepEqual(read(ctx), [{ id: 'my-app', name: 'My App', path: '~/code/My App' }])
  assert.match(ctx.text(), /git 저장소가 아닙니다/)
  // atomic write leaves no temp files
  assert.deepEqual(readdirSync(join(ctx.root, 'config')), ['projects.json'])
})

test('add accepts ~ input, --id/--name, no git warning for a real repo', async () => {
  const ctx = testCtx({ run: runCmd })
  const dir = join(ctx.userHome, 'repo1'); mkdirSync(dir)
  assert.equal((await runCmd('git', ['init', '-q', dir])).code, 0)
  assert.equal(await projectsAdd(ctx, '~/repo1', { id: 'r-1', name: '저장소' }), 0)
  assert.deepEqual(read(ctx), [{ id: 'r-1', name: '저장소', path: '~/repo1' }])
  assert.doesNotMatch(ctx.text(), /git 저장소가 아닙니다/)
})

test('paths outside home stay absolute', async () => {
  const ctx = testCtx()
  const dir = join(ctx.root, 'outside'); mkdirSync(dir)
  assert.equal(await projectsAdd(ctx, dir, { id: 'out' }), 0)
  assert.equal(read(ctx)[0].path, dir)
})

test('validation: missing path, bad id, duplicate id, duplicate path', async () => {
  const ctx = testCtx()
  const dir = join(ctx.userHome, 'a'); mkdirSync(dir)
  assert.equal(await projectsAdd(ctx, join(ctx.userHome, 'nope'), {}), 1)
  assert.match(ctx.errors.at(-1)!, /폴더가 없습니다/)
  assert.equal(await projectsAdd(ctx, dir, { id: 'Bad_ID' }), 1)
  assert.match(ctx.errors.at(-1)!, /\[a-z0-9-\]\+/)
  assert.equal(await projectsAdd(ctx, dir, { id: 'a' }), 0)
  const dir2 = join(ctx.userHome, 'b'); mkdirSync(dir2)
  assert.equal(await projectsAdd(ctx, dir2, { id: 'a' }), 1)
  assert.match(ctx.errors.at(-1)!, /이미 있는 id/)
  assert.equal(await projectsAdd(ctx, dir, { id: 'other' }), 1)
  assert.match(ctx.errors.at(-1)!, /이미 등록된 경로/)
  assert.equal(read(ctx).length, 1)
})

test('remove and list', async () => {
  const ctx = testCtx()
  for (const n of ['x', 'y']) { mkdirSync(join(ctx.userHome, n)); assert.equal(await projectsAdd(ctx, join(ctx.userHome, n), {}), 0) }
  assert.equal(await projectsRemove(ctx, 'zzz'), 1)
  assert.equal(await projectsRemove(ctx, 'x'), 0)
  assert.deepEqual(read(ctx).map((p: { id: string }) => p.id), ['y'])
  ctx.lines.length = 0
  assert.equal(await projectsList(ctx), 0)
  assert.match(ctx.lines[0], /^y\ty\t~\/y/)
})

test('malformed projects.json is reported, not overwritten', async () => {
  const ctx = testCtx()
  writeFileSync(join(ctx.root, 'config/projects.json'), '{"not":"array"}')
  mkdirSync(join(ctx.userHome, 'p'))
  assert.equal(await projectsAdd(ctx, join(ctx.userHome, 'p'), {}), 1)
  assert.equal(readFileSync(join(ctx.root, 'config/projects.json'), 'utf8'), '{"not":"array"}')
})

test('slugify', () => {
  assert.equal(slugify('My Cool_App!!'), 'my-cool-app')
  assert.equal(slugify('한글'), '')
})

test('add --setup stores the command and list shows it', async () => {
  const ctx = testCtx()
  mkdirSync(join(ctx.userHome, 'web'))
  assert.equal(await projectsAdd(ctx, join(ctx.userHome, 'web'), { setup: 'npm ci --prefer-offline' }), 0)
  assert.deepEqual(read(ctx), [{ id: 'web', name: 'web', path: '~/web', setup: 'npm ci --prefer-offline' }])
  ctx.lines.length = 0
  assert.equal(await projectsList(ctx), 0)
  assert.ok(ctx.lines.includes('\tsetup: npm ci --prefer-offline'), ctx.text())
  mkdirSync(join(ctx.userHome, 'w2'))
  assert.equal(await projectsAdd(ctx, join(ctx.userHome, 'w2'), { setup: '  ' }), 1)
})

test('cli: projects add --setup via main()', async () => {
  const { main } = await import('../../src/cli/main.ts')
  const ctx = testCtx()
  mkdirSync(join(ctx.userHome, 'svc'))
  assert.equal(await main(['projects', 'add', join(ctx.userHome, 'svc'), '--setup', 'pnpm i --frozen-lockfile'], ctx), 0, ctx.text())
  assert.equal(read(ctx)[0].setup, 'pnpm i --frozen-lockfile')
  assert.equal(await main(['projects', 'list', '--setup', 'x'], ctx), 2)
})
