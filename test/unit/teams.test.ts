// Recurring teams: scoped per-run API token, isolated execution, adoption after a daemon restart, wall-clock limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bus } from '../../src/bus.ts'
import { INTERRUPTED, Scheduler, UNCONFIRMED, type TeamIsolation } from '../../src/scheduler.ts'
import { startServer } from '../../src/server.ts'
import { Store } from '../../src/store.ts'
import { pidAlive, psLstart } from '../../src/exec/worker.ts'
import type { TeamConfig } from '../../src/types.ts'
import { harness, tmp } from './helpers.ts'
import { NESTED_SKIP, nestedSandbox, useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

// Inside a sandbox `ps` (setuid) cannot run; identity then comes from a stand-in that still tracks liveness.
const ps = nestedSandbox ? async (pid: number) => (pidAlive(pid) ? `fake-${pid}` : null) : psLstart
const quota = { holdUntil: () => null, teamLimited: () => {} }
const team = (dir: string, script: string, o: Partial<TeamConfig> = {}): TeamConfig =>
  ({ id: 'revenue', name: '수익', pack: 'digimon', command: ['/bin/sh', '-c', script], cwd: dir, everyMinutes: 60, enabled: true, ...o })
const iso = (dir: string, o: Partial<TeamIsolation> = {}): TeamIsolation => ({ hqHome: join(dir, 'home'), tokenDir: join(dir, 'tokens'), pollMs: 50, ps, ...o })

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error(`timeout: ${what}`)
}
const ended = (store: Store, id: number) => until(() => { const r = store.lastRun('revenue'); return !!r && r.id >= id && !!r.endedAt }, `run ${id} ends`)

test('scoped team token: quota and own cards only, never decisions or state; revoked after the run', async () => {
  const h = harness()
  const dir = h.dir
  const port = 30000 + Math.floor(Math.random() * 20000)
  const MASTER = 'master-token-abc'
  // The run publishes its token, then waits for the test to release it.
  const t = team(dir, 'printf %s "$HQ_TOKEN" > team-token.txt; while [ ! -f release ]; do sleep 0.05; done; exit 0')
  const sched = new Scheduler([t], h.store, h.bus, `http://127.0.0.1:${port}`, iso(dir, { hqHome: h.cfg.home }), quota)
  const server = startServer({ port, store: h.store, bus: h.bus, scheduler: sched, token: MASTER, engine: h.engine, runner: h.runner, projects: h.projects })
  await new Promise((r) => server.once('listening', r))
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: await r.json() as any }
  }
  try {
    // Chairman cards of every kind exist.
    h.store.upsertApproval({ id: 'team:revenue:c1', teamId: 'revenue', title: 't', body: '', options: ['승인', '반려'], subjectHash: 'h1', expiresAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: new Date().toISOString() })
    assert.equal(sched.runNow('revenue'), true)
    await until(() => existsSync(join(dir, 'team-token.txt')) && readFileSync(join(dir, 'team-token.txt'), 'utf8').length > 0, 'token written')
    const tok = readFileSync(join(dir, 'team-token.txt'), 'utf8')
    assert.notEqual(tok, MASTER)
    assert.equal(sched.teamOfToken(tok), 'revenue')

    assert.equal((await call(tok, 'GET', '/api/quota')).status, 200)
    const state = await call(tok, 'GET', '/api/state')
    assert.equal(state.status, 403)
    assert.equal(state.body.error, '팀 토큰으로는 할 수 없는 요청이에요')
    assert.equal((await call(tok, 'GET', '/api/events')).status, 403)
    assert.equal((await call(tok, 'POST', '/api/ui-code')).status, 403)
    assert.equal((await call(tok, 'POST', '/api/teams/revenue/run')).status, 403)
    assert.equal((await call(tok, 'POST', '/api/requests', { text: 'x' })).status, 403)
    for (const id of ['plan:r1', 'accept:r1', 'merge:r1', 'team:revenue:c1', 'team:other:c1'])
      assert.equal((await call(tok, 'POST', `/api/approvals/${encodeURIComponent(id)}`, { decision: '승인', subjectHash: 'h1' })).status, 403, id)
    for (const id of ['plan:r1', 'team:other:c1', 'team:revenuex:c1'])
      assert.equal((await call(tok, 'GET', `/api/approvals/${encodeURIComponent(id)}`)).status, 403, id)
    // Own cards: create and read back.
    const card = { id: 'team:revenue:c2', teamId: 'revenue', title: '대본 승인', subjectHash: 'h2', options: ['승인', '반려'] }
    assert.equal((await call(tok, 'POST', '/api/approvals', card)).status, 201)
    assert.equal((await call(tok, 'POST', '/api/approvals', { ...card, id: 'team:other:c2', teamId: 'other' })).status, 403)
    const own = await call(tok, 'GET', `/api/approvals/${encodeURIComponent('team:revenue:c2')}`)
    assert.equal(own.status, 200); assert.equal(own.body.decision, null)
    assert.equal(h.store.approval('team:revenue:c1')!.decision, null, 'team could not decide')
    // The chairman (master token) still can.
    assert.equal((await call(MASTER, 'POST', `/api/approvals/${encodeURIComponent('team:revenue:c2')}`, { decision: '승인', subjectHash: 'h2' })).status, 200)
    assert.equal((await call(MASTER, 'GET', '/api/state')).status, 200)

    writeFileSync(join(dir, 'release'), '')
    await ended(h.store, 1)
    assert.equal(h.store.lastRun('revenue')!.exitCode, 0)
    assert.equal(sched.teamOfToken(tok), null, 'revoked in memory')
    assert.equal((await call(tok, 'GET', '/api/quota')).status, 401, 'revoked at the API')
  } finally {
    sched.stop()
    server.close()
    await h.close()
  }
})

test('team env: no daemon token file, no *_TOKEN/*_KEY/ANTHROPIC_/OPENAI_ vars; HQ_URL/HQ_TEAM/scoped HQ_TOKEN present', async () => {
  const dir = tmp('hq-teams-')
  const store = new Store(join(dir, 'home', 'hq.db'))
  const saved = { ...process.env }
  Object.assign(process.env, { HQ_TOKEN_FILE: '/x/token', HQ_TOKEN: 'master', FAKE_API_KEY: 'k', GH_TOKEN: 'g', ANTHROPIC_BASE_URL: 'a', OPENAI_ORG: 'o', KEEP_ME: '1' })
  try {
    const t = team(dir, 'for v in HQ_TOKEN_FILE FAKE_API_KEY GH_TOKEN ANTHROPIC_BASE_URL OPENAI_ORG; do eval "[ -z \\"\\${$v}\\" ]" || { echo "leak $v"; exit 12; }; done; [ "$KEEP_ME" = 1 ] || exit 13; [ "$HQ_TEAM" = revenue ] && [ "$HQ_URL" = http://127.0.0.1:1 ] && [ -n "$HQ_TOKEN" ] && [ "$HQ_TOKEN" != master ] || exit 14; exit 0')
    const sched = new Scheduler([t], store, new Bus(store), 'http://127.0.0.1:1', iso(dir), quota)
    assert.equal(sched.runNow('revenue'), true)
    await ended(store, 1)
    assert.equal(store.lastRun('revenue')!.exitCode, 0, store.lastRun('revenue')!.summary ?? '')
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    store.close()
  }
})

test('team profile: the command cannot read the token file or $HQ_HOME/hq.db, cannot write $HQ_HOME; its own cwd works', { skip: nestedSandbox && NESTED_SKIP }, async () => {
  const dir = tmp('hq-teams-')
  const home = join(dir, 'home')
  const tokens = join(dir, 'tokens')
  mkdirSync(tokens, { recursive: true })
  writeFileSync(join(tokens, 'token'), 'secret-master')
  const store = new Store(join(home, 'hq.db'))
  try {
    const t = team(dir, `cat "${tokens}/token" && exit 10; head -c1 "${home}/hq.db" >/dev/null && exit 11; echo x > "${home}/evil" && exit 12; echo ok > mine || exit 13; echo "STATUS: 막힘 확인"; exit 0`)
    const sched = new Scheduler([t], store, new Bus(store), 'http://127.0.0.1:1', iso(dir), quota)
    assert.equal(sched.runNow('revenue'), true)
    await ended(store, 1)
    const r = store.lastRun('revenue')!
    assert.equal(r.exitCode, 0, r.summary ?? '')
    assert.doesNotMatch(r.summary ?? '', /secret-master/)
    assert.match(r.summary ?? '', /Operation not permitted/)
    assert.equal(existsSync(join(home, 'evil')), false)
    assert.equal(readFileSync(join(dir, 'mine'), 'utf8'), 'ok\n')
  } finally { store.close() }
})

test('restart: a live run is adopted (no duplicate), keeps its token, and ends with the real exit code from the log', async () => {
  const dir = tmp('hq-teams-')
  const db = join(dir, 'home', 'hq.db')
  const t = team(dir, 'echo $$ >> pids; printf %s "$HQ_TOKEN" > team-token.txt; echo "STATUS: 반쯤"; while [ ! -f release ]; do sleep 0.05; done; echo "STATUS: 승인 요청 보냄"; exit 3')
  const s1store = new Store(db)
  const s1 = new Scheduler([t], s1store, new Bus(s1store), 'http://127.0.0.1:1', iso(dir), quota)
  assert.equal(s1.runNow('revenue'), true)
  await until(() => existsSync(join(dir, 'team-token.txt')) && readFileSync(join(dir, 'team-token.txt'), 'utf8').length > 0, 'first run started')
  await until(() => s1store.runProcess(1)?.lstart != null, 'lstart recorded')
  s1.stop(); s1store.close() // daemon goes away; the detached run keeps going

  const store = new Store(db)
  const s2 = new Scheduler([t], store, new Bus(store), 'http://127.0.0.1:1', iso(dir), quota)
  s2.start()
  try {
    await s2.ready
    let v = s2.views()[0]
    assert.equal(v.state, 'working'); assert.equal(v.bubble, '반쯤')
    assert.equal(s2.runNow('revenue'), false, 'no second run while the adopted one lives')
    assert.equal(s2.teamOfToken(readFileSync(join(dir, 'team-token.txt'), 'utf8')), 'revenue', 'adopted run keeps API access')
    writeFileSync(join(dir, 'release'), '')
    await ended(store, 1)
    const r = store.lastRun('revenue')!
    assert.equal(r.id, 1); assert.equal(r.exitCode, 3)
    v = s2.views()[0]
    assert.equal(v.state, 'waiting'); assert.equal(v.bubble, '승인 요청 보냄')
    assert.equal(readFileSync(join(dir, 'pids'), 'utf8').trim().split('\n').length, 1, 'exactly one process ever ran')
    assert.equal(s2.teamOfToken(readFileSync(join(dir, 'team-token.txt'), 'utf8')), null)
  } finally { s2.stop(); store.close() }
})

/** An unfinished run as a previous daemon left it: pid/lstart in the DB and (optionally) a log. */
function seed(dir: string, pid: number, lstart: string | null, log: string | null): string {
  const db = join(dir, 'home', 'hq.db')
  const s = new Store(db)
  const id = s.startRun('revenue')
  s.setRunProcess(id, pid, lstart, 'deadbeef')
  s.close()
  if (log !== null) { mkdirSync(join(dir, 'home', 'logs', 'teams', 'revenue'), { recursive: true }); writeFileSync(join(dir, 'home', 'logs', 'teams', 'revenue', `${id}.log`), log) }
  return db
}
const DEAD_PID = 999_999 // above macOS's pid limit: never alive

test('restart: the process died but left its exit marker → that exit code is recorded', async () => {
  const dir = tmp('hq-teams-')
  const store = new Store(seed(dir, DEAD_PID, 'Wed Sep 30 10:00:00 2026', 'STATUS: 조사 중\nSTATUS: 대본 준비 완료\n__HQ_EXIT__ 0\n'))
  const s = new Scheduler([team(dir, 'exit 0')], store, new Bus(store), 'http://127.0.0.1:1', iso(dir), quota)
  await s.ready
  const r = store.lastRun('revenue')!
  assert.equal(r.exitCode, 0); assert.ok(r.endedAt)
  assert.equal(s.views()[0].state, 'idle'); assert.equal(s.views()[0].bubble, '대본 준비 완료')
  store.close()
})

test('restart: the process died without a marker → -1 with the 중단 bubble (also after another restart)', async () => {
  const dir = tmp('hq-teams-')
  const db = seed(dir, DEAD_PID, 'Wed Sep 30 10:00:00 2026', 'STATUS: 조사 중\n')
  let store = new Store(db)
  const s = new Scheduler([team(dir, 'exit 0')], store, new Bus(store), 'http://127.0.0.1:1', iso(dir), quota)
  await s.ready
  assert.equal(store.lastRun('revenue')!.exitCode, -1)
  assert.deepEqual([s.views()[0].state, s.views()[0].bubble], ['idle', INTERRUPTED])
  store.close()
  store = new Store(db)
  const again = new Scheduler([team(dir, 'exit 0')], store, new Bus(store), 'http://127.0.0.1:1', iso(dir), quota).views()[0]
  assert.deepEqual([again.state, again.bubble], ['idle', INTERRUPTED])
  store.close()
})

test('restart: pid alive but identity unconfirmable → no new run, error bubble, never signalled; resolves once the pid is gone', async () => {
  const dir = tmp('hq-teams-')
  const other = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
  other.unref()
  const store = new Store(seed(dir, other.pid!, null, 'STATUS: x\n'))
  // lstart was never recorded (ps failed at spawn), so a live pid could be anyone.
  const t = team(dir, 'echo started >> started; exit 0', { timeoutMinutes: 0.001, everyMinutes: 0 })
  const s = new Scheduler([t], store, new Bus(store), 'http://127.0.0.1:1', iso(dir), quota)
  try {
    s.start()
    await s.ready
    assert.deepEqual([s.views()[0].state, s.views()[0].bubble], ['error', UNCONFIRMED])
    assert.equal(s.runNow('revenue'), false)
    ;(s as unknown as { tick(): void }).tick()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(existsSync(join(dir, 'started')), false, 'no new run')
    assert.equal(pidAlive(other.pid!), true, 'never signalled (not even on timeout)')
    assert.equal(store.lastRun('revenue')!.endedAt, null)
    other.kill('SIGKILL')
    await until(() => !pidAlive(other.pid!), 'sleep gone')
    ;(s as unknown as { tick(): void }).tick() // the old pid is gone: the run is closed and the (due) team starts again
    assert.equal(store.runProcess(1) && store.lastRun('revenue')!.id >= 1, true)
    await until(() => existsSync(join(dir, 'started')), 'next run after the old pid disappeared')
    await ended(store, 2)
  } finally { s.stop(); store.close(); try { other.kill('SIGKILL') } catch { /* gone */ } }
})

test('restart: ps unavailable while the pid is alive → unconfirmed as well; a different start time → treated as gone (pid reused), never signalled', async () => {
  const dir = tmp('hq-teams-')
  const other = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
  other.unref()
  try {
    let store = new Store(seed(dir, other.pid!, 'Wed Sep 30 10:00:00 2026', ''))
    let s = new Scheduler([team(dir, 'exit 0')], store, new Bus(store), 'http://127.0.0.1:1', iso(dir, { ps: async () => null }), quota)
    await s.ready
    assert.deepEqual([s.views()[0].state, s.views()[0].bubble], ['error', UNCONFIRMED])
    s.stop(); store.close()

    const dir2 = tmp('hq-teams-')
    store = new Store(seed(dir2, other.pid!, 'Thu Jan  1 00:00:00 2026', ''))
    s = new Scheduler([team(dir2, 'exit 0')], store, new Bus(store), 'http://127.0.0.1:1', iso(dir2, { ps: async () => 'Wed Sep 30 11:11:11 2026' }), quota)
    await s.ready
    assert.equal(store.lastRun('revenue')!.exitCode, -1)
    assert.equal(s.views()[0].bubble, INTERRUPTED)
    assert.equal(pidAlive(other.pid!), true)
    s.stop(); store.close()
  } finally { other.kill('SIGKILL') }
})

test('timeout: SIGTERM then SIGKILL to the whole process group, run ends -1 with 시간 초과', async () => {
  const dir = tmp('hq-teams-')
  const store = new Store(join(dir, 'home', 'hq.db'))
  // Ignores SIGTERM (inherited by its background child), so only the group SIGKILL ends it.
  const t = team(dir, 'trap "" TERM; /bin/sleep 30 & echo $! > child; echo "STATUS: 오래 걸림"; while :; do sleep 0.1; done', { timeoutMinutes: 0.01 })
  const s = new Scheduler([t], store, new Bus(store), 'http://127.0.0.1:1', iso(dir, { killGraceMs: 300 }), quota)
  try {
    assert.equal(s.runNow('revenue'), true)
    await until(() => existsSync(join(dir, 'child')) && readFileSync(join(dir, 'child'), 'utf8').trim().length > 0, 'child started')
    const child = Number(readFileSync(join(dir, 'child'), 'utf8'))
    await ended(store, 1)
    const r = store.lastRun('revenue')!
    assert.equal(r.exitCode, -1)
    assert.match(r.summary ?? '', /시간 초과\(0\.01분\)$/)
    assert.equal(s.views()[0].state, 'error'); assert.equal(s.views()[0].bubble, '시간 초과(0.01분)')
    await until(() => !pidAlive(child), 'background child killed with the group', 3000)
  } finally { s.stop(); store.close() }
})
