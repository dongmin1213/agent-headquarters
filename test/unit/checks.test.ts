// §G 3: hq's own mechanical verification (execution.md §9).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { baseline, runChecks, secretScan } from '../../src/exec/checks.ts'
import type { SandboxOpts } from '../../src/exec/sandbox.ts'
import { commitFile, makeRepo, sh, tmp } from './helpers.ts'

function env() {
  const dir = tmp('hq-checks-')
  const repo = makeRepo(join(dir, 'repo'))
  const base = sh(repo, 'rev-parse', 'HEAD')
  const head = commitFile(repo, 'src/a.txt', 'hello\n')
  const sb = (wt: string): SandboxOpts => ({ worktree: wt, out: null, repoGitDir: join(repo, '.git'), hqHome: join(dir, 'home'), tokenDir: join(dir, 'tok'), hqPort: 17998, extraWritable: [], claudeDir: join(homedir(), '.claude') })
  const run = (checks: { id: string; command: string }[], o: { timeoutMs?: number; baselineFailed?: Set<string> } = {}) =>
    runChecks({ cwd: repo, base, head, checks, timeoutMs: o.timeoutMs ?? 20_000, sandbox: sb(repo), profilePath: join(dir, 'c.sb'), baselineFailed: o.baselineFailed })
  return { dir, repo, base, head, sb, run }
}

test('3. pass, fail, and timeout that kills the whole process group', async () => {
  const e = env()
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
  const e = env()
  const r = await e.run([{ id: 'mut', command: 'echo changed >> src/a.txt' }])
  assert.equal(r.checks[0].exitCode, 0)
  assert.equal(r.checks[0].pass, false)
  assert.match(r.checks[0].outputTail, /작업 폴더/)
  sh(e.repo, 'checkout', '--', '.')
})

test('3. baseline: a check already failing on base is excluded from the verdict', async () => {
  const e = env()
  const checks = [{ id: 'old', command: 'test -f missing.txt' }, { id: 'new', command: 'test -f src/a.txt' }]
  const b = await baseline({ repo: e.repo, base: e.base, path: join(e.dir, 'home', 'bl'), checks, setup: null, timeoutMs: 20_000, sandbox: e.sb, profilePath: join(e.dir, 'b.sb') })
  assert.deepEqual(b, { old: false, new: false })
  const r = await e.run([checks[0]], { baselineFailed: new Set(['old']) })
  assert.equal(r.checks[0].pass, false)
  assert.equal(r.checks[0].baselineFailed, true)
  assert.equal(r.pass, true)
})

test('3. secret added in a middle commit and removed later is still detected, without recording the value', async () => {
  const e = env()
  const key = 'sk-ant-' + 'x'.repeat(30)
  commitFile(e.repo, 'src/conf.txt', `key=${key}\n`, 'add key')
  const head = commitFile(e.repo, 'src/conf.txt', 'key=REDACTED\n', 'remove key')
  commitFile(e.repo, 'certs/server.pem', 'not really\n', 'pem')
  const hits = await secretScan(e.repo, e.base, sh(e.repo, 'rev-parse', 'HEAD'))
  assert.ok(hits.some((h) => h.pattern === 'anthropic-key' && h.file === 'src/conf.txt'))
  assert.ok(hits.some((h) => h.pattern === 'pem'))
  assert.doesNotMatch(JSON.stringify(hits), /sk-ant-x/)
  assert.ok(head)
})
