// §G 3: hq's own mechanical verification (execution.md §9).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { baseline, runChecks, secretScan } from '../../src/exec/checks.ts'
import { ensureMirror, verifyWorktree } from '../../src/exec/repos.ts'
import type { SandboxOpts } from '../../src/exec/sandbox.ts'
import { commitFile, makeRepo, sh, tmp } from './helpers.ts'

async function env() {
  const dir = tmp('hq-checks-')
  const repo = makeRepo(join(dir, 'repo'))
  const base = sh(repo, 'rev-parse', 'HEAD')
  const head = commitFile(repo, 'src/a.txt', 'hello\n')
  const home = join(dir, 'home')
  const mirror = await ensureMirror({ id: 'p', path: repo }, join(home, 'repos', 'p.git'))
  const sb = (wt: string): SandboxOpts => ({ worktree: wt, out: null, hqHome: home, tokenDir: join(dir, 'tok'), hqPort: 17998, extraWritable: [], projects: [repo] })
  const wt = await verifyWorktree(mirror, join(home, 'worktrees', 'r', 'A.v1'), head)
  const run = (checks: { id: string; command: string; kind?: 'new' | 'regression' }[], o: { timeoutMs?: number; basePassed?: Record<string, boolean> } = {}) =>
    runChecks({ wt, base, head, checks, timeoutMs: o.timeoutMs ?? 20_000, sandbox: sb(wt.path), profilePath: join(dir, 'c.sb'), basePassed: o.basePassed })
  return { dir, repo, base, head, sb, run, wt, mirror, home }
}

test('3. pass, fail, and timeout that kills the whole process group', async () => {
  const e = await env()
  const r = await e.run([{ id: 'ok', command: 'test -f src/a.txt' }, { id: 'bad', command: 'echo nope; exit 3' }])
  assert.equal(r.checks[0].pass, true)
  assert.equal(r.checks[1].pass, false)
  assert.equal(r.checks[1].exitCode, 3)
  assert.match(r.checks[1].outputTail, /nope/)
  assert.equal(r.pass, false)
  const pidFile = join('/private/tmp', `hq-check-child-${process.pid}`)
  const t = await e.run([{ id: 'slow', command: `sleep 30 & echo $! > ${pidFile}; sleep 30` }], { timeoutMs: 800 })
  assert.equal(t.checks[0].pass, false)
  assert.equal(t.checks[0].exitCode, null)
  assert.match(t.checks[0].outputTail, /시간 초과/)
  const child = Number(readFileSync(pidFile, 'utf8').trim())
  await new Promise((res) => setTimeout(res, 300))
  assert.throws(() => process.kill(child, 0), 'background child killed too')
})

test('3. a check that modifies the worktree fails', async () => {
  const e = await env()
  const r = await e.run([{ id: 'mut', command: 'echo changed >> src/a.txt' }])
  assert.equal(r.checks[0].exitCode, 0)
  assert.equal(r.checks[0].pass, false)
  assert.match(r.checks[0].outputTail, /작업 폴더/)
})

test('3. baseline is recorded only: a check failing on the base still fails; a new check passing on the base warns', async () => {
  const e = await env()
  const checks = [{ id: 'old', command: 'test -f missing.txt' }, { id: 'new', command: 'test -f src/a.txt' }, { id: 'same', command: 'test -f README.md' }]
  const b = await baseline({ mirror: e.mirror, base: e.base, path: join(e.home, 'worktrees', 'r', 'bl'), checks, setup: null, timeoutMs: 20_000, sandbox: e.sb, profilePath: join(e.dir, 'b.sb') })
  assert.deepEqual(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [v.pass, v.exitCode, v.timedOut]])), { old: [false, 1, false], new: [false, 1, false], same: [true, 0, false] })
  const basePassed = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.pass]))
  const r = await e.run([{ ...checks[0], kind: 'regression' }], { basePassed })
  assert.equal(r.checks[0].pass, false)
  assert.equal(r.pass, false, 'no exemption (v3)')
  const w = await e.run([{ ...checks[2], kind: 'new' }], { basePassed })
  assert.equal(w.pass, true)
  assert.match(w.warnings!.join(' '), /새 동작을 확인하지 않아요/)
})

test('3. secret added in a middle commit and removed later is still detected, without recording the value', async () => {
  const e = await env()
  const key = 'sk-ant-' + 'x'.repeat(30)
  commitFile(e.repo, 'src/conf.txt', `key=${key}\n`, 'add key')
  const head = commitFile(e.repo, 'src/conf.txt', 'key=REDACTED\n', 'remove key')
  commitFile(e.repo, 'certs/server.pem', 'not really\n', 'pem')
  await ensureMirror({ id: 'p', path: e.repo }, e.mirror)
  const hits = await secretScan(e.mirror, e.base, sh(e.repo, 'rev-parse', 'HEAD'))
  assert.ok(hits.some((h) => h.pattern === 'anthropic-key' && h.file === 'src/conf.txt'))
  assert.ok(hits.some((h) => h.pattern === 'pem'))
  assert.doesNotMatch(JSON.stringify(hits), /sk-ant-x/)
  assert.ok(head)
})
