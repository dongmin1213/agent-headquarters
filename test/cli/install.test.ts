import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { DAEMON_LABEL, PET_LABEL, plistPath } from '../../src/cli/ctx.ts'
import type { Probes } from '../../src/cli/doctor.ts'
import { install, uninstall } from '../../src/cli/install.ts'
import { freePort, testCtx } from './helpers.ts'

const okProbes: Probes = {
  platform: () => 'darwin', macVersion: async () => '26.5', nodeVersion: () => '26.4.0',
  findBin: (n) => `/fake/bin/${n}`,
  run: async (cmd, args) => ({ code: 0, stdout: cmd.endsWith('claude') && args[0] === 'auth' ? '{"loggedIn":true}' : args.includes('rev-parse') ? 'true' : 'v1', stderr: '' }),
  hq: async () => ({ kind: 'down' }), pgrep: async () => false, launchctlLoaded: async () => false,
}

test('dry-run install writes both plists into the temp dir and prints launchctl commands', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await install(ctx, { sprites: true, probes: okProbes }), 0, ctx.text())
  const out = ctx.text()
  const d = readFileSync(plistPath(ctx, DAEMON_LABEL), 'utf8')
  const p = readFileSync(plistPath(ctx, PET_LABEL), 'utf8')
  assert.ok(d.includes(`<string>${ctx.root}/src/main.ts</string>`))
  assert.ok(d.includes(`<string>${process.execPath}</string>`))
  assert.ok(d.includes(`<string>${ctx.home}/logs/daemon.log</string>`))
  assert.ok(p.includes(`${ctx.root}/pet/HQPet.app/Contents/MacOS/hqpet`))
  const uid = process.getuid!()
  for (const l of [DAEMON_LABEL, PET_LABEL]) {
    assert.ok(out.includes(`[dry-run] launchctl bootout gui/${uid}/${l}`), out)
    assert.ok(out.includes(`[dry-run] launchctl bootstrap gui/${uid} ${plistPath(ctx, l)}`), out)
  }
  assert.ok(out.includes(`[dry-run] /bin/sh ${ctx.root}/pet/build.sh`))
  assert.match(out, /제3자 저작물/)
  assert.ok(out.includes(`[dry-run] /bin/bash ${ctx.root}/scripts/fetch-packs.sh`))
  // bootout precedes bootstrap
  assert.ok(out.indexOf(`bootout gui/${uid}/${DAEMON_LABEL}`) < out.indexOf(`bootstrap gui/${uid} ${plistPath(ctx, DAEMON_LABEL)}`))
  // idempotent
  assert.equal(await install(ctx, { sprites: false, probes: okProbes }), 0, ctx.text())
  assert.match(ctx.text(), /건너뜀 \(--no-sprites\)/)
})

test('install aborts with exit 5 when doctor fails and writes nothing', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await install(ctx, { sprites: true, probes: { ...okProbes, nodeVersion: () => '20.0.0' } }), 5)
  assert.match(ctx.text(), /설치 중단/)
  assert.match(ctx.text(), /해결:/)
  assert.equal(existsSync(plistPath(ctx, DAEMON_LABEL)), false)
  assert.doesNotMatch(ctx.text(), /launchctl/)
})

test('uninstall: --purge needs --yes; dry-run prints removals', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await install(ctx, { sprites: false, probes: okProbes }), 0)
  assert.equal(await uninstall(ctx, { purge: true, yes: false }), 2)
  ctx.lines.length = 0
  assert.equal(await uninstall(ctx, { purge: false, yes: false }), 0)
  const uid = process.getuid!()
  assert.ok(ctx.text().includes(`[dry-run] launchctl bootout gui/${uid}/${DAEMON_LABEL}`))
  assert.ok(ctx.text().includes(`[dry-run] rm ${plistPath(ctx, DAEMON_LABEL)}`))
  assert.ok(existsSync(plistPath(ctx, DAEMON_LABEL)), 'dry-run keeps files')
})

test('real (non-dry) uninstall removes plists written into the temp dir; launchctl faked', async () => {
  const calls: string[] = []
  const ctx = testCtx({ port: await freePort(), dryRun: false, run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' } } })
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(ctx.agentsDir, { recursive: true })
  for (const l of [DAEMON_LABEL, PET_LABEL]) writeFileSync(plistPath(ctx, l), '<plist/>')
  assert.equal(await uninstall(ctx, { purge: false, yes: false }), 0)
  assert.equal(existsSync(plistPath(ctx, DAEMON_LABEL)), false)
  assert.ok(calls.some((c) => c.startsWith('launchctl bootout')))
})
