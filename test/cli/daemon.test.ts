import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { restart, rotateLog, start, stop, stopTarget } from '../../src/cli/daemon.ts'
import { daemonLabel, launchdJobPath, lockFile, makeCtx, petLabel, pidFile, plistPath, type Ctx } from '../../src/cli/ctx.ts'
import { fakeDaemon, freePort, testCtx, tmp, writeToken, type TestCtx } from './helpers.ts'
import { NESTED_PS_SKIP, nestedSandbox } from '../nested.ts'

test('start refuses when a live hq already answers on the port', async (t) => {
  const d = await fakeDaemon('tok', { teams: [] }); t.after(() => d.server.close())
  const ctx = testCtx({ port: d.port }); writeToken(ctx, 'tok')
  assert.equal(await start(ctx), 1)
  assert.match(ctx.text(), /이미 hq가 .* 실행 중/)
  assert.doesNotMatch(ctx.text(), /\[dry-run\]/)
  assert.equal(existsSync(pidFile(ctx)), false)
})

test('start refuses when another program holds the port', async (t) => {
  const s = createServer((_q, r) => { r.writeHead(404); r.end('nope') })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); t.after(() => s.close())
  const ctx = testCtx({ port: (s.address() as { port: number }).port })
  assert.equal(await start(ctx), 1)
  assert.match(ctx.text(), /다른 프로그램/)
})

test('start on a free port (dry-run) prints the detached launch, no launchctl without plist', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await start(ctx), 0, ctx.text())
  assert.match(ctx.text(), /\[dry-run\] .*node.* .*src\/main\.ts \(백그라운드/)
  assert.doesNotMatch(ctx.text(), /launchctl/)
})

test('stop with nothing running is a no-op', async () => {
  const ctx = testCtx({ port: await freePort() })
  assert.equal(await stop(ctx), 0)
  assert.match(ctx.text(), /실행 중이 아닙니다/)
})

test('stop ignores a stale pidfile pointing at a non-hq process', { skip: nestedSandbox && NESTED_PS_SKIP }, async () => {
  const ctx = testCtx({ port: await freePort() })
  mkdirSync(ctx.home, { recursive: true })
  writeFileSync(pidFile(ctx), `${process.pid}\n`) // alive, but not src/main.ts
  assert.equal(await stop(ctx), 0)
  assert.doesNotMatch(ctx.text(), /kill/)
})

test('rotateLog keeps 3 generations', () => {
  const dir = tmp(); const f = join(dir, 'daemon.log')
  for (let i = 1; i <= 5; i++) {
    writeFileSync(f, `gen${i}`.padEnd(20, '.'))
    assert.equal(rotateLog(f, 10, 3), true)
  }
  assert.equal(existsSync(f), false)
  assert.match(readFileSync(`${f}.1`, 'utf8'), /^gen5/)
  assert.match(readFileSync(`${f}.3`, 'utf8'), /^gen3/)
  assert.equal(existsSync(`${f}.4`), false)
  writeFileSync(f, 'small')
  assert.equal(rotateLog(f, 10, 3), false)
})

test('real detached start/stop with a stand-in daemon (pidfile, single instance, log file)', { skip: nestedSandbox && NESTED_PS_SKIP }, async (t) => {
  const port = await freePort()
  const ctx = testCtx({ port, dryRun: false })
  writeToken(ctx, 'tok')
  mkdirSync(join(ctx.root, 'src'), { recursive: true })
  // Stand-in for src/main.ts: same auth shape, exits 0 on SIGTERM.
  writeFileSync(join(ctx.root, 'src/main.ts'), `
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
const token = readFileSync(process.env.HQ_TOKEN_FILE!, 'utf8').trim()
const s = createServer((q, r) => {
  const ok = q.headers.authorization === 'Bearer ' + token
  r.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }); r.end(JSON.stringify(ok ? { teams: [] } : { error: 'unauthorized' }))
}).listen(Number(process.env.HQ_PORT), '127.0.0.1')
import { writeFileSync as w } from 'node:fs'
w(process.env.HQ_HOME + '/daemon.lock', String(process.pid))
console.log('stand-in up')
process.on('SIGTERM', () => { s.close(); process.exit(0) })
`)
  t.after(async () => { try { process.kill(Number(readFileSync(pidFile(ctx), 'utf8')), 'SIGKILL') } catch { /* gone */ } })
  assert.equal(await start(ctx), 0, ctx.text())
  const pid = Number(readFileSync(pidFile(ctx), 'utf8'))
  assert.ok(pid > 0)
  assert.equal(Number(readFileSync(lockFile(ctx), 'utf8')), pid, 'stand-in wrote the daemon lock')
  assert.equal(await start(ctx), 1, 'second start refused')
  assert.match(ctx.errors.at(-1)!, /중복 실행 거부/)
  assert.equal(await stop(ctx), 0, ctx.text())
  assert.equal(existsSync(pidFile(ctx)), false)
  assert.match(readFileSync(join(ctx.home, 'logs/daemon.log'), 'utf8'), /stand-in up/)
})

test('start refuses while the daemon lock pid is alive (even if the port is quiet)', async () => {
  const ctx = testCtx({ port: await freePort() })
  mkdirSync(ctx.home, { recursive: true })
  writeFileSync(lockFile(ctx), `${process.pid}\n`)
  assert.equal(await start(ctx), 1)
  assert.match(ctx.errors.at(-1)!, /잠금 .*pid \d+가 살아 있어 시작하지 않습니다/)
  assert.doesNotMatch(ctx.text(), /\[dry-run\]/)
})

test('start proceeds past a stale lock (dead pid)', async () => {
  const ctx = testCtx({ port: await freePort() })
  mkdirSync(ctx.home, { recursive: true })
  writeFileSync(lockFile(ctx), '999999\n')
  assert.equal(await start(ctx), 0, ctx.text())
})

test('stop refuses to kill a lock pid whose command is not src/main.ts', { skip: nestedSandbox && NESTED_PS_SKIP }, async () => {
  const ctx = testCtx({ port: await freePort(), dryRun: false })
  mkdirSync(ctx.home, { recursive: true })
  writeFileSync(lockFile(ctx), `${process.pid}\n`) // the test runner: alive, not hq
  writeFileSync(pidFile(ctx), `${process.pid}\n`)
  assert.equal(await stop(ctx), 1)
  assert.match(ctx.errors.at(-1)!, /hq 데몬이 아닙니다.*종료하지 않습니다/)
})

test('with a lock present, stop targets only the lock pid, not the pidfile', async () => {
  const { spawn } = await import('node:child_process')
  const ctx = testCtx({ port: await freePort(), dryRun: false })
  mkdirSync(ctx.home, { recursive: true })
  // A process whose command line contains src/main.ts but which is not in the lock.
  const dir = tmp(); mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/main.ts'), 'setInterval(() => {}, 1000)')
  const other = spawn(process.execPath, [join(dir, 'src/main.ts')], { stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(pidFile(ctx), `${other.pid}\n`)
    writeFileSync(lockFile(ctx), '999999\n') // stale lock
    assert.equal(await stop(ctx), 0, ctx.text())
    assert.match(ctx.text(), /실행 중이 아닙니다/)
    assert.equal(other.exitCode, null, 'pidfile process left alone')
  } finally { other.kill('SIGKILL') }
})

test('stop refuses a live lock pid whose command cannot be read (ps unavailable)', async () => {
  const ctx = testCtx({ port: await freePort(), dryRun: false })
  mkdirSync(ctx.home, { recursive: true })
  writeFileSync(lockFile(ctx), `${process.pid}\n`) // alive; ps "fails"
  const r = await stopTarget(ctx, async () => null)
  assert.deepEqual(r, { error: `pid ${process.pid}의 프로그램을 확인할 수 없어 종료하지 않습니다 (ps 실행 불가)` })
})

test('a dead lock pid with no command is still a stale lock, not a refusal', async () => {
  const ctx = testCtx({ port: await freePort(), dryRun: false })
  mkdirSync(ctx.home, { recursive: true })
  writeFileSync(lockFile(ctx), '999999\n')
  assert.equal(await stopTarget(ctx, async () => null), null)
})

// ---- per-installation launchd labels and job ownership ----

test('launchd labels: default home + 7777 keeps the plain labels; any other installation gets a stable suffix', () => {
  const user = tmp()
  const mk = (env: Record<string, string>) => makeCtx({ PATH: process.env.PATH, HOME: user, HQ_LAUNCH_AGENTS_DIR: join(user, 'la'), ...env })
  const def = mk({ HQ_HOME: join(user, '.hq') })
  assert.equal(def.home, join(user, '.hq'))
  assert.equal(daemonLabel(def), 'com.agent-headquarters.daemon')
  assert.equal(petLabel(def), 'com.agent-headquarters.pet')
  assert.equal(plistPath(def, daemonLabel(def)), join(user, 'la', 'com.agent-headquarters.daemon.plist'))
  assert.equal(daemonLabel(mk({ HQ_HOME: `${user}/./.hq/`, HQ_PORT: '7777' })), 'com.agent-headquarters.daemon', 'resolved path compared')

  const hex = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)
  const other = mk({ HQ_HOME: '/tmp/x', HQ_PORT: '7790' })
  assert.equal(daemonLabel(other), `com.agent-headquarters.${hex('/tmp/x:7790')}.daemon`)
  assert.equal(petLabel(other), `com.agent-headquarters.${hex('/tmp/x:7790')}.pet`)
  assert.equal(daemonLabel(mk({ HQ_HOME: '/tmp/x', HQ_PORT: '7790' })), daemonLabel(other), 'stable')
  const portOnly = mk({ HQ_HOME: join(user, '.hq'), HQ_PORT: '7790' })
  assert.equal(daemonLabel(portOnly), `com.agent-headquarters.${hex(`${join(user, '.hq')}:7790`)}.daemon`)
  assert.notEqual(daemonLabel(portOnly), daemonLabel(other))
})

test('launchdJobPath reads the top-level path line only', () => {
  const out = 'gui/501/com.x = {\n\tactive count = 1\n\tpath = /Users/me/Library/LaunchAgents/com.x.plist\n\tstdout path = /tmp/log\n\ttype = LaunchAgent\n}\n'
  assert.equal(launchdJobPath(out), '/Users/me/Library/LaunchAgents/com.x.plist')
  assert.equal(launchdJobPath('garbage'), null)
})

/** A ctx whose plist is installed and whose `launchctl print` reports `jobPath` (a function of the ctx). */
function launchdCtx(port: number, jobPath: (ctx: Ctx) => string, dryRun = true): { ctx: TestCtx; calls: string[] } {
  const calls: string[] = []
  let self: TestCtx
  const ctx = self = testCtx({ port, dryRun, run: async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'launchctl' && args[0] === 'print') return { code: 0, stdout: `${args[1]} = {\n\tactive count = 1\n\tpath = ${jobPath(self)}\n\tstate = running\n}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  } })
  mkdirSync(ctx.agentsDir, { recursive: true })
  writeFileSync(plistPath(ctx, daemonLabel(ctx)), '<plist/>')
  return { ctx, calls }
}
const foreignJob = () => '/Users/someone/Library/LaunchAgents/com.agent-headquarters.daemon.plist'
const ourJob = (ctx: Ctx) => plistPath(ctx, daemonLabel(ctx))
const launchctlSignals = (text: string, calls: string[]) =>
  [...text.split('\n'), ...calls].filter((l) => /launchctl (kill|kickstart|bootout|bootstrap)/.test(l))

test('stop: a loaded job whose plist is not ours is never signalled; the pidfile/lock target is stopped instead',
  { skip: nestedSandbox && NESTED_PS_SKIP }, async () => {
    const { spawn } = await import('node:child_process')
    const { ctx, calls } = launchdCtx(await freePort(), foreignJob, false)
    mkdirSync(ctx.home, { recursive: true })
    // Stand-in for the 7790 test daemon of the incident: a src/main.ts process named by the lock and pidfile.
    const dir = tmp(); mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/main.ts'), 'setInterval(() => {}, 1000)')
    const d = spawn(process.execPath, [join(dir, 'src/main.ts')], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 200))
      writeFileSync(pidFile(ctx), `${d.pid}\n`)
      writeFileSync(lockFile(ctx), `${d.pid}\n`)
      assert.equal(await stop(ctx), 0, ctx.text())
      assert.deepEqual(launchctlSignals(ctx.text(), calls), [])
      assert.ok(calls.some((c) => c.startsWith('launchctl print')), 'ownership was checked')
      assert.match(ctx.text(), new RegExp(`hq 중지됨 \\(pid ${d.pid}\\)`))
      await new Promise((r) => setTimeout(r, 100))
      assert.ok(d.exitCode !== null || d.signalCode !== null, 'stand-in daemon stopped')
    } finally { d.kill('SIGKILL') }
  })

test('stop: unparsable launchctl print output counts as not ours', async () => {
  const { ctx, calls } = launchdCtx(await freePort(), () => '')
  assert.equal(await stop(ctx), 0, ctx.text())
  assert.deepEqual(launchctlSignals(ctx.text(), calls), [])
  assert.match(ctx.text(), /실행 중이 아닙니다/)
})

test('stop: our own loaded job is stopped with launchctl kill SIGTERM as before', async () => {
  const { ctx } = launchdCtx(await freePort(), ourJob)
  assert.equal(await stop(ctx), 0, ctx.text())
  assert.ok(ctx.text().includes(`[dry-run] launchctl kill SIGTERM gui/${ctx.uid}/${daemonLabel(ctx)}`), ctx.text())
})

test('restart: our job is kickstarted; a foreign job never is', async () => {
  const ours = launchdCtx(await freePort(), ourJob)
  assert.equal(await restart(ours.ctx), 0, ours.ctx.text())
  assert.ok(ours.ctx.text().includes(`[dry-run] launchctl kickstart -k gui/${ours.ctx.uid}/${daemonLabel(ours.ctx)}`))

  const foreign = launchdCtx(await freePort(), foreignJob)
  assert.equal(await restart(foreign.ctx), 0, foreign.ctx.text())
  assert.deepEqual(launchctlSignals(foreign.ctx.text(), foreign.calls), [])
  assert.match(foreign.ctx.text(), /백그라운드/)
})

test('start: our loaded job is kickstarted; a foreign job is left alone (detached start instead)', async () => {
  const ours = launchdCtx(await freePort(), ourJob)
  assert.equal(await start(ours.ctx), 0, ours.ctx.text())
  assert.ok(ours.ctx.text().includes(`[dry-run] launchctl kickstart gui/${ours.ctx.uid}/${daemonLabel(ours.ctx)}`))
  assert.match(ours.ctx.text(), /launchd\)/)

  const foreign = launchdCtx(await freePort(), foreignJob)
  assert.equal(await start(foreign.ctx), 0, foreign.ctx.text())
  assert.deepEqual(launchctlSignals(foreign.ctx.text(), foreign.calls), [])
  assert.match(foreign.ctx.text(), /다른 설치의 plist로 로드돼 있어 건드리지 않고/)
  assert.match(foreign.ctx.text(), /\[dry-run\] .*src\/main\.ts \(백그라운드/)
})

test('start: installed but unloaded job is bootstrapped from our plist', async () => {
  const ctx = testCtx({ port: await freePort() }) // fake print: not loaded
  mkdirSync(ctx.agentsDir, { recursive: true })
  writeFileSync(plistPath(ctx, daemonLabel(ctx)), '<plist/>')
  assert.equal(await start(ctx), 0, ctx.text())
  assert.ok(ctx.text().includes(`[dry-run] launchctl bootstrap gui/${ctx.uid} ${plistPath(ctx, daemonLabel(ctx))}`))
})
