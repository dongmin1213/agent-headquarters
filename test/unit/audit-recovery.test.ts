import { GAME_PLAY_TOOL_LIMIT, toolBudgetReason } from '../../src/exec/tool-budget.ts'
import { isTransient } from '../../src/exec/contract.ts'
import { StreamTail, extractBashRuns } from '../../src/exec/stream.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { integrate, integrationRef } from '../../src/exec/integration.ts'
import { ensureMirror, mirrorRev } from '../../src/exec/repos.ts'
import { envFailure, plainFailure } from '../../src/exec/checks.ts'
import { commitFile, harness, makeRepo, sh, task, tmp, tsk } from './helpers.ts'

test('integration refuses rewritten target history instead of resurrecting removed commits', async () => {
  const dir = tmp('hq-history-'), repo = makeRepo(join(dir, 'repo'))
  const initial = sh(repo, 'rev-parse', 'HEAD')
  const base = commitFile(repo, 'removed.txt', 'must not resurrect\n')
  const head = commitFile(repo, 'worker.txt', 'work\n')
  sh(repo, 'branch', 'worker-result', head)
  sh(repo, 'reset', '--hard', initial)
  const home = join(dir, 'hq'), path = join(home, 'integration')
  const mirror = await ensureMirror({ id: 'p', path: repo }, join(home, 'repos', 'p.git'))
  const opts = { mirror, requestId: 'r', project: 'p', path, target: 'main', baseSha: base,
    heads: [{ taskId: 'A', title: 'A', sha: head }], setup: null, checks: [], timeoutMs: 10_000,
    sandbox: { worktree: path, out: null, hqHome: home, tokenDir: join(dir, 'tok'), hqPort: 17998, extraWritable: [], projects: [repo] }, profilePath: join(dir, 'i.sb') }
  for (const baseSha of [base, null]) {
    const result = await integrate({ ...opts, baseSha })
    assert.equal(result.kind, 'failed')
    assert.match(result.kind === 'failed' ? result.reason : '', /기준 커밋/)
    assert.equal(existsSync(path), false, 'refuse before creating a merge worktree')
    assert.equal(await mirrorRev(mirror, integrationRef('r', 'p')), null)
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), initial)
    assert.equal(existsSync(join(repo, 'removed.txt')), false)
  }
  // Normal advancement, including a revert commit, is still legitimate history.
  sh(repo, 'reset', '--hard', base)
  sh(repo, 'revert', '--no-edit', base)
  await ensureMirror({ id: 'p', path: repo }, mirror)
  const result = await integrate(opts)
  assert.equal(result.kind, 'ok', JSON.stringify(result))
  if (result.kind === 'ok') assert.equal(sh(mirror, 'ls-tree', '--name-only', result.sha).includes('removed.txt'), false)
})

test('real sandbox profile rejection is environment failure; ordinary tool exit 65 is not', { skip: process.platform !== 'darwin' }, async () => {
  const dir = tmp('hq-sandbox-reject-'), profile = join(dir, 'invalid.sb')
  writeFileSync(profile, '(version 1)\n(this-profile-is-invalid)')
  // Direct launcher reproduction is independent of nested-sandbox test shims.
  let code: number | null = null, output = ''
  try { execFileSync('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/true'], { encoding: 'utf8', stdio: 'pipe' }) }
  catch (e) { const error = e as { status: number; stderr: string }; code = error.status; output = String(error.stderr) }
  assert.equal(code, 65)
  assert.equal(envFailure({ pass: false, exitCode: code, timedOut: false, tail: output }), true)
  assert.equal(plainFailure({ pass: false, exitCode: code, outputTail: output }), false)
  assert.equal(envFailure({ pass: false, exitCode: 65, timedOut: false, tail: 'compiler: bad source' }), false)
  assert.equal(plainFailure({ pass: false, exitCode: 65, outputTail: 'compiler: bad source' }), true)
})


test('connection loss resumes the existing worker thread after persisted backoff without charging a rework', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:networkonce]] [[FAKE:write=a/out.txt]]', review: { brief: '', model: 'none' } })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => tsk(h, tid).status === 'pending' && h.store.attempts(tid).length === 1)
    const first = h.store.attempts(tid)[0]
    assert.equal(first.status, 'transient')
    assert.equal(tsk(h, tid).resume_session, first.session_id)
    assert.equal(tsk(h, tid).attempts, 1)
    assert.equal(h.runner.readyTasks().some(t => t.id === tid), false)
    await h.runner.tick()
    assert.equal(h.store.attempts(tid).length, 1)
    h.clock.t += 60_001
    await h.waitFor(() => tsk(h, tid).status === 'passed')
    const work = h.store.attempts(tid).filter(a => a.kind === 'work')
    assert.equal(work.length, 2)
    assert.equal(work[1].session_id, first.session_id)
    assert.equal(tsk(h, tid).attempts, 1)
    assert.equal(tsk(h, tid).model, 'sonnet')
  } finally { await h.close() }
})

test('repeated review transport failures back off, preserve review budget, and eventually report a block', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:reviewnetwork]] [[FAKE:write=a/out.txt]]' })]), tid = `${id}.A`
    await h.approve(id)
    for (let n = 1; n <= 8; n++) {
      await h.waitFor(() => h.store.attempts(tid).filter(a => a.kind === 'review' && a.status === 'transient').length === n)
      assert.equal(tsk(h, tid).review_invalid, 0)
      const before = h.store.attempts(tid).length
      await h.runner.tick()
      assert.equal(h.store.attempts(tid).length, before)
      h.clock.t += Math.min(15 * 60_000, 60_000 * 2 ** (n - 1)) + 1
    }
    assert.equal(tsk(h, tid).status, 'blocked')
    assert.match(tsk(h, tid).note ?? '', /연결 복구 8회 실패/)
    assert.equal(tsk(h, tid).attempts, 1)
  } finally { await h.close() }
})

test('unexpected judgment loop exception is contained, backs off, and retries without dropping work', async () => {
  const h = harness()
  try {
    const original = h.runner.canStartGameSupervisor.bind(h.runner)
    let calls = 0
    h.runner.canStartGameSupervisor = () => { calls++; throw new Error('injected coordinator I/O failure') }
    await Promise.all([h.engine.tick(), h.engine.tick()])
    assert.equal(calls, 1, 'concurrent ticks share one judgment loop')
    await h.engine.tick()
    assert.equal(calls, 1, 'no tight error loop')
    h.runner.canStartGameSupervisor = () => { calls++; return original() }
    h.clock.t += 30_001
    await h.engine.tick()
    assert.equal(calls, 2)
  } finally { await h.close() }
})


test('restart reads final success and executed tests beyond the former 64 MiB log cutoff', () => {
  const dir = tmp('hq-large-log-'), file = join(dir, 'stream.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'turn.failed', error: { message: 'old reconnect error' } }) + '\n')
  const padding = JSON.stringify({ type: 'ignored', text: 'x'.repeat(1024 * 1024) }) + '\n'
  for (let i = 0; i < 65; i++) appendFileSync(file, padding)
  // Discard one oversized malformed record, then resume at the next whole JSON line.
  appendFileSync(file, 'x'.repeat(9 * 1024 * 1024) + '\n')
  for (const line of [
    { type: 'thread.started', thread_id: 'recovered' },
    { type: 'item.completed', item: { type: 'command_execution', id: 'check', command: 'npm test', status: 'completed', exit_code: 0 } },
    { type: 'item.completed', item: { type: 'agent_message', text: '검증 완료' } },
    { type: 'turn.completed', usage: {} },
  ]) appendFileSync(file, JSON.stringify(line) + '\n')
  const result = new StreamTail(dir).finalResult()
  assert.equal(result?.is_error, false)
  assert.equal(result?.result, '검증 완료')
  assert.deepEqual(extractBashRuns(file), [{ command: 'npm test', exitCode: 0 }])
})


test('transport classification requires a structured error and does not hide application errors', () => {
  assert.equal(isTransient({ is_error: true, api_error_status: 0, result: 'Reconnecting... 5/5 (stream disconnected before completion)' }), true)
  assert.equal(isTransient({ is_error: false, result: 'fixed ECONNRESET handling' }), false)
  assert.equal(isTransient({ is_error: true, api_error_status: 400, result: 'connection closed option is invalid' }), false)
  assert.equal(isTransient({ is_error: true, api_error_status: 0, result: 'invalid model name' }), false)
  assert.equal(isTransient(null, 'workspace routing discovery failed: fetch failed'), true)
  assert.equal(isTransient({ is_error: false }, 'ECONNRESET'), false, 'stderr cannot override a structured successful result')
})

test('sandbox launcher failure on candidate blocks verification without a product rework or base-failure exemption', async () => {
  const h = harness({ repoFiles: { 'README.md': '# test', 'env-check.sh': `if test -f a/out.txt; then
printf 'sandbox-exec: sandbox_apply: Operation not permitted\\n'
exit 65
fi
exit 1
` } })
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'R', text: '실행 환경 분류', kind: 'regression', check: 'sh env-check.sh' }] })])
    assert.equal(await h.approve(id), null)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked')
    const t = tsk(h, `${id}.A`)
    assert.equal(t.attempts, 1)
    assert.equal(t.checks_state, 'error')
    assert.match(t.note ?? '', /샌드박스가 검사 실행을 거부/)
    assert.equal(h.store.attempts(t.id).filter(a => a.kind === 'review').length, 0)
  } finally { await h.close() }
})


test('game input actions have a separate bounded budget, recovered exactly from old stream checkpoints', () => {
  const dir = tmp('hq-play-budget-'), file = join(dir, 'stream.jsonl'), tool = '/trusted/tools/game-play/play.py'
  const event = (command: string) => JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: command, command } }) + '\n'
  const log = event(`python3 ${tool} step --seconds 1`).repeat(210) + event('npm test')
    + event(`echo python3 ${tool} step`) + event(`python3 ${tool} step; npm test`) + event('python3 /other/play.py step')
  writeFileSync(file, log)
  writeFileSync(join(dir, 'tail.json'), JSON.stringify({ offset: Buffer.byteLength(log), toolCount: 214 }))
  const tail = new StreamTail(dir, tool)
  assert.equal(tail.gamePlayCount, 210)
  assert.equal(toolBudgetReason(tail.toolCount, tail.gamePlayCount, 200, true), null)
  assert.match(toolBudgetReason(tail.toolCount, tail.gamePlayCount, 200, false)!, /도구 실행 상한/)
  appendFileSync(file, event(`python3 ${tool} stop`)); tail.poll()
  assert.equal(new StreamTail(dir, tool).gamePlayCount, 211)
  assert.equal(new StreamTail(dir, '/wrong/tool.py').gamePlayCount, 0)
  assert.match(toolBudgetReason(601, GAME_PLAY_TOOL_LIMIT + 1, 200, true)!, /플레이 조작 상한/)
  assert.match(toolBudgetReason(301, 100, 200, true)!, /도구 실행 상한/)
})

test('game watchdog does not kill normal input-heavy verification, but still enforces development budget', async () => {
  const h = harness({ cfg: { maxTurns: 2 } })
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:sleep=60000]]' })])
    await h.approve(id)
    await h.waitFor(() => !!h.store.attempts(`${id}.A`)[0]?.pid)
    h.projects[0].workflow = 'game'
    const a = h.store.attempts(`${id}.A`)[0], live = h.runner.live.get(a.id)!
    live.tail.toolCount = 4; live.tail.gamePlayCount = 2
    await h.runner.tick()
    assert.equal(h.store.attempt(a.id)!.outcome, null)
    live.tail.toolCount = 5
    await h.waitFor(() => h.store.attempt(a.id)!.outcome === 'runaway')
    assert.match(h.store.attempt(a.id)!.reason ?? '', /도구 실행 상한/)
    h.runner.cancelRequest(id)
  } finally { await h.close() }
})
