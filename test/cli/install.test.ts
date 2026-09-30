import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonLabel, installMarker, lockFile, makeCtx, markerContent, petApp, petLabel, plistPath, type Ctx } from '../../src/cli/ctx.ts'
import type { Probes } from '../../src/cli/doctor.ts'
import { buildPlists, install, purgePlan, uninstall } from '../../src/cli/install.ts'
import { fakeDaemon, freePort, spawnMain, testCtx, tmp, writeToken } from './helpers.ts'
import { NESTED_PS_SKIP, nestedSandbox } from '../nested.ts'

const okProbes: Probes = {
  platform: () => 'darwin', macVersion: async () => '26.5', nodeVersion: () => '26.4.0',
  findBin: (n) => `/fake/bin/${n}`,
  run: async (cmd, args) => ({ code: 0, stdout: cmd.endsWith('claude') && args[0] === 'auth' ? '{"loggedIn":true}' : args.includes('rev-parse') ? 'true' : 'v1', stderr: '' }),
  hq: async () => ({ kind: 'down' }), pgrep: async () => false, launchctlLoaded: async () => false,
  sandboxSmoke: async () => ({ ok: true, detail: 'ok' }), pidCommand: async () => null,
}

test('dry-run install writes no plist files, prints the writes and launchctl commands', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await install(ctx, { sprites: true, probes: okProbes }), 0, ctx.text())
  const out = ctx.text()
  const uid = process.getuid!()
  for (const l of [daemonLabel(ctx), petLabel(ctx)]) {
    assert.equal(existsSync(plistPath(ctx, l)), false, 'dry-run must not write plists')
    assert.ok(out.includes(`[dry-run] write ${plistPath(ctx, l)}`), out)
    assert.ok(out.includes(`[dry-run] launchctl bootout gui/${uid}/${l}`), out)
    assert.ok(out.includes(`[dry-run] launchctl bootstrap gui/${uid} ${plistPath(ctx, l)}`), out)
  }
  assert.equal(existsSync(ctx.agentsDir), false)
  assert.equal(existsSync(ctx.home), false, 'dry-run creates no logs dir either')
  assert.ok(out.includes(`[dry-run] /bin/sh ${ctx.root}/pet/build.sh`))
  assert.match(out, /제3자 저작물/)
  assert.ok(out.includes(`[dry-run] /bin/bash ${ctx.root}/scripts/fetch-packs.sh`))
  // bootout precedes bootstrap
  assert.ok(out.indexOf(`bootout gui/${uid}/${daemonLabel(ctx)}`) < out.indexOf(`bootstrap gui/${uid} ${plistPath(ctx, daemonLabel(ctx))}`))
  // idempotent
  assert.equal(await install(ctx, { sprites: false, probes: okProbes }), 0, ctx.text())
  assert.match(ctx.text(), /건너뜀 \(--no-sprites\)/)
})

test('generated plists carry this installation\'s labels and paths', async () => {
  const ctx = testCtx({ port: await freePort() })
  const { daemon: d, pet: p } = buildPlists(ctx)
  assert.ok(d.includes(`<string>${daemonLabel(ctx)}</string>`))
  assert.ok(p.includes(`<string>${petLabel(ctx)}</string>`))
  assert.ok(d.includes(`<string>${ctx.root}/src/main.ts</string>`))
  assert.ok(d.includes(`<string>${process.execPath}</string>`))
  assert.ok(d.includes(`<string>${ctx.home}/logs/daemon.log</string>`))
  assert.ok(p.includes(`${ctx.root}/pet/HQPet.app/Contents/MacOS/hqpet`))
  assert.ok(p.includes(`<string>http://127.0.0.1:${ctx.port}</string>`), 'pet HQ_URL')
  assert.ok(p.includes(`<key>HQ_TOKEN_FILE</key>\n    <string>${ctx.tokenFile}</string>`), p)
  assert.ok(p.includes('<key>HQ_ALLOW_SECOND_INSTANCE</key>'), 'temp home is a non-default installation')
})

test('dry-run install announces the install marker it would write', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await install(ctx, { sprites: false, probes: okProbes }), 0, ctx.text())
  assert.ok(ctx.text().includes(`write ${installMarker(ctx)}`), ctx.text())
  assert.equal(existsSync(installMarker(ctx)), false)
})

test('install with our launchd job loaded never signals the lock pid (legacy lock of the running daemon)', { skip: nestedSandbox && NESTED_PS_SKIP }, async () => {
  let self: Ctx
  const ctx = self = testCtx({ port: await freePort(), run: async (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'print') return { code: 0, stdout: `${args[1]} = {\n\tpath = ${plistPath(self, args[1].split('/').pop()!)}\n}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  } })
  const d = await spawnMain(ctx.root)
  try {
    mkdirSync(ctx.home, { recursive: true }); writeFileSync(lockFile(ctx), `${d.pid}\n`)
    assert.equal(await install(ctx, { sprites: false, probes: okProbes }), 0, ctx.text())
    assert.match(ctx.text(), /launchd 데몬은 5\/6에서 새 설정으로 다시 띄웁니다/)
    assert.doesNotMatch(ctx.text(), /kill -TERM|잠금 파일 형식/)
    assert.equal(d.exitCode, null)
  } finally { d.kill('SIGKILL') }
})

test('install refuses when a same-named launchd job belongs to another installation (no write, no bootout)', async () => {
  const calls: string[] = []
  const ctx = testCtx({ port: await freePort(), dryRun: false, run: async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'launchctl' && args[0] === 'print') return { code: 0, stdout: `${args[1]} = {\n\tpath = /somewhere/else/x.plist\n}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  } })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(ctx.root, 'pet/HQPet.app/Contents/MacOS'), { recursive: true }); writeFileSync(join(ctx.root, 'pet/HQPet.app/Contents/MacOS/hqpet'), '')
  assert.equal(await install(ctx, { sprites: false, probes: okProbes }), 1, ctx.text())
  assert.match(ctx.errors.join('\n'), /다른 설치의 plist로 이미 로드돼 있어 건드리지 않습니다/)
  assert.equal(existsSync(plistPath(ctx, daemonLabel(ctx))), false)
  assert.ok(!calls.some((c) => /^launchctl (bootout|bootstrap|kill|kickstart)/.test(c)), calls.join('\n'))
})

test('install aborts with exit 5 when doctor fails and writes nothing', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await install(ctx, { sprites: true, probes: { ...okProbes, nodeVersion: () => '20.0.0' } }), 5)
  assert.match(ctx.text(), /설치 중단/)
  assert.match(ctx.text(), /해결:/)
  assert.equal(existsSync(plistPath(ctx, daemonLabel(ctx))), false)
  assert.doesNotMatch(ctx.text(), /launchctl/)
})

test('uninstall: --purge needs --yes; dry-run prints removals', async () => {
  const ctx = testCtx({ port: await freePort() })
  mkdirSync(ctx.agentsDir, { recursive: true })
  for (const l of [daemonLabel(ctx), petLabel(ctx)]) writeFileSync(plistPath(ctx, l), '<plist/>')
  assert.equal(await uninstall(ctx, { purge: true, yes: false }), 2)
  ctx.lines.length = 0
  assert.equal(await uninstall(ctx, { purge: false, yes: false }), 0)
  const uid = process.getuid!()
  assert.ok(ctx.text().includes(`[dry-run] launchctl bootout gui/${uid}/${daemonLabel(ctx)}`))
  assert.ok(ctx.text().includes(`[dry-run] rm ${plistPath(ctx, daemonLabel(ctx))}`))
  assert.ok(existsSync(plistPath(ctx, daemonLabel(ctx))), 'dry-run keeps files')
})

test('real (non-dry) uninstall removes plists written into the temp dir; launchctl faked', async () => {
  const calls: string[] = []
  const ctx = testCtx({ port: await freePort(), dryRun: false, run: async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    // The loaded jobs are ours: print reports our own plist path.
    if (cmd === 'launchctl' && args[0] === 'print') return { code: 0, stdout: `${args[1]} = {
	path = ${plistPath(ctx, args[1].split('/').pop()!)}
	type = LaunchAgent
}
`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  } })
  mkdirSync(ctx.agentsDir, { recursive: true })
  for (const l of [daemonLabel(ctx), petLabel(ctx)]) writeFileSync(plistPath(ctx, l), '<plist/>')
  assert.equal(await uninstall(ctx, { purge: false, yes: false }), 0)
  assert.equal(existsSync(plistPath(ctx, daemonLabel(ctx))), false)
  assert.ok(calls.some((c) => c.startsWith('launchctl bootout')))
})

test('uninstall leaves another installation\'s same-named launchd job alone but removes its own plists', async () => {
  const calls: string[] = []
  const ctx = testCtx({ port: await freePort(), dryRun: false, run: async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'launchctl' && args[0] === 'print') return { code: 0, stdout: `${args[1]} = {\n\tpath = /Users/else/Library/LaunchAgents/x.plist\n}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  } })
  mkdirSync(ctx.agentsDir, { recursive: true })
  for (const l of [daemonLabel(ctx), petLabel(ctx)]) writeFileSync(plistPath(ctx, l), '<plist/>')
  assert.equal(await uninstall(ctx, { purge: false, yes: false }), 0)
  assert.ok(!calls.some((c) => c.startsWith('launchctl bootout')), calls.join('\n'))
  assert.equal(existsSync(plistPath(ctx, daemonLabel(ctx))), false)
  assert.match(ctx.errors.join('\n'), /건드리지 않습니다/)
})

// ---- --purge safety (K3): validate everything before deleting anything ----

/** A real (non-dry) ctx with installed plists, a marked HQ_HOME and a regular token; launchctl reports nothing loaded. */
async function purgeCtx() {
  const ctx = testCtx({ port: await freePort(), dryRun: false })
  mkdirSync(ctx.agentsDir, { recursive: true })
  for (const l of [daemonLabel(ctx), petLabel(ctx)]) writeFileSync(plistPath(ctx, l), '<plist/>')
  mkdirSync(join(ctx.home, 'logs'), { recursive: true })
  writeFileSync(join(ctx.home, 'hq.db'), 'db')
  writeFileSync(installMarker(ctx), markerContent(ctx))
  writeToken(ctx)
  mkdirSync(join(petApp(ctx), 'Contents/MacOS'), { recursive: true })
  return ctx
}
const untouched = (ctx: Ctx) => {
  assert.ok(existsSync(join(ctx.home, 'hq.db')), 'HQ_HOME kept')
  assert.ok(existsSync(plistPath(ctx, daemonLabel(ctx))), 'plists kept (validation precedes every deletion)')
  assert.ok(existsSync(ctx.tokenFile), 'token path kept')
  assert.ok(existsSync(petApp(ctx)), 'pet app kept')
}

test('purge refuses and deletes nothing when the token path is a directory', async () => {
  const ctx = await purgeCtx()
  rmSync(ctx.tokenFile); mkdirSync(ctx.tokenFile); writeFileSync(join(ctx.tokenFile, 'keep'), 'x')
  assert.equal(await uninstall(ctx, { purge: true, yes: true }), 1)
  assert.match(ctx.errors.join('\n'), /일반 파일이 아니라.*아무것도 지우지 않았어요/)
  untouched(ctx)
  assert.ok(existsSync(join(ctx.tokenFile, 'keep')))
})

test('purge refuses a symlinked token', async () => {
  const ctx = await purgeCtx()
  const real = join(tmp(), 'real-token'); writeFileSync(real, 'secret')
  rmSync(ctx.tokenFile); symlinkSync(real, ctx.tokenFile)
  assert.equal(await uninstall(ctx, { purge: true, yes: true }), 1)
  untouched(ctx)
  assert.ok(existsSync(real))
})

test('purge refuses and deletes nothing without a matching install marker', async () => {
  const ctx = await purgeCtx()
  rmSync(installMarker(ctx))
  assert.equal(await uninstall(ctx, { purge: true, yes: true }), 1)
  assert.match(ctx.errors.join('\n'), /표식.*없거나 맞지 않아 아무것도 지우지 않았어요/)
  untouched(ctx)
  // A marker of another root or port does not count either.
  writeFileSync(installMarker(ctx), JSON.stringify({ root: '/elsewhere', port: ctx.port, created: 'x' }))
  assert.equal(await uninstall(ctx, { purge: true, yes: true }), 1)
  writeFileSync(installMarker(ctx), JSON.stringify({ root: ctx.root, port: ctx.port + 1, created: 'x' }))
  assert.equal(await uninstall(ctx, { purge: true, yes: true }), 1)
  untouched(ctx)
})

test('non-default purge deletes its home and token but keeps the shared pet app', async () => {
  const ctx = await purgeCtx()
  assert.equal(await uninstall(ctx, { purge: true, yes: true }), 0, ctx.text())
  assert.equal(existsSync(ctx.home), false)
  assert.equal(existsSync(ctx.tokenFile), false)
  assert.equal(existsSync(plistPath(ctx, daemonLabel(ctx))), false)
  assert.ok(existsSync(petApp(ctx)), 'pet app kept')
  assert.match(ctx.text(), /펫 앱 .*남겨 둡니다/)
})

test('purgePlan: only the default installation removes the pet app (pure check, no network)', () => {
  const user = tmp(), root = tmp()
  mkdirSync(join(root, 'pet/HQPet.app'), { recursive: true })
  // HQ_HOME must be explicit: loadConfig expands a missing HQ_HOME with the real homedir(), not env.HOME.
  const def = makeCtx({ HOME: user, PATH: process.env.PATH, HQ_HOME: join(user, '.hq'), HQ_PORT: '7777' }, { root })
  assert.ok(def.home.startsWith(user + '/'), `test home stays in the temp dir: ${def.home}`)
  mkdirSync(def.home, { recursive: true }); writeFileSync(installMarker(def), markerContent(def))
  const plan = purgePlan(def)
  assert.ok(!('error' in plan) && plan.petApp === petApp(def) && plan.home === def.home, JSON.stringify(plan))
  const docs = makeCtx({ HOME: user, PATH: process.env.PATH, HQ_HOME: user }, { root })
  assert.ok('error' in purgePlan(docs), 'HQ_HOME = user home refused')
  const parent = makeCtx({ HOME: user, PATH: process.env.PATH, HQ_HOME: join(user, '..') }, { root })
  assert.ok('error' in purgePlan(parent), 'a parent of the user home refused')
})

test('purge aborts (deletes no data) when the daemon cannot be confirmed stopped', { skip: nestedSandbox && NESTED_PS_SKIP }, async () => {
  const ctx = await purgeCtx()
  const d = await spawnMain(ctx.root)
  try {
    writeFileSync(lockFile(ctx), `${d.pid}\n`) // legacy lock: never signalled, so it stays up
    assert.equal(await uninstall(ctx, { purge: true, yes: true, downWaitMs: 300 }), 1)
    assert.match(ctx.errors.join('\n'), /데몬이 멈췄는지 확인하지 못해 데이터는 지우지 않았어요/)
    assert.ok(existsSync(join(ctx.home, 'hq.db')))
    assert.ok(existsSync(ctx.tokenFile))
    assert.equal(d.exitCode, null)
  } finally { d.kill('SIGKILL') }
})

// ---- launchd re-registration race (bootout → bootstrap "Bootstrap failed: 5") ----

const FAST = { pollMs: 5, goneMs: 2000, retryMs: 5 }

/**
 * Fake launchctl with our jobs loaded. After a bootout, `print` still shows the job `lingerPrints` more times, then fails.
 * `bootstrapFails(label, n)` decides whether the n-th bootstrap of that label fails with the code-5 race stderr.
 */
async function raceCtx(o: { port: number; lingerPrints: number; bootstrapFails: (label: string, n: number) => boolean }) {
  const calls: string[] = []
  const state = new Map<string, number>() // label → prints left while loaded (Infinity = loaded, 0 = gone)
  const boots = new Map<string, number>()
  let self: Ctx
  const ctx = self = testCtx({ port: o.port, dryRun: false, run: async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd !== 'launchctl') return { code: 0, stdout: '', stderr: '' }
    const label = args[0] === 'bootstrap' ? args[2].split('/').pop()!.replace(/\.plist$/, '') : args[1].split('/').pop()!
    const left = state.get(label) ?? Infinity
    if (args[0] === 'print') {
      if (left <= 0) return { code: 113, stdout: '', stderr: 'Could not find service' }
      state.set(label, left - 1)
      return { code: 0, stdout: `${args[1]} = {\n\tpath = ${plistPath(self, label)}\n}\n`, stderr: '' }
    }
    if (args[0] === 'bootout') { state.set(label, o.lingerPrints); return { code: 0, stdout: '', stderr: '' } }
    if (args[0] === 'bootstrap') {
      const n = (boots.get(label) ?? 0) + 1; boots.set(label, n)
      if (o.bootstrapFails(label, n)) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' }
      state.set(label, Infinity)
    }
    return { code: 0, stdout: '', stderr: '' }
  } })
  mkdirSync(join(ctx.root, 'pet/HQPet.app/Contents/MacOS'), { recursive: true }); writeFileSync(join(ctx.root, 'pet/HQPet.app/Contents/MacOS/hqpet'), '')
  const bootstraps = (label: string) => calls.filter((c) => c.startsWith(`launchctl bootstrap gui/${ctx.uid} ${plistPath(ctx, label)}`))
  return { ctx, calls, bootstraps }
}

test('install waits after bootout until launchctl print fails, then bootstraps once', async (t) => {
  const d = await fakeDaemon('tok-race', {}); t.after(() => d.server.close())
  const { ctx, calls, bootstraps } = await raceCtx({ port: d.port, lingerPrints: 2, bootstrapFails: () => false })
  writeToken(ctx, 'tok-race')
  assert.equal(await install(ctx, { sprites: false, probes: okProbes, launchd: FAST }), 0, ctx.text())
  const dl = daemonLabel(ctx), target = `launchctl print gui/${ctx.uid}/${dl}`
  const out = calls.indexOf(`launchctl bootout gui/${ctx.uid}/${dl}`), boot = calls.indexOf(bootstraps(dl)[0])
  assert.equal(bootstraps(dl).length, 1, calls.join('\n'))
  assert.equal(calls.slice(out + 1, boot).filter((c) => c === target).length, 3, 'print loaded, loaded, gone → then bootstrap')
  assert.equal(bootstraps(petLabel(ctx)).length, 1)
})

test('install retries a bootstrap that fails with the code-5 race and succeeds on the 3rd attempt', async (t) => {
  const d = await fakeDaemon('tok-race', {}); t.after(() => d.server.close())
  const { ctx, calls, bootstraps } = await raceCtx({ port: d.port, lingerPrints: 0, bootstrapFails: (l, n) => l === daemonLabel(ctx) && n <= 2 })
  writeToken(ctx, 'tok-race')
  assert.equal(await install(ctx, { sprites: false, probes: okProbes, launchd: FAST }), 0, ctx.text())
  assert.equal(bootstraps(daemonLabel(ctx)).length, 3, calls.join('\n'))
  assert.equal(bootstraps(petLabel(ctx)).length, 1)
  assert.doesNotMatch(ctx.errors.join('\n'), /다시 등록하지 못했어요/)
})

test('install reports and exits 1 when the daemon bootstrap keeps failing; the pet is not bootstrapped with the daemon down', async () => {
  const { ctx, calls, bootstraps } = await raceCtx({ port: await freePort(), lingerPrints: 0, bootstrapFails: () => true })
  assert.equal(await install(ctx, { sprites: false, probes: okProbes, launchd: FAST }), 1, ctx.text())
  assert.equal(bootstraps(daemonLabel(ctx)).length, 4, calls.join('\n'))
  assert.equal(bootstraps(petLabel(ctx)).length, 0, calls.join('\n'))
  const plist = plistPath(ctx, daemonLabel(ctx))
  assert.ok(ctx.errors.join('\n').includes(`데몬을 다시 등록하지 못했어요: Bootstrap failed: 5: Input/output error · 잠시 뒤 hq install을 다시 실행하거나 launchctl bootstrap gui/${ctx.uid} ${plist}를 실행해 주세요`), ctx.errors.join('\n'))
  assert.doesNotMatch(ctx.text(), /6\/6/)
})

test('dry-run install prints bootout/bootstrap without polling launchctl print or waiting', async () => {
  const calls: string[] = []
  const ctx = testCtx({ port: await freePort(), run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 113, stdout: '', stderr: '' } } })
  const t0 = Date.now()
  assert.equal(await install(ctx, { sprites: false, probes: okProbes }), 0, ctx.text()) // default timings: any wait would take ≥ 250 ms
  assert.ok(Date.now() - t0 < 2000)
  // Only the ownership checks read print (daemon: step 4 + step 5 + bootstrap; pet: step 5 + bootstrap) — no post-bootout polling.
  for (const [l, n] of [[daemonLabel(ctx), 3], [petLabel(ctx), 2]] as const) {
    assert.ok(ctx.text().includes(`[dry-run] launchctl bootout gui/${ctx.uid}/${l}`))
    assert.equal(calls.filter((c) => c === `launchctl print gui/${ctx.uid}/${l}`).length, n, calls.join('\n'))
  }
})
