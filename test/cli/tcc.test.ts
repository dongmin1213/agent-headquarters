import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { daemonLabel, petBinary, petLabel, plistPath } from '../../src/cli/ctx.ts'
import { runDoctor, type Probes } from '../../src/cli/doctor.ts'
import { install } from '../../src/cli/install.ts'
import { protectedFolders } from '../../src/cli/tcc.ts'
import { fakeDaemon, freePort, testCtx, writeToken, type TestCtx } from './helpers.ts'

test('protectedFolders: exact folder or below, prefix-only names excluded, order and dedupe', () => {
  const h = '/U/h'
  assert.deepEqual(protectedFolders(['/U/h/Desktop/x', '/U/h/Desktop'], h),
    [{ folder: 'Desktop', label: '데스크탑', paths: ['/U/h/Desktop/x', '/U/h/Desktop'] }])
  assert.deepEqual(protectedFolders(['/U/h/DesktopX/y', '/U/h/src/a', '/Other/Desktop/z'], h), [])
  assert.deepEqual(protectedFolders(['/U/h/Downloads/b', '/U/h/Documents/a', '/U/h/Documents/a', '/U/h/Downloads/b'], h), [
    { folder: 'Documents', label: '문서', paths: ['/U/h/Documents/a'] },
    { folder: 'Downloads', label: '다운로드', paths: ['/U/h/Downloads/b'] },
  ])
})

const probes = (over: Partial<Probes> = {}): Probes => ({
  platform: () => 'darwin', macVersion: async () => '26.5', nodeVersion: () => '26.4.0',
  findBin: (n) => `/fake/bin/${n}`,
  run: async (cmd, args) => ({ code: 0, stdout: cmd.endsWith('claude') && args[0] === 'auth' ? '{"loggedIn":true}' : args.includes('rev-parse') ? 'true' : '', stderr: '' }),
  hq: async () => ({ kind: 'down' }), pgrep: async () => true, launchctlLoaded: async () => true,
  sandboxSmoke: async () => ({ ok: true, detail: 'ok' }), pidCommand: async () => null,
  ...over,
})

/** Moves the repo root under the fake user's ~/<folder>. */
function rootUnder(ctx: TestCtx, folder: string): void {
  ctx.root = join(ctx.userHome, folder, 'repo')
  mkdirSync(join(ctx.root, 'config'), { recursive: true })
}

function withAgents(ctx: TestCtx): TestCtx {
  mkdirSync(ctx.agentsDir, { recursive: true })
  for (const l of [daemonLabel(ctx), petLabel(ctx)]) writeFileSync(plistPath(ctx, l), '<plist/>')
  return ctx
}

test('doctor tcc: root under Desktop, daemon not responding → warn with the settings path', async () => {
  const ctx = withAgents(testCtx()); rootUnder(ctx, 'Desktop')
  const c = (await runDoctor(ctx, probes())).find((x) => x.id === 'tcc')!
  assert.equal(c.status, 'warn')
  assert.equal(c.title, '폴더 접근 권한 (macOS)')
  assert.match(c.detail, /데스크탑/)
  assert.match(c.detail, /~\/Desktop\/repo/)
  assert.match(c.fix!, /파일 및 폴더/)
})

test('doctor tcc: under Desktop but daemon responding and LaunchAgent loaded → ok', async () => {
  const ctx = withAgents(testCtx()); rootUnder(ctx, 'Desktop')
  const c = (await runDoctor(ctx, probes({ hq: async () => ({ kind: 'hq', snapshot: {} }) }))).find((x) => x.id === 'tcc')!
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /권한 허용됨/)
  // responding but LaunchAgent not loaded → still warn
  const d = (await runDoctor(ctx, probes({ hq: async () => ({ kind: 'hq', snapshot: {} }), launchctlLoaded: async () => false }))).find((x) => x.id === 'tcc')!
  assert.equal(d.status, 'warn')
})

test('doctor tcc: outside protected folders → ok; placed after the autostart checks', async () => {
  const ctx = withAgents(testCtx())
  const checks = await runDoctor(ctx, probes())
  const i = checks.findIndex((x) => x.id === 'tcc')
  assert.equal(checks[i].status, 'ok')
  assert.match(checks[i].detail, /보호 폴더\(데스크탑·문서·다운로드\) 밖/)
  assert.equal(checks[i - 1].id, `launchd:${petLabel(ctx)}`)
})

test('doctor tcc: registered project under Documents counts; bad projects.json is skipped silently', async () => {
  const ctx = withAgents(testCtx())
  writeFileSync(join(ctx.root, 'config/projects.json'), JSON.stringify([{ id: 'a', name: 'A', path: '~/Documents/a' }, { id: 'b' }]))
  const c = (await runDoctor(ctx, probes())).find((x) => x.id === 'tcc')!
  assert.equal(c.status, 'warn'); assert.match(c.detail, /문서/)
  writeFileSync(join(ctx.root, 'config/projects.json'), '{not json')
  assert.equal((await runDoctor(ctx, probes())).find((x) => x.id === 'tcc')!.status, 'ok')
})

/** Non-dry install ctx: launchctl/build faked via ctx.run, pet binary pre-created. */
function realCtx(port: number, calls: string[]): TestCtx {
  const ctx: TestCtx = testCtx({ port, dryRun: false, run: async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    // launchctl print: the job is loaded from this installation's own plist.
    if (cmd === 'launchctl' && args[0] === 'print') return { code: 0, stdout: `${args[1]} = {\n\tpath = ${plistPath(ctx, args[1].split('/').pop()!)}\n}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  } })
  return ctx
}
function petBuilt(ctx: TestCtx) { mkdirSync(dirname(petBinary(ctx)), { recursive: true }); writeFileSync(petBinary(ctx), '') }
const installProbes = probes({ launchctlLoaded: async () => false, pgrep: async () => false })
const petBootstrapped = (calls: string[]) => calls.some((c) => c.startsWith('launchctl bootstrap') && /^launchctl bootstrap gui\/\d+ \S+\/com\.agent-headquarters\.[0-9a-f]{8}\.pet\.plist$/.test(c))

test('install: protected root and daemon never responds → exit 1 with the 허용 / 90초 message, pet not bootstrapped', async () => {
  const calls: string[] = []
  const ctx = realCtx(await freePort(), calls); rootUnder(ctx, 'Desktop'); petBuilt(ctx)
  assert.equal(await install(ctx, { sprites: false, probes: installProbes, protectedWaitMs: 50 }), 1, ctx.text())
  const err = ctx.errors.join('\n')
  assert.match(err, /90초/); assert.match(err, /허용/); assert.match(err, /파일 및 폴더/)
  assert.match(ctx.text(), /'node'의 데스크탑 폴더 접근 허용 창을 띄우면 \[허용\]을 눌러 주세요 \(처음 한 번\)/)
  assert.match(ctx.text(), /응답 기다리는 중… \(최대 90초\)/)
  assert.ok(calls.some((c) => c.startsWith('launchctl bootstrap') && c.includes(daemonLabel(ctx))))
  assert.equal(petBootstrapped(calls), false)
})

test('install: protected root and daemon responds → notice printed, pet bootstrapped, exit 0', async () => {
  const calls: string[] = []
  const { server, port } = await fakeDaemon('tok-1', { ok: true })
  try {
    const ctx = realCtx(port, calls); rootUnder(ctx, 'Desktop'); petBuilt(ctx); writeToken(ctx, 'tok-1')
    mkdirSync(ctx.binDir, { recursive: true })
    assert.equal(await install(ctx, { sprites: false, probes: installProbes, protectedWaitMs: 2000 }), 0, ctx.text())
    assert.match(ctx.text(), /'node'의 데스크탑 폴더 접근 허용 창을 띄우면 \[허용\]/)
    assert.ok(petBootstrapped(calls))
    assert.ok(existsSync(plistPath(ctx, petLabel(ctx))))
  } finally { server.close() }
})

test('install: unprotected root and daemon never responds → unchanged 10초 message, no 허용 notice', async () => {
  const calls: string[] = []
  const ctx = realCtx(await freePort(), calls); petBuilt(ctx)
  assert.equal(await install(ctx, { sprites: false, probes: installProbes, daemonWaitMs: 50 }), 1, ctx.text())
  assert.ok(ctx.errors.some((e) => e.startsWith('데몬이 10초 안에 응답하지 않았습니다. 로그: hq logs  (')), ctx.text())
  assert.doesNotMatch(ctx.text(), /허용/)
  assert.equal(petBootstrapped(calls), false)
})
