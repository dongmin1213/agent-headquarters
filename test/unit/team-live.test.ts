// Legacy external pipeline contract; not part of HQ Codex runtime smoke tests.
// Opt-in (HQ_LIVE_PIPELINE=1): the revenue team's real shape under the team Seatbelt profile, without touching the real repo.
// The pipeline repo (~/Desktop/side/pipeline, override with HQ_PIPELINE) is git-cloned into a temp folder under $HOME
// (so the ~ read deny-by-default is exercised; episodes/, state/, config secrets are gitignored and stay behind), its
// .venv is symlinked read-only from the real repo, and everything runs through the scheduler's own profile builder.
//   (a) .venv python imports lib.state and lib.llm
//   (b) hq_team.py through a real Scheduler run against a fake hq whose quota mode is 'save' → exit 0 + STATUS line
//   (c) one real `claude -p --model haiku --max-turns 1` in the clone (as lib/llm.py calls it: default setting sources)
// The clone, its ~/.claude/projects/<cwd>/ folder and the per-run caches are removed afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../../src/bus.ts'
import { Scheduler, teamProfile, teamSandboxPaths } from '../../src/scheduler.ts'
import { cacheEnv, claudeProjectDir, makeCacheDir, real, wrap } from '../../src/exec/sandbox.ts'
import { removeCacheDir } from '../../src/exec/worker.ts'
import { Store } from '../../src/store.ts'
import type { TeamConfig } from '../../src/types.ts'
import { tmp } from './helpers.ts'
import { NESTED_SKIP, nestedSandbox } from '../nested.ts'

const PIPELINE = process.env.HQ_PIPELINE ?? join(homedir(), 'Desktop/side/pipeline')
const skip = (nestedSandbox && NESTED_SKIP) || (!process.env.HQ_LIVE_PIPELINE && 'HQ_LIVE_PIPELINE=1 일 때만 실제 파이프라인·claude CLI로 실행')
  || (!existsSync(join(PIPELINE, 'hq_team.py')) && `파이프라인 저장소 없음: ${PIPELINE}`)

function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv, ms = 180_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { out += d })
    const t = setTimeout(() => c.kill('SIGKILL'), ms)
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out }) })
  })
}

test('live: the revenue pipeline (clone) under the team profile — imports, hq_team.py via the scheduler, claude -p', { skip }, async (t) => {
  const root = mkdtempSync(join(real(homedir()), '.hq-live-team-'))
  const clone = join(root, 'pipeline')
  const dir = tmp('hq-team-live-')
  const hqHome = join(dir, 'hq'), tokenDir = join(dir, 'tok')
  const venv = realpathSync(join(PIPELINE, '.venv'))
  const claudeDir = join(real(homedir()), '.claude', 'projects', claudeProjectDir(real(clone)).name)
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(req.url === '/api/quota' ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/api/quota' ? { mode: 'save', windows: [] } : { error: '없는 경로입니다' }))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  const caches: string[] = []
  try {
    execFileSync('git', ['clone', '-q', '--no-hardlinks', PIPELINE, clone], { stdio: 'ignore' })
    assert.equal(existsSync(join(clone, 'episodes')), false, 'episodes/ is gitignored and not cloned')
    symlinkSync(venv, join(clone, '.venv'))
    const team: TeamConfig = { id: 'revenue', name: '수익자동화', pack: 'digimon', command: [join(clone, '.venv/bin/python'), 'hq_team.py'], cwd: clone,
      everyMinutes: 30, enabled: true, sandbox: { readable: [venv] } }
    const paths = teamSandboxPaths(team)
    assert.notEqual(paths, 'none')
    const profile = join(dir, 'team.sb')
    writeFileSync(profile, teamProfile({ cwd: clone, hqHome, tokenDir, ...(paths as { readable: string[]; writable: string[] }) }))
    const env = () => { const c = makeCacheDir(); caches.push(c); const e: NodeJS.ProcessEnv = { ...process.env, ...cacheEnv(c) }; delete e.CLAUDECODE; return e }

    // (a)
    const a = await run(wrap([join(clone, '.venv/bin/python'), '-c', 'import lib.state, lib.llm; print("IMPORT-OK")'], profile), clone, env())
    t.diagnostic(`(a) exit ${a.code}: ${a.out.trim().slice(-400)}`)
    assert.equal(a.code, 0, a.out); assert.match(a.out, /IMPORT-OK/)

    // (b) the scheduler's own spawn path (wrapper, env, scoped token, profile) against the fake hq.
    const store = new Store(join(hqHome, 'hq.db'))
    const sched = new Scheduler([team], store, new Bus(store), `http://127.0.0.1:${port}`, { hqHome, tokenDir, pollMs: 50 }, { holdUntil: () => null, teamLimited: () => {} })
    try {
      assert.equal(sched.runNow('revenue'), true)
      const end = Date.now() + 60_000
      while (!store.lastRun('revenue')?.endedAt && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
      const r = store.lastRun('revenue')!
      t.diagnostic(`(b) exit ${r.exitCode}: ${r.summary}`)
      assert.equal(r.exitCode, 0, r.summary ?? '')
      assert.match(r.summary ?? '', /^STATUS: 사용량 절약 중이라 쉬어요 \(hq 모드: save\)$/m)
      assert.deepEqual(seen, ['GET /api/quota'])
      assert.equal(sched.views()[0].bubble, '사용량 절약 중이라 쉬어요 (hq 모드: save)')
    } finally { sched.stop(); store.close() }

    // (c) as lib/llm.py runs it (no --setting-sources): the CLI must work with ~/.claude.json and settings unreadable.
    const bin = execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()
    const c = await run(wrap([bin, '-p', 'reply OK', '--model', 'haiku', '--max-turns', '1', '--output-format', 'json'], profile), clone, env())
    t.diagnostic(`(c) exit ${c.code}: ${c.out.trim().slice(-600)}`)
    assert.equal(c.code, 0, c.out)
    const res = JSON.parse(c.out.trim().split('\n').at(-1)!)
    assert.equal(res.is_error, false, c.out)
    assert.match(String(res.result), /OK/)
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(claudeDir, { recursive: true, force: true })
    for (const c of caches) removeCacheDir(c)
    rmSync(dir, { recursive: true, force: true })
  }
})

// Informational (HQ_LIVE_PIPELINE=1): the same profile reaches the web from Python (the pipeline calls web APIs with urllib).
test('live: python https fetch works under the team profile (network stays open)', { skip }, async (t) => {
  const dir = tmp('hq-team-live-')
  const cwd = join(dir, 'repo')
  const profile = join(dir, 'team.sb')
  execFileSync('/bin/mkdir', ['-p', cwd])
  writeFileSync(profile, teamProfile({ cwd, hqHome: join(dir, 'hq'), tokenDir: join(dir, 'tok') }))
  const r = await run(wrap(['/usr/bin/python3', '-c', 'import urllib.request as u; print(u.urlopen("https://example.com", timeout=20).status)'], profile), cwd, process.env, 60_000)
  t.diagnostic(`https: exit ${r.code}: ${r.out.trim().slice(-300)}`)
  assert.equal(r.code, 0, r.out); assert.match(r.out, /200/)
  rmSync(dir, { recursive: true, force: true })
})

