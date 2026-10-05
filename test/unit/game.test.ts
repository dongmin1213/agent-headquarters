import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, symlinkSync, rmSync, cpSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { GAME_CHECKS, GAME_DEPARTMENTS, gameEnabled, gamePlanProblem, readGameManifest, type GameManifest } from '../../src/game.ts'
import { execArgs } from '../../src/codex.ts'
import { Scheduler } from '../../src/scheduler.ts'
import { startServer } from '../../src/server.ts'
import { harness, task, tmp, sh } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()
const plan = () => ({ summary: '게임', assumptions: [], tasks: GAME_DEPARTMENTS.map((department, i) => task(department, {
  department, grade: 'L2', review: { brief: '독립 검사', model: 'opus' }, depends_on: i ? [GAME_DEPARTMENTS[i - 1]] : [],
})) })

test('game plan requires all professions, research before design, independent reviews and final integration', () => {
  assert.equal(gamePlanProblem(plan(), 'p'), null)
  for (const department of GAME_DEPARTMENTS) {
    const p = plan(); p.tasks = p.tasks.filter(t => t.department !== department)
    assert.match(gamePlanProblem(p, 'p')!, /직군/)
  }
  const bad = plan(); bad.tasks.at(-1)!.depends_on = ['direction']
  assert.match(gamePlanProblem(bad, 'p')!, /모든 직군/)
  const noResearch = plan(); noResearch.tasks[1].depends_on = []
  assert.ok(gamePlanProblem(noResearch, 'p'))
  const noReview = plan(); noReview.tasks[0].review = { brief: '', model: 'none' }
  assert.ok(gamePlanProblem(noReview, 'p'))
  const external = plan(); external.tasks[2].project = 'other'
  assert.ok(gamePlanProblem(external, 'p'))
})

function fixture() {
  const root = tmp('hq-game-manifest-'); mkdirSync(join(root, 'release'))
  const kinds = ['build', 'video', 'screenshot', 'research', 'design', 'provenance'] as const
  const m: GameManifest = { title: 'test', launch: 'node game.mjs', knownIssues: [], checks: GAME_CHECKS.map(id => ({ id, command: `node test.mjs ${id}` })),
    files: kinds.map(kind => {
      const path = `release/${kind}.${kind === 'video' ? 'mp4' : kind === 'screenshot' ? 'png' : 'txt'}`
      const bytes = `${kind} test artifact`
      writeFileSync(join(root, path), bytes)
      return { path, kind, sha256: createHash('sha256').update(bytes).digest('hex') }
    }) }
  const save = () => writeFileSync(join(root, 'release/game-release.json'), JSON.stringify(m))
  save(); return { root, m, save }
}

test('release manifest binds every artifact and requires playable-flow checks, not a title-only submission', () => {
  const { root, m, save } = fixture()
  try {
    assert.equal(readGameManifest(root).problem, null)
    m.checks.pop(); save()
    assert.match(readGameManifest(root).problem!, /ending/)
    m.checks.push({ id: 'ending', command: 'true' }); save()
    assert.match(readGameManifest(root).problem!, /단일 검사/)
    m.checks.pop(); m.checks.push({ id: 'ending', command: 'node test.mjs ending' }); save()
    writeFileSync(join(root, m.files[0].path), 'changed')
    assert.match(readGameManifest(root).problem!, /해시/)
  } finally { rmSync(root, { recursive: true }) }
})

test('release manifest refuses missing media and escaping/symlinked files', () => {
  const { root, m, save } = fixture()
  const outside = tmp('hq-game-outside-')
  try {
    const original = m.files[0].path
    m.files[0].path = '../outside'; save(); assert.ok(readGameManifest(root).problem)
    m.files[0].path = original; save()
    rmSync(join(root, original)); writeFileSync(join(outside, 'secret'), 'secret')
    symlinkSync(join(outside, 'secret'), join(root, original))
    assert.ok(readGameManifest(root).problem)
    m.files = m.files.filter(f => f.kind !== 'video'); save()
    assert.match(readGameManifest(root).problem!, /video/)
  } finally { rmSync(root, { recursive: true }); rmSync(outside, { recursive: true }) }
})

test('game tool permissions are opt-in and preserve normal worker isolation', () => {
  assert.ok(execArgs({}).includes('features.image_generation=false'))
  const art = execArgs({ imageGeneration: true })
  assert.ok(art.includes('features.image_generation=true'))
  assert.ok(art.includes('features.multi_agent=false'))
  assert.ok(execArgs({ webSearch: true }).includes('web_search="live"'))
  assert.ok(!execArgs({}).includes('web_search="live"'))
})

test('passed game task with no playable release is rejected before any final acceptance card', async () => {
  const h = harness()
  try {
    h.projects[0].workflow = 'game'
    const id = h.plan([task('A', { department: 'delivery' })])
    await h.approve(id)
    await h.waitFor(() => Number(h.store.get(`game.rejections:${id}`)) >= 1, 'release rejection')
    assert.equal(h.store.approval(`accept:${id}`), null)
    assert.notEqual(h.store.request(id)?.status, 'awaiting_acceptance')
    assert.match(h.store.task(`${id}.A`)?.note ?? '', /피카츄/)
  } finally { await h.close() }
})

test('turning off a game project prevents dispatch without affecting normal projects', async () => {
  const h = harness()
  try {
    h.projects[0].workflow = 'game'
    h.store.set('game.enabled:p', 'false')
    const id = h.plan([task('A', { department: 'gameplay' })]); await h.approve(id)
    await h.runner.tick()
    assert.equal(h.store.attempts(`${id}.A`).length, 0)
    h.store.set('game.enabled:p', 'true')
    await h.waitFor(() => h.store.attempts(`${id}.A`).length > 0)
  } finally { await h.close() }
})

test('one game request creates and starts a reviewed profession plan without asking for approval', async () => {
  const h = harness()
  try {
    h.projects[0].workflow = 'game'
    const id = h.engine.submit('게임을 만들어 주세요 [[FAKE:gameplan]]', 'p')
    await h.waitFor(() => h.store.request(id)?.status === 'executing', 'automatic game plan')
    assert.equal(h.store.approval(`plan:${id}`)?.decision, '승인')
    assert.equal(h.store.tasks(id).length, 7)
    assert.equal(h.runner.views().decisions.some(d => d.kind === 'plan' && d.requestId === id), false)
  } finally { h.engine.stop(); await h.close() }
})

test('game team leader answers a worker question and records its decision without user input', async () => {
  const h = harness()
  try {
    h.projects[0].workflow = 'game'
    const id = h.plan([task('A', { department: 'gameplay', brief: '[[FAKE:outcome=question]]' })])
    await h.approve(id)
    await h.waitFor(() => h.store.task(`${id}.A`)?.status === 'question')
    assert.equal(h.runner.views().decisions.some(d => d.kind === 'worker_question'), false)
    await h.engine.tick()
    assert.match(h.store.taskQuestions(`${id}.A`)[0].answer ?? '', /게임팀장 결정/)
    assert.ok(h.store.get(`game.decision:${id}.A:1`))
  } finally { await h.close() }
})

test('team switches require master auth, persist over scheduler restart and appear in snapshots', async () => {
  const h = harness(); h.projects[0].workflow = 'game'
  const team = { id: 'revenue', name: '수익', pack: 'digimon', command: ['/usr/bin/true'], cwd: h.repo, enabled: true, everyMinutes: 30 }
  const isolation = { hqHome: h.cfg.home, tokenDir: join(h.dir, 'tok') }
  const scheduler = new Scheduler([team], h.store, h.bus, 'http://127.0.0.1:18766', isolation)
  const server = startServer({ port: 18766, store: h.store, bus: h.bus, scheduler, token: 'test-master', engine: h.engine, runner: h.runner, projects: h.projects })
  await new Promise(r => server.once('listening', r))
  const call = (path: string, token = 'test-master', enabled: unknown = false) => fetch(`http://127.0.0.1:18766/api/teams/${path}/enabled`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) })
  try {
    assert.equal((await call('revenue', 'wrong')).status, 401)
    assert.equal((await call('revenue', 'test-master', 'false')).status, 400)
    assert.equal((await call('missing')).status, 404)
    assert.equal((await call('revenue')).status, 200)
    assert.equal(scheduler.runNow('revenue'), false)
    const restarted = new Scheduler([{ ...team, enabled: true }], h.store, h.bus, 'http://127.0.0.1:18766', isolation)
    assert.equal(restarted.views()[0].enabled, false); restarted.stop()
    assert.equal((await call('game%3Ap')).status, 200)
    assert.equal(gameEnabled(h.store, 'p'), false)
    const state = await (await fetch('http://127.0.0.1:18766/api/state', { headers: { authorization: 'Bearer test-master' } })).json() as any
    assert.equal(state.teams.find((t: any) => t.id === 'game:p').enabled, false)
  } finally { scheduler.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await h.close() }
})

// This verifies the release state machine with a fake supervisor, not the quality of a shipped game.
test('release gate restores the integrated candidate, retains playable files and fails closed on changes or login loss', {
  skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg required for a valid video fixture',
}, async t => {
  for (const mode of ['pass', 'mutate', 'login']) await t.test(mode, async () => {
    const h = harness(), f = fixture()
    try {
      h.projects[0].workflow = 'game'
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=32x32:r=1', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(f.root, 'release/video.mp4')])
      writeFileSync(join(f.root, 'release/screenshot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'))
      for (const file of f.m.files) file.sha256 = createHash('sha256').update(readFileSync(join(f.root, file.path))).digest('hex')
      f.save(); cpSync(join(f.root, 'release'), join(h.repo, 'release'), { recursive: true })
      writeFileSync(join(h.repo, 'test.mjs'), `import assert from 'node:assert/strict'; assert.ok(${JSON.stringify(GAME_CHECKS)}.includes(process.argv[2]));`)
      sh(h.repo, 'add', '-A'); sh(h.repo, 'commit', '-qm', 'release fixture')
      const marker = mode === 'pass' ? '' : `[[FAKE:supervisor${mode}]]`
      const id = h.plan([task('A', { department: 'delivery' })], `release fixture ${marker}`)
      await h.approve(id)
      if (mode === 'pass') {
        await h.waitFor(() => h.store.request(id)?.status === 'awaiting_acceptance', 'release accepted')
        assert.equal(h.store.approval(`accept:${id}`)?.state, 'open')
        assert.ok(h.store.get(`game.release:${id}`))
        assert.ok(existsSync(join(h.runner.integrationDir(id, 'p'), 'release/video.mp4')))
        assert.equal(readGameManifest(h.runner.integrationDir(id, 'p')).problem, null)
      } else if (mode === 'mutate') {
        await h.waitFor(() => Number(h.store.get(`game.rejections:${id}`)) > 0, 'mutation rejected')
        assert.equal(h.store.approval(`accept:${id}`), null)
        assert.match(h.store.task(`${id}.A`)?.note ?? '', /통합 작업 폴더/)
      } else {
        await h.waitFor(() => !!h.store.get('login.required'), 'login hold')
        assert.equal(h.store.request(id)?.status, 'executing')
        assert.equal(h.store.get(`game.rejections:${id}`), null)
        assert.equal(h.store.approval(`accept:${id}`), null)
      }
    } finally { await h.close(); rmSync(f.root, { recursive: true, force: true }) }
  })
})
