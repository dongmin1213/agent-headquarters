import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rotateLog, start, stop } from '../../src/cli/daemon.ts'
import { lockFile, pidFile } from '../../src/cli/ctx.ts'
import { fakeDaemon, freePort, testCtx, tmp, writeToken } from './helpers.ts'

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

test('stop ignores a stale pidfile pointing at a non-hq process', async () => {
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

test('real detached start/stop with a stand-in daemon (pidfile, single instance, log file)', async (t) => {
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

test('stop refuses to kill a lock pid whose command is not src/main.ts', async () => {
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
