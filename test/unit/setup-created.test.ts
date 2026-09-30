// N5: untracked and ignored files made by setup are recorded in checks.json and shown to the reviewer and on the accept card.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChecks, setupCreatedLine, type ChecksFile } from '../../src/exec/checks.ts'
import { hqDirOf } from '../../src/exec/decisions.ts'
import { reviewPrompt } from '../../src/exec/prompt.ts'
import { ensureMirror, verifyWorktree } from '../../src/exec/repos.ts'
import type { SandboxOpts } from '../../src/exec/sandbox.ts'
import { harness, makeRepo, req, sh, task, tmp } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

test('N5. runChecks records files present before the first check; files under an ignored directory collapse to dir/ (N개)', async () => {
  const dir = tmp('hq-setupc-')
  const repo = makeRepo(join(dir, 'repo'), { 'README.md': '# t\n', '.gitignore': 'node_modules/\n*.local\n' })
  const base = sh(repo, 'rev-parse', 'HEAD')
  const home = join(dir, 'home')
  const mirror = await ensureMirror({ id: 'p', path: repo }, join(home, 'repos', 'p.git'))
  const wt = await verifyWorktree(mirror, join(home, 'worktrees', 'r', 'v'), base)
  const sb: SandboxOpts = { worktree: wt.path, out: null, hqHome: home, tokenDir: join(dir, 'tok'), hqPort: 17998, extraWritable: [], projects: [repo] }
  const run = () => runChecks({ wt, base, head: base, checks: [{ id: 'c', command: 'test -f README.md' }], timeoutMs: 20_000, sandbox: sb, profilePath: join(dir, 'c.sb') })

  const clean = await run()
  assert.equal(clean.pass, true)
  assert.equal(clean.setupCreated, undefined, 'fresh worktree without setup: nothing recorded')

  // What a setup might leave behind: an untracked config, an ignored loose file, and a dependency folder.
  mkdirSync(join(wt.path, 'config'), { recursive: true }); writeFileSync(join(wt.path, 'config/extra.json'), '{}')
  writeFileSync(join(wt.path, 'app.local'), 'x')
  mkdirSync(join(wt.path, 'node_modules/pkg/lib'), { recursive: true })
  for (const f of ['node_modules/pkg/index.js', 'node_modules/pkg/lib/a.js', 'node_modules/.bin']) writeFileSync(join(wt.path, f), '')
  const r = await run()
  assert.equal(r.pass, true, 'recorded only, never a failure')
  assert.deepEqual(r.setupCreated, { count: 5, sample: ['app.local', 'config/extra.json', 'node_modules/ (3개)'] })
  assert.equal(setupCreatedLine(r.setupCreated), 'setup이 만든 파일: app.local, config/extra.json, node_modules/ (3개) (모두 5개)')

  // The review prompt shows the sample.
  const prompt = reviewPrompt({ task: task('A'), requestText: 'r', base, head: base, diffStat: '', checks: r, protectedChanges: [] })
  assert.match(prompt, /- setup이 만든 파일: app\.local, config\/extra\.json, node_modules\/ \(3개\) \(모두 5개\) — 추적되지 않는 파일/)
  assert.match(prompt, /인자에 \| ; & 같은 문자가 필요하면 스크립트 파일로 감싸 한 명령으로 실행한다/)
  const none = reviewPrompt({ task: task('A'), requestText: 'r', base, head: base, diffStat: '', checks: clean, protectedChanges: [] })
  assert.doesNotMatch(none, /setup이 만든 파일/)
})

test('N5. sample keeps the first 20 entries; count covers every file', async () => {
  const dir = tmp('hq-setupc-')
  const repo = makeRepo(join(dir, 'repo'))
  const base = sh(repo, 'rev-parse', 'HEAD')
  const home = join(dir, 'home')
  const mirror = await ensureMirror({ id: 'p', path: repo }, join(home, 'repos', 'p.git'))
  const wt = await verifyWorktree(mirror, join(home, 'worktrees', 'r', 'v'), base)
  for (let i = 0; i < 25; i++) writeFileSync(join(wt.path, `f${String(i).padStart(2, '0')}.txt`), '')
  const r = await runChecks({ wt, base, head: base, checks: [], timeoutMs: 20_000, profilePath: join(dir, 'c.sb'),
    sandbox: { worktree: wt.path, out: null, hqHome: home, tokenDir: join(dir, 'tok'), hqPort: 17998, extraWritable: [], projects: [repo] } })
  assert.equal(r.setupCreated?.count, 25)
  assert.equal(r.setupCreated?.sample.length, 20)
  assert.equal(r.setupCreated?.sample[0], 'f00.txt')
})

test('N5. runner: files made by the verification setup are in checks.json and on the accept card', async () => {
  const h = harness({ repoFiles: { 'README.md': '# t\n', '.gitignore': 'node_modules/\n*.local\n' },
    setup: 'mkdir -p node_modules/pkg && touch node_modules/pkg/index.js node_modules/pkg/b.js app.local' })
  try {
    const id = h.plan([task('A')])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance', 90_000)
    const work = h.store.attempts(`${id}.A`).filter((a) => a.kind === 'work' && a.status === 'succeeded').at(-1)!
    const checks = JSON.parse(readFileSync(join(hqDirOf(work), 'checks.json'), 'utf8')) as ChecksFile
    assert.deepEqual(checks.setupCreated, { count: 3, sample: ['app.local', 'node_modules/ (2개)'] })
    assert.match(h.store.approval(`accept:${id}`)!.body, /setup이 만든 파일 3개/)
  } finally { await h.close() }
})
