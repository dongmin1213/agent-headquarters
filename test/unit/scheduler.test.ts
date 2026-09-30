// Scheduler must survive team commands that cannot be spawned (live crash: ENOENT with no 'error' listener killed the daemon).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Bus } from '../../src/bus.ts'
import { Scheduler } from '../../src/scheduler.ts'
import { Store } from '../../src/store.ts'
import type { TeamConfig } from '../../src/types.ts'
import { tmp } from './helpers.ts'

function setup(team: Partial<TeamConfig>) {
  const dir = tmp('hq-sched-')
  const store = new Store(join(dir, 'hq.db'))
  const bus = new Bus(store)
  const t: TeamConfig = { id: 'revenue', name: '수익', pack: 'digimon', command: ['/bin/sh', '-c', 'exit 0'], cwd: dir, everyMinutes: 60, enabled: true, ...team }
  const sched = new Scheduler([t], store, bus, 'http://127.0.0.1:1', 'tok', { holdUntil: () => null, teamLimited: () => {} })
  return { dir, store, sched }
}

async function ended(store: Store, n: number): Promise<void> {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    const r = store.lastRun('revenue')
    if (r && r.id >= n && r.endedAt) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('run did not end')
}

test('missing command: run ends with -1 and error bubble, daemon survives, rerun works', async () => {
  const { store, sched } = setup({ command: ['/nonexistent/bin/x'] })
  assert.equal(sched.runNow('revenue'), true)
  await ended(store, 1)
  const r = store.lastRun('revenue')!
  assert.equal(r.exitCode, -1)
  assert.match(r.summary ?? '', /ENOENT/)
  const v = sched.views()[0]
  assert.equal(v.state, 'error')
  assert.match(v.bubble, /실행할 수 없어요/)
  assert.match(v.bubble, /ENOENT/)
  assert.ok(v.bubble.length <= 140)
  assert.equal(sched.runNow('revenue'), true, 'running flag reset')
  await ended(store, 2)
  assert.equal(store.lastRun('revenue')!.exitCode, -1)
  // give a stray late 'close' a chance to double-end the run
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(store.lastRun('revenue')!.id, 2)
  store.close()
})

test('invalid cwd: same handling, no crash', async () => {
  const { dir, store, sched } = setup({ cwd: join(tmp('hq-sched-'), 'gone', 'nowhere') })
  void dir
  assert.equal(sched.runNow('revenue'), true)
  await ended(store, 1)
  assert.equal(store.lastRun('revenue')!.exitCode, -1)
  const v = sched.views()[0]
  assert.equal(v.state, 'error')
  assert.match(v.bubble, /실행할 수 없어요/)
  assert.equal(sched.runNow('revenue'), true)
  await ended(store, 2)
  store.close()
})

test('disabled team: runNow refuses and nothing runs', async () => {
  const { store, sched } = setup({ enabled: false })
  assert.equal(sched.runNow('revenue'), false)
  await new Promise((res) => setTimeout(res, 50))
  assert.equal(store.lastRun('revenue'), null)
  assert.equal(sched.views()[0].state, 'idle')
  store.close()
})

test('normal command still completes idle', async () => {
  const { store, sched } = setup({ command: ['/bin/sh', '-c', 'echo "STATUS: 끝"; exit 0'] })
  assert.equal(sched.runNow('revenue'), true)
  await ended(store, 1)
  assert.equal(store.lastRun('revenue')!.exitCode, 0)
  assert.equal(sched.views()[0].state, 'idle')
  assert.equal(sched.views()[0].bubble, '끝')
  store.close()
})

// Daemon restart: team state is restored from the last recorded run instead of resetting to '대기 중'.
function restarted(seed: (store: Store) => void, team: Partial<TeamConfig> = {}) {
  const dir = tmp('hq-sched-')
  const path = join(dir, 'hq.db')
  const before = new Store(path)
  seed(before)
  before.close()
  const store = new Store(path)
  const t: TeamConfig = { id: 'revenue', name: '수익', pack: 'digimon', command: ['/bin/sh', '-c', 'exit 0'], cwd: dir, everyMinutes: 60, enabled: true, ...team }
  const sched = new Scheduler([t], store, new Bus(store), 'http://127.0.0.1:1', 'tok', { holdUntil: () => null, teamLimited: () => {} })
  const v = sched.views()[0]
  store.close()
  return v
}
const finished = (exit: number, summary: string) => (s: Store) => { s.endRun(s.startRun('revenue'), 0, 'old'); s.endRun(s.startRun('revenue'), exit, summary) }

test('restore: exit 0 → idle with last STATUS', () => {
  const v = restarted(finished(0, 'STATUS: 조사 중\n로그\nSTATUS: 대본 준비 완료: X\n끝'))
  assert.equal(v.state, 'idle'); assert.equal(v.bubble, '대본 준비 완료: X')
  assert.equal(restarted(finished(0, '로그만')).bubble, '완료')
})

test('restore: exit 3 → waiting', () => {
  const v = restarted(finished(3, 'STATUS: 승인 요청 보냄'))
  assert.equal(v.state, 'waiting'); assert.equal(v.bubble, '승인 요청 보냄')
  assert.equal(restarted(finished(3, '')).bubble, '승인 대기')
})

test('restore: exit 75 → sleeping', () => {
  const v = restarted(finished(75, 'limit'))
  assert.equal(v.state, 'sleeping'); assert.equal(v.bubble, '사용 한도, 쉬는 중')
})

test('restore: spawn failure (-1) → error with the failure text; other codes → 오류 bubble', () => {
  const v = restarted(finished(-1, '실행할 수 없어요: ENOENT (/nonexistent/bin/x)'))
  assert.equal(v.state, 'error'); assert.equal(v.bubble, '실행할 수 없어요: ENOENT (/nonexistent/bin/x)')
  const e = restarted(finished(2, 'a\nboom'))
  assert.equal(e.state, 'error'); assert.equal(e.bubble, '오류 (종료 코드 2): boom')
})

test('restore: unfinished run → idle with 중단 bubble', () => {
  const v = restarted((s) => { s.endRun(s.startRun('revenue'), 3, 'STATUS: x'); s.startRun('revenue') })
  assert.equal(v.state, 'idle'); assert.equal(v.bubble, '지난 실행이 중단됐어요 · 다음 실행 때 이어서 해요')
})

test('restore: no runs → 대기 중; disabled team keeps 대기 중', () => {
  const v = restarted(() => {})
  assert.equal(v.state, 'idle'); assert.equal(v.bubble, '대기 중')
  const d = restarted(finished(2, 'boom'), { enabled: false })
  assert.equal(d.state, 'idle'); assert.equal(d.bubble, '대기 중')
})
