import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, symlinkSync, rmSync, cpSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GAME_CHECKS, GAME_DEPARTMENTS, gameEnabled, gameNeedsUser, gamePlanProblem, gameWaiting, gameWaitSignature, readGameManifest, type GameManifest } from '../../src/game.ts'
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

test('bounded game plans can add presentation and lifecycle repair jobs without skipping delivery dependencies', () => {
  const p = plan(), delivery = p.tasks.at(-1)!
  const extras = Array.from({ length: 17 }, (_, i) => task(`repair${i}`, {
    department: 'art', grade: 'L2', depends_on: ['direction'], review: { model: 'sonnet', brief: '독립 검수' },
  }))
  p.tasks.push(...extras)
  delivery.depends_on.push(...extras.map(t => t.id))
  assert.equal(p.tasks.length, 24)
  assert.equal(gamePlanProblem(p, 'p'), null)
  p.tasks.push(task('tooMany'))
  assert.match(gamePlanProblem(p, 'p')!, /최대 24개/)
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

test('interactive play helper is readable only by opted-in game workers and reviewers', async () => {
  const h = harness()
  try {
    const ordinary = h.runner.sandboxFor(h.repo, null, 'p')
    assert.ok(!ordinary.readable?.some(p => p.endsWith('tools/game-play')))
    h.projects[0].workflow = 'game'
    for (const out of [null, join(h.dir, 'out')]) {
      const profile = h.runner.sandboxFor(h.repo, out, 'p')
      assert.ok(profile.readable?.some(p => p.endsWith('tools/game-play')))
      assert.equal(profile.graphics, true)
    }
    assert.match(h.runner.gamePlayTools(), /controller|play.py/)
    assert.match(h.runner.gamePlayTools(), /사람 조작감/)
  } finally { await h.close() }
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

test('explicit game failure and scope blocks reach the leader before any duplicate worker or diagnosis turn', async () => {
  for (const outcome of ['failed', 'blocked']) {
    const h = harness()
    try {
      h.projects[0].workflow = 'game'
      const id = h.plan([task('A', { department: 'gameplay', brief: `[[FAKE:outcome=${outcome}]]` })])
      await h.approve(id)
      await h.waitFor(() => h.store.task(`${id}.A`)?.status === 'blocked')
      for (let i = 0; i < 4; i++) await h.runner.tick()
      const t = h.store.task(`${id}.A`)!
      assert.equal(h.store.attempts(t.id).length, 1, 'no identical worker retry before a repair decision')
      assert.equal(t.diagnosis, null, 'no duplicate paid diagnosis prerequisite')
      assert.equal(t.revise_turns, 0, 'no separate revision turn before the game leader')
      assert.equal(h.runner.ceoLock.busy, false)
      assert.equal(h.runner.ceoWaiting(), true)
      assert.equal(h.runner.views().headline.needsYou, 0)
      await h.engine.tick()
      assert.ok(h.store.get(`game.decision:${t.id}:1`), 'leader receives failure with no diagnosis row')
      assert.notEqual(h.store.task(t.id)?.status, 'blocked')
    } finally { await h.close() }
  }
})

test('game team leader uses Sol first and escalates repeated decisions to Astra', async () => {
  for (const rounds of [0, 1]) {
    const h = harness()
    try {
      h.projects[0].workflow = 'game'
      const id = h.plan([task('A', { department: 'gameplay', brief: '[[FAKE:outcome=question]]' })])
      await h.approve(id)
      await h.waitFor(() => h.store.task(`${id}.A`)?.status === 'question')
      assert.equal(h.runner.views().decisions.some(d => d.kind === 'worker_question'), false)
      if (rounds) h.store.set(`game.decisions:${id}.A`, String(rounds))
      await h.engine.tick()
      assert.match(h.store.taskQuestions(`${id}.A`)[0].answer ?? '', rounds ? /피카츄 결정/ : /게임팀장 결정/)
      const decision = JSON.parse(h.store.get(`game.decision:${id}.A:${rounds + 1}`)!)
      assert.equal(decision.model, rounds ? 'opus' : 'sonnet')
      assert.equal(decision.proceed, true)
    } finally { await h.close() }
  }
})

test('supervisor distinguishes owner decisions from technical holds, without repeated paid loops', async () => {
  for (const mode of ['technical', 'owner', 'exhausted']) {
    const h = harness()
    try {
      h.projects[0].workflow = 'game'
      const id = h.plan([task('A', { department: 'art', brief: `[[FAKE:outcome=question]] [[FAKE:leadwait]] ${mode === 'owner' ? '[[FAKE:ownerdecision]]' : ''}` })])
      await h.approve(id)
      await h.waitFor(() => h.store.task(`${id}.A`)?.status === 'question')
      if (mode === 'exhausted') h.store.set(`game.decisions:${id}.A`, '3')
      await h.engine.tick()
      if (mode !== 'exhausted') {
        assert.equal(gameWaiting(h.store, h.store.task(`${id}.A`)!), false, 'lead failure alone does not reach the owner')
        assert.equal(h.runner.views().headline.needsYou, 0)
        await h.engine.tick()
        assert.equal(JSON.parse(h.store.get(`game.decision:${id}.A:2`)!).supervisor, true)
      }
      const a = h.store.task(`${id}.A`)!
      assert.equal(gameWaiting(h.store, a), true)
      assert.equal(h.store.request(id)?.status, 'executing')
      assert.equal(gameNeedsUser(h.store, a), mode === 'owner')
      assert.equal(h.runner.views().decisions.some(d => d.kind === 'worker_question' && d.taskId === a.id), mode === 'owner')
      if (mode === 'owner') assert.match(h.runner.views().decisions.find(d => d.taskId === a.id)!.detail, /피카츄 검토/)
      if (mode !== 'owner') assert.match(h.runner.views().headline.text, /막혔어요/)
      const count = h.store.get(`game.decisions:${a.id}`)
      await h.engine.tick(); await h.engine.tick()
      assert.equal(h.store.get(`game.decisions:${a.id}`), count, 'no repeated paid decisions for the same wait')
      const b = task('B', { department: 'gameplay' })
      h.store.insertTask({ id: `${id}.B`, request_id: id, key: 'B', project: 'p', title: b.title, role: b.role, grade: b.grade,
        model: b.model, review_model: 'sonnet', spec: JSON.stringify(b), status: 'pending', branch: null, base_sha: a.base_sha })
      await h.waitFor(() => h.store.task(`${id}.B`)?.status === 'passed', 'independent task continues')
      assert.equal(h.store.task(a.id)?.status, 'question', 'unverified criterion was not auto-passed')
      const question = h.store.taskQuestions(a.id).find(q => q.answer === null)!
      assert.equal(h.runner.answerTask(a.id, question.id, '관측 근거 제공', a.revision), null)
      assert.equal(gameWaiting(h.store, h.store.task(a.id)!), false, 'an answer releases only this occurrence')
    } finally { h.engine.stop(); await h.close() }
  }
})

test('Pikachu resolves a team-lead escalation instead of forwarding it to the owner', async () => {
  const h = harness()
  try {
    h.projects[0].workflow = 'game'
    const id = h.plan([task('A', { department: 'gameplay', brief: '[[FAKE:outcome=question]] [[FAKE:leadescalate]]' })])
    await h.approve(id)
    await h.waitFor(() => h.store.task(`${id}.A`)?.status === 'question')
    await h.engine.tick()
    assert.equal(h.store.taskQuestions(`${id}.A`)[0].answer, null)
    assert.equal(h.runner.views().headline.needsYou, 0)
    await h.engine.tick()
    assert.match(h.store.taskQuestions(`${id}.A`)[0].answer!, /피카츄 결정/)
    assert.equal(h.runner.views().headline.needsYou, 0)
  } finally { await h.close() }
})

function repairFixture() {
  const h = harness()
  h.runner.stop() // Exercise the decision transaction without dispatching real fake workers.
  h.projects[0].workflow = 'game'
  const tasks = plan().tasks
  const spec = tasks.find(t => t.id === 'level')!
  spec.brief = '[[FAKE:leadrepair]]'
  const id = h.plan(tasks)
  h.store.updateRequest(id, { status: 'executing' })
  for (const t of tasks) h.store.insertTask({ id: `${id}.${t.id}`, request_id: id, key: t.id, project: 'p', title: t.title,
    role: t.role, grade: t.grade, model: t.model, review_model: t.review!.model, spec: JSON.stringify(t),
    status: t.id === 'level' ? 'blocked' : tasks.indexOf(t) < tasks.indexOf(spec) ? 'passed' : 'pending', branch: null, base_sha: null })
  const tid = `${id}.level`
  h.store.updateTask(tid, { diagnosis: '{}', worktree: h.repo })
  return { h, id, tid, spec }
}

test('internal repair actually updates ownership and schedules preserved work for re-review', async () => {
  const { h, tid, spec } = repairFixture()
  try {
    const before = readFileSync(join(h.repo, 'README.md'), 'utf8')
    h.store.updateTask(tid, { diagnosis: null })
    h.store.updateRequest(h.store.task(tid)!.request_id, { note: '작업 level 판단 필요' })
    await h.engine.tick()
    const t = h.store.task(tid)!
    assert.equal(t.status, 'rework')
    assert.equal(t.revision, 1)
    assert.equal(t.worktree, h.repo)
    assert.equal(readFileSync(join(h.repo, 'README.md'), 'utf8'), before)
    const updated = JSON.parse(t.spec)
    assert.ok(updated.owns.includes('gameplay/actor.gd'))
    assert.deepEqual(updated.acceptance, spec.acceptance)
    assert.deepEqual(updated.review, spec.review)
    assert.equal(h.store.request(t.request_id)?.note, null, 'obsolete blocked message clears after internal repair')
    assert.equal(h.runner.views().headline.needsYou, 0)
  } finally { await h.close() }
})

test('repair rejects stale decisions, weaker checks/review, external paths and parallel ownership conflicts', async () => {
  const { h, id, tid, spec } = repairFixture()
  try {
    const signature = gameWaitSignature(h.store, h.store.task(tid)!)
    const rev = { ...spec, owns: [...spec.owns, 'gameplay/actor.gd'] }
    assert.ok(h.runner.repairGameTask(tid, rev, 'stale'))
    for (const bad of [
      { ...rev, acceptance: spec.acceptance.map(a => ({ ...a, check: 'manual' })) },
      { ...rev, acceptance: [] },
      { ...rev, review: { model: 'none' as const, brief: '' } },
      { ...rev, owns: ['../outside'] },
      { ...rev, owns: ['/Users/outside'] },
      { ...rev, depends_on: [] },
    ]) assert.ok(h.runner.repairGameTask(tid, bad, signature))
    const parallel = task('parallel', { department: 'gameplay', grade: 'L2', review: { model: 'sonnet', brief: '검토' }, depends_on: ['direction'], owns: ['parallel/**'] })
    h.store.insertTask({ id: `${id}.parallel`, request_id: id, key: 'parallel', project: 'p', title: parallel.title, role: parallel.role,
      grade: parallel.grade, model: parallel.model, review_model: 'sonnet', spec: JSON.stringify(parallel), status: 'pending', branch: null, base_sha: null })
    assert.match(h.runner.repairGameTask(tid, { ...rev, owns: [...rev.owns, 'parallel/actor.gd'] }, signature)!, /병렬/)
    h.store.set('game.enabled:p', 'false')
    assert.ok(h.runner.repairGameTask(tid, rev, signature))
    assert.equal(h.store.task(tid)!.status, 'blocked')
    assert.equal(h.store.task(tid)!.revision, 0)
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
  for (const mode of ['pass', 'auto', 'mutate', 'login', 'leadfail', 'qualityfail', 'unverified', 'missing']) await t.test(mode, async () => {
    const h = harness(), f = fixture()
    try {
      h.projects[0].workflow = 'game'
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=32x32:r=1', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(f.root, 'release/video.mp4')])
      writeFileSync(join(f.root, 'release/screenshot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'))
      for (const file of f.m.files) file.sha256 = createHash('sha256').update(readFileSync(join(f.root, file.path))).digest('hex')
      f.save(); cpSync(join(f.root, 'release'), join(h.repo, 'release'), { recursive: true })
      writeFileSync(join(h.repo, 'test.mjs'), `import assert from 'node:assert/strict'; assert.ok(${JSON.stringify(GAME_CHECKS)}.includes(process.argv[2]));`)
      sh(h.repo, 'add', '-A'); sh(h.repo, 'commit', '-qm', 'release fixture')
      const marker = ['pass', 'auto'].includes(mode) ? '' : `[[FAKE:supervisor${mode}]]`
      const id = h.plan([task('A', { department: 'delivery' })], `release fixture ${marker}`)
      if (mode === 'mutate' || mode === 'login') h.store.set('game.autoDeliver:p', 'true')
      await h.approve(id)
      if (mode === 'pass' || mode === 'auto') {
        await h.waitFor(() => h.store.request(id)?.status === 'awaiting_acceptance', 'release accepted')
        assert.equal(h.store.approval(`accept:${id}`)?.state, 'open')
        assert.ok(h.store.get(`game.release:${id}`))
        const report = h.store.get(`game.report:${id}`)!
        assert.ok(existsSync(join(report, 'lead-approval.json')), 'team leader approved first')
        assert.ok(existsSync(join(report, 'supervisor-approval.json')), 'independent supervisor also approved')
        assert.ok(existsSync(join(report, 'frames/video-1.png')), 'HQ decoded actual video frames')
        const supervisorPrompt = readFileSync(join(report, 'supervisor-prompt.md'), 'utf8')
        assert.ok(!supervisorPrompt.includes('fixture only, no real quality assessed'), 'leader conclusion is not fed to the supervisor')
        if (mode === 'pass') {
          const before = ['lead', 'supervisor'].map(s => statSync(join(report, `${s}-verdict.json`)).mtimeMs)
          // Simulate restart after both approvals were saved but before the final release seal.
          h.store.set(`game.release:${id}`, null)
          h.store.updateRequest(id, { status: 'executing' })
          await h.waitFor(() => h.store.request(id)?.status === 'awaiting_acceptance', 'cached quality approvals reused')
          assert.deepEqual(['lead', 'supervisor'].map(s => statSync(join(report, `${s}-verdict.json`)).mtimeMs), before, 'same candidate must not spend two more model turns')
        }
        assert.ok(existsSync(join(h.runner.integrationDir(id, 'p'), 'release/video.mp4')))
        assert.equal(readGameManifest(h.runner.integrationDir(id, 'p')).problem, null)
        if (mode === 'auto') {
          const signature = h.store.get(`game.release:${id}`)!
          h.store.set('game.autoDeliver:p', 'true')
          h.store.set(`game.release:${id}`, 'stale-verdict')
          await h.runner.tick()
          assert.equal(h.store.request(id)?.status, 'awaiting_acceptance', 'stale supervisor approval cannot auto-deliver')
          h.store.set(`game.release:${id}`, signature)
          h.store.set('game.enabled:p', 'false')
          await h.runner.tick()
          assert.equal(h.store.request(id)?.status, 'awaiting_acceptance', 'disabled team cannot auto-deliver')
          h.store.set('game.enabled:p', 'true')
          await h.waitFor(() => h.store.request(id)?.status === 'merged', 'delegated local delivery')
          assert.equal(h.store.approval(`accept:${id}`)?.decision, '수락')
          assert.equal(h.store.approval(`merge:${id}:p`)?.decision, '병합')
          assert.ok(existsSync(join(h.repo, 'a/out.txt')), 'candidate was merged into the actual project')
          assert.equal(JSON.parse(h.store.get(`game.delivery:${id}`)!).userPlaytested, false)
          assert.equal(sh(h.repo, 'remote'), '', 'local delivery does not create or publish a remote')
        }
      } else if (mode === 'mutate') {
        await h.waitFor(() => Number(h.store.get(`game.rejections:${id}`)) > 0, 'mutation rejected')
        assert.equal(h.store.approval(`accept:${id}`), null)
        assert.match(h.store.task(`${id}.A`)?.note ?? '', /통합 작업 폴더/)
      } else if (mode === 'login') {
        await h.waitFor(() => !!h.store.get('login.required'), 'login hold')
        assert.equal(h.store.request(id)?.status, 'executing')
        assert.equal(h.store.get(`game.rejections:${id}`), null)
        assert.equal(h.store.approval(`accept:${id}`), null)
      } else {
        await h.waitFor(() => Number(h.store.get(`game.rejections:${id}`)) > 0, 'quality rejected')
        assert.equal(h.store.approval(`accept:${id}`), null)
        assert.equal(h.store.get(`game.release:${id}`), null)
        assert.match(h.store.task(`${id}.A`)?.note ?? '', mode === 'leadfail' ? /팀장 1차/ : /피카츄 독립 2차/)
        if (mode === 'leadfail') {
          const { readdirSync } = await import('node:fs')
          const root = join(h.cfg.home, 'runs', id, '_game-supervisor')
          for (const signature of readdirSync(root)) assert.equal(existsSync(join(root, signature, 'supervisor-prompt.md')), false, 'no expensive supervisor turn after leader rejection')
        }
      }
    } finally { await h.close(); rmSync(f.root, { recursive: true, force: true }) }
  })
})

test('invalid collect reviews retry the preserved report and expose it to the game leader', async () => {
  const h = harness()
  try {
    const spec = task('A', { role: 'collect', grade: 'L2', owns: [], brief: '[[FAKE:review=manualall]]',
      acceptance: [{ id: 'R', text: '조사 근거를 확인한다', check: 'manual', kind: 'new' }], review: { model: 'opus', brief: '조사 검토' } })
    const id = h.plan([spec]); await h.approve(id)
    await h.waitFor(() => h.store.task(`${id}.A`)?.status === 'blocked', 'invalid reviews')
    const before = h.store.task(`${id}.A`)!
    const evidence = h.runner.gameTaskEvidence(before.id)
    assert.match(evidence, /## 봉인 조사 보고서/)
    assert.doesNotMatch(evidence, /현재 세대의 검증된 조사 보고서 없음/)
    assert.match(evidence, /검토/)
    // Only change the fake review's response; the completed work and its report stay untouched.
    h.store.updateTask(before.id, { spec: JSON.stringify({ ...spec, brief: '[[FAKE:review=pass]]' }) })
    assert.equal(h.runner.decideTask(before.id, 'retry', before.block_count), null)
    assert.equal(h.store.task(before.id)?.status, 'reviewing')
    assert.equal(h.store.task(before.id)?.report_sha, before.report_sha)
    await h.waitFor(() => h.store.task(before.id)?.status === 'passed', 'new independent review passes')
    assert.equal(h.store.attempts(before.id).filter(a => a.kind === 'work').length, 1)
    assert.equal(h.store.attempts(before.id).filter(a => a.kind === 'review').length, 3)
  } finally { await h.close() }
})

test('game repair adds a missing prerequisite, waits for it, and refuses cycles or removed prerequisites', async () => {
  const { h, id, tid, spec } = repairFixture()
  try {
    const parallel = task('parallel', { department: 'art', grade: 'L2', review: { model: 'sonnet', brief: '검토' }, depends_on: ['direction'], owns: ['parallel/**'] })
    h.store.insertTask({ id: `${id}.parallel`, request_id: id, key: 'parallel', project: 'p', title: parallel.title, role: parallel.role,
      grade: parallel.grade, model: parallel.model, review_model: 'sonnet', spec: JSON.stringify(parallel), status: 'pending', branch: null, base_sha: null })
    const signature = gameWaitSignature(h.store, h.store.task(tid)!)
    assert.ok(h.runner.repairGameTask(tid, { ...spec, depends_on: [...spec.depends_on, 'delivery'] }, signature), 'cycle must fail')
    assert.ok(h.runner.repairGameTask(tid, { ...spec, depends_on: ['parallel'] }, signature), 'old prerequisites cannot be removed')
    const revised = { ...spec, depends_on: [...spec.depends_on, 'parallel'] }
    assert.equal(h.runner.repairGameTask(tid, revised, signature), null)
    const t = h.store.task(tid)!
    assert.equal(t.worktree, h.repo)
    assert.equal(h.store.get(`game.refresh-base:${tid}`), String(t.generation))
    assert.equal(h.runner.depsPassed(t, h.store.tasks(id)), false, 'wait, not another doomed retry')
    h.store.updateTask(`${id}.parallel`, { status: 'passed' })
    assert.equal(h.runner.depsPassed(t, h.store.tasks(id)), true)
  } finally { await h.close() }
})

test('dependency repair refreshes verification base and merges completed assets without discarding existing or dirty work', async () => {
  const h = harness()
  try {
    const a = task('A', { department: 'level' }), b = task('B', { department: 'art' })
    const id = h.plan([a, b]); await h.approve(id)
    await h.waitFor(() => h.store.tasks(id).every(t => t.status === 'passed'))
    const prior = h.store.task(`${id}.A`)!, upstream = h.store.task(`${id}.B`)!
    const preserved = join(prior.worktree!, 'a/preserved.txt')
    writeFileSync(preserved, 'uncommitted work must survive')
    h.projects[0].workflow = 'game'
    h.store.updateRequest(id, { status: 'executing' })
    h.store.updateTask(prior.id, { status: 'revising' })
    assert.equal(h.store.tx(() => h.runner.applyRevision(prior.id, { ...a, depends_on: ['B'] })), null)
    await h.waitFor(() => h.store.task(prior.id)?.status === 'passed', 'refreshed task passed')
    const after = h.store.task(prior.id)!
    assert.equal(after.worktree, prior.worktree)
    assert.equal(after.base_sha, upstream.head_sha)
    assert.equal(readFileSync(preserved, 'utf8'), 'uncommitted work must survive')
    assert.ok(existsSync(join(after.worktree!, 'b/out.txt')), 'approved assets actually arrive in the old checkout')
    assert.equal(sh(after.worktree!, 'merge-base', upstream.head_sha!, 'HEAD'), upstream.head_sha)
    assert.deepEqual(JSON.parse(after.spec).owns, a.owns, 'no asset ownership expansion')
  } finally { await h.close() }
})

test('a revised game contract gets fresh recovery rounds without erasing the lifetime cap', async () => {
  const { h, tid, spec } = repairFixture()
  try {
    h.store.set(`game.decisions:${tid}`, '3')
    assert.equal(h.runner.repairGameTask(tid, { ...spec, brief: spec.brief + ' fix fresh-checkout imports and isolated evidence' }, gameWaitSignature(h.store, h.store.task(tid)!)), null)
    assert.equal(h.store.get(`game.decisions:${tid}`), '0')
    assert.equal(h.store.get(`game.decisions-total:${tid}`), '3')
    h.store.updateTask(tid, { status: 'blocked', diagnosis: '{}', note: 'a different check failed' })
    h.store.set(`game.decisions-total:${tid}`, '9')
    await h.engine.tick()
    assert.match(h.store.task(tid)!.note!, /누적 복구 상한 9회/)
    assert.equal(h.store.get(`game.decisions:${tid}`), '0', 'no paid turn above the lifetime cap')
  } finally { await h.close() }
})
