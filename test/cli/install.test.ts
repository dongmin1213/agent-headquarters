import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonLabel, petLabel, plistPath } from '../../src/cli/ctx.ts'
import type { Probes } from '../../src/cli/doctor.ts'
import { buildPlists, install, uninstall } from '../../src/cli/install.ts'
import { freePort, testCtx } from './helpers.ts'

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
