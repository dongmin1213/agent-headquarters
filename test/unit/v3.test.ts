// Contract v3 tests (exec-engine-spec.md "v3 변경 지시" 1-17): real sandbox-exec, temp repos, fake claude.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateTasks } from '../../src/ceo.ts'
import { DEFAULTS } from '../../src/config.ts'
import { runSandboxed } from '../../src/exec/checks.ts'
import { decisionItems } from '../../src/exec/decisions.ts'
import { atomicWrite } from '../../src/exec/fsx.ts'
import { checkVerdict } from '../../src/exec/review.ts'
import { sandboxProfile } from '../../src/exec/sandbox.ts'
import { commitFile, harness, req, sh, task, tmp, tsk, type Harness } from './helpers.ts'
import { NESTED_SKIP, nestedSandbox, useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

const mgit = (h: Harness, ...args: string[]) => execFileSync('git', ['--git-dir', join(h.runner.home, 'repos', 'p.git'), ...args], { encoding: 'utf8' }).trim()

async function toMergeCard(h: Harness, id: string): Promise<void> {
  await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', `${id} awaiting_acceptance`)
  assert.equal(await h.decide(`accept:${id}`, '수락'), null)
  await h.waitFor(() => h.store.approval(`merge:${id}:p`)?.state === 'open', 'merge card')
}

test('v3-1. escape attempts (hooks, core.fsmonitor, .git gitfile swap, git replace) have no effect through fetch → verify → integrate → merge', { skip: nestedSandbox && NESTED_SKIP }, async () => {
  const mark = tmp('hq-mark-')
  const h = harness()
  try {
    const id = h.plan([task('A', {
      brief: `[[FAKE:write=a/out.txt]] [[FAKE:mark=${mark}]] [[FAKE:evilcheck=1]]`,
      acceptance: [{ id: 'A1', text: 'README 유지', check: 'test -f README.md', kind: 'regression' }, { id: 'A2', text: '검사 스크립트', check: 'sh a/evil.sh', kind: 'new' }],
    })])
    await h.approve(id)
    await toMergeCard(h, id)
    assert.equal(await h.decide(`merge:${id}:p`, '병합'), null)
    assert.equal(req(h, id).status, 'merged')
    assert.deepEqual(readdirSync(mark), [], `no marker files: ${readdirSync(mark).join(', ')}`)
    assert.equal(readFileSync(join(h.repo, 'README.md'), 'utf8'), '# test\n', 'git replace had no effect on the merged result')
    assert.equal(mgit(h, 'for-each-ref', 'refs/replace'), '', 'no replace refs reached the mirror')
    const clone = tsk(h, `${id}.A`).worktree
    assert.ok(clone === null || !existsSync(clone), 'worker clone removed after merge')
  } finally { await h.close() }
})

test('v3-1b. a check cannot write the mirror index (assume-unchanged fails); source changes are caught by the before/after comparison', { skip: nestedSandbox && NESTED_SKIP }, async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [
      { id: 'A1', text: 'index', check: 'git update-index --assume-unchanged README.md', kind: 'regression' },
    ] })])
    await h.approve(id)
    await h.waitFor(() => h.store.attempts(`${id}.A`).some((a) => existsSync(join(a.dir, 'hq', 'checks.json'))), 'checks ran')
    const att = h.store.attempts(`${id}.A`).find((a) => existsSync(join(a.dir, 'hq', 'checks.json')))!
    const checks = JSON.parse(readFileSync(join(att.dir, 'hq', 'checks.json'), 'utf8'))
    const a1 = checks.checks.find((c: { id: string }) => c.id === 'A1')
    // The baseline also failed (mirror index read-only there too), so A1 is handed to the reviewer instead of passing.
    assert.ok(checks.manual.includes('A1') || a1?.pass === false, JSON.stringify(checks))
    assert.equal(h.runner.cancelRequest(id), null)
  } finally { await h.close() }
})

test('v3-2. metadata lstat allowed: node import and npm test succeed in a verification worktree under $HQ_HOME', { skip: nestedSandbox && NESTED_SKIP }, async () => {
  const dir = tmp('hq-meta-')
  const home = join(dir, 'hqhome')
  const wt = join(home, 'worktrees', 'req-1', 'A.v1')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, 'x.js'), 'export const ok = 1\nconsole.log("x-ok")\n')
  writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'm', version: '1.0.0', type: 'module', scripts: { test: 'node x.js' } }))
  const profile = join(dir, 'p.sb')
  atomicWrite(profile, sandboxProfile({ worktree: wt, out: null, hqHome: home, tokenDir: join(dir, 'tok'), hqPort: 17997,
    extraWritable: DEFAULTS.sandbox.extraWritable.map((p) => p.replace(/^~/, homedir())), projects: [] }))
  const imp = await runSandboxed(`node -e "import('./x.js').then(() => console.log('imported'))"`, wt, 30_000, profile)
  assert.equal(imp.pass, true, imp.outputTail)
  assert.match(imp.outputTail, /imported/)
  const npm = await runSandboxed('npm test', wt, 60_000, profile)
  assert.equal(npm.pass, true, npm.outputTail)
  assert.match(npm.outputTail, /x-ok/)
})

test('v3-3. ~/.claude control files are write-protected (fake HOME); runtime dirs and ~/.claude.json stay writable; secrets unreadable', { skip: nestedSandbox && NESTED_SKIP }, async () => {
  const dir = tmp('hq-home-')
  const home = join(dir, 'fakehome')
  const wt = join(dir, 'wt')
  mkdirSync(join(home, '.claude/projects'), { recursive: true }); mkdirSync(join(home, '.ssh'), { recursive: true }); mkdirSync(wt)
  writeFileSync(join(home, '.ssh/id_ed25519'), 'PRIVATE')
  writeFileSync(join(home, '.claude/settings.json'), '{}')
  const profile = join(dir, 'p.sb')
  atomicWrite(profile, sandboxProfile({ worktree: wt, out: null, hqHome: join(dir, 'hq'), tokenDir: join(dir, 'tok'), hqPort: 17996, extraWritable: [], projects: [], home }))
  const run = (cmd: string) => runSandboxed(cmd, wt, 10_000, profile)
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md', '.claude/skills/x.md', '.claude/hooks/x.sh', '.claude/agents/x.md', '.claude/commands/x.md', '.claude/plugins/x.json']) {
    const r = await run(`mkdir -p "$(dirname '${join(home, f)}')" 2>/dev/null; echo x > '${join(home, f)}'`)
    assert.equal(r.pass, false, `${f} must not be writable`)
  }
  assert.equal(readFileSync(join(home, '.claude/settings.json'), 'utf8'), '{}')
  assert.equal((await run(`echo x > '${join(home, '.claude/projects/s.jsonl')}'`)).pass, true, 'projects/ writable')
  assert.equal((await run(`echo x > '${join(home, '.claude.json')}'`)).pass, true, '.claude.json writable')
  assert.equal((await run(`cat '${join(home, '.ssh/id_ed25519')}'`)).pass, false, '~/.ssh unreadable')
  assert.equal((await run('/usr/bin/osascript -e "return 1"')).pass, false, 'osascript denied')
})

test('v3-4. a new-kind check that the work does not implement fails (no baseline exemption)', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'N1', text: '새 기능 파일', check: 'test -f a/feature.txt', kind: 'new' }] })])
    await h.approve(id)
    await h.waitFor(() => h.store.attempts(`${id}.A`).some((a) => existsSync(join(a.dir, 'hq', 'checks.json'))), 'checks ran')
    const att = h.store.attempts(`${id}.A`).find((a) => existsSync(join(a.dir, 'hq', 'checks.json')))!
    const checks = JSON.parse(readFileSync(join(att.dir, 'hq', 'checks.json'), 'utf8'))
    assert.equal(checks.pass, false)
    assert.equal(checks.checks[0].pass, false)
    await h.waitFor(() => tsk(h, `${id}.A`).attempts >= 2 || tsk(h, `${id}.A`).status === 'rework', 'rework')
    assert.equal(h.runner.cancelRequest(id), null)
  } finally { await h.close() }
})

test('v3-5. a regression check failing on the base and again on the candidate becomes manual for the reviewer and "기존 실패" on the accept card', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { acceptance: [{ id: 'R1', text: '기존에 깨진 검사', check: 'test -f missing.txt', kind: 'regression' }] })])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const work = h.store.attempts(`${id}.A`).find((a) => a.kind === 'work' && a.status === 'succeeded')!
    const checks = JSON.parse(readFileSync(join(work.dir, 'hq', 'checks.json'), 'utf8'))
    assert.deepEqual(checks.manual, ['R1'])
    assert.equal(checks.checks.length, 1, 'still run on the candidate')
    assert.equal(checks.checks[0].baseFailed, true)
    assert.equal(checks.pass, true)
    const review = h.store.attempts(`${id}.A`).find((a) => a.kind === 'review')!
    assert.match(readFileSync(join(review.dir, 'hq', 'prompt.md'), 'utf8'), /R1\].*manual .*기존 실패/)
    assert.match(h.store.approval(`accept:${id}`)!.body, /기존 실패\(검토자 판단\): R1/)
  } finally { await h.close() }
})

test('v3-6. tests_run: partial match, pipes, unknown exit and exit≠0 with pass are all invalid', () => {
  const ids = ['A1']
  const v = (tests: unknown[], pass = true) => ({ pass, blocking: pass ? [] : [{ id: 'B', summary: 's', evidence: 'e' }], advisory: [], criteria: [{ id: 'A1', result: pass ? 'pass' : 'fail', evidence: 'e' }], tests_run: tests })
  const k = (raw: unknown, runs: { command: string; exitCode: number | null }[]) => checkVerdict(raw, { acceptanceIds: ids, codeChanged: true, bashRuns: runs })
  assert.equal(k(v([{ command: 'npm test', exit_code: 0, summary: '' }]), [{ command: 'cd pkg && npm test', exitCode: 0 }]).kind, 'invalid', 'partial match')
  assert.equal(k(v([{ command: 'npm test | tail -5', exit_code: 0, summary: '' }]), [{ command: 'npm test | tail -5', exitCode: 0 }]).kind, 'invalid', 'pipe')
  assert.equal(k(v([{ command: 'npm test || true', exit_code: 0, summary: '' }]), [{ command: 'npm test || true', exitCode: 0 }]).kind, 'invalid', '|| true')
  assert.equal(k(v([{ command: 'npm test', exit_code: 1, summary: '' }]), [{ command: 'npm test', exitCode: 1 }]).kind, 'invalid', 'exit 1 with pass')
  assert.equal(k(v([{ command: 'npm test', exit_code: 0, summary: '' }]), [{ command: 'npm test', exitCode: null }]).kind, 'invalid', 'unknown exit code')
  assert.equal(k(v([{ command: 'npm  test', exit_code: 0, summary: '' }]), [{ command: 'npm test', exitCode: 0 }]).kind, 'pass', 'whitespace-normalized exact match')
  assert.equal(k(v([{ command: 'npm test', exit_code: 1, summary: '' }], false), [{ command: 'npm test', exitCode: 1 }]).kind, 'blocking')
})

test('v3-7. validate rejects chained checks (&&, ||, |, ;, backticks, $(, newline) and missing kind', () => {
  const projects = [{ id: 'p', name: 'P', path: '/x' }]
  for (const check of ['npm test && npm run lint', 'a || b', 'npm test | tail', 'a; b', 'echo `x`', 'echo $(x)', 'a\nb']) {
    const t = task('A', { acceptance: [{ id: 'A1', text: 't', check, kind: 'regression' }] })
    assert.match(validateTasks([t], projects) ?? '', /명령 하나/, check)
  }
  assert.equal(validateTasks([task('A', { acceptance: [{ id: 'A1', text: 't', check: 'manual', kind: 'regression' }] })], projects), null)
  assert.match(validateTasks([task('A', { acceptance: [{ id: 'A1', text: 't', check: 'npm test' } as never] })], projects) ?? '', /kind/)
})

test('v3-8. format mistake (no done.json) retries once automatically on the same model; the second one blocks', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:nodone]]' })])
    await h.approve(id)
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'blocked', 'blocked')
    const works = h.store.attempts(`${id}.A`).filter((a) => a.kind === 'work')
    assert.deepEqual(works.map((a) => a.status), ['unverifiable', 'unverifiable'])
    assert.deepEqual(works.map((a) => a.model), ['sonnet', 'sonnet'])
    assert.equal(tsk(h, `${id}.A`).attempts, 2, 'the retry counts as an attempt')
  } finally { await h.close() }
})

test('v3-9. generation: a result that arrives after the task moved to a new generation is not applied', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:write=a/out.txt]] [[FAKE:sleep=800]]' })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => h.store.attempts(tid)[0]?.status === 'running', 'running')
    const t = tsk(h, tid)
    // Invalidation raced with the attempt: generation moves on while the old process is still finishing normally.
    h.store.updateTask(tid, { generation: t.generation + 1, status: 'blocked', block_count: 1, note: 'test' })
    await h.waitFor(() => h.store.attempts(tid)[0].status !== 'running', 'old attempt ended')
    const a1 = h.store.attempts(tid)[0]
    assert.equal(a1.status, 'failed')
    assert.match(a1.reason!, /세대/)
    assert.equal(tsk(h, tid).status, 'blocked', 'task state untouched by the late result')
    assert.equal(tsk(h, tid).head_sha, null)
    assert.ok(existsSync(join(a1.dir, 'out', 'done.json')), 'the late result was a normal success')
  } finally { await h.close() }
})

test('v3-11. re-sending the same decision returns the same response and transitions once', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A')])
    const a = h.store.approval(`plan:${id}`)!
    const [r1, r2] = await Promise.all([h.runner.decide(a.id, '승인', a.subjectHash), h.runner.decide(a.id, '승인', a.subjectHash)])
    const r3 = await h.runner.decide(a.id, '승인', a.subjectHash)
    assert.equal(r1.status, 200)
    assert.deepEqual(r3, r1)
    assert.ok(r2.status === 200 ? JSON.stringify(r2) === JSON.stringify(r1) : r2.status === 409)
    assert.equal(h.store.tasks(id).length, 1, 'tasks created once')
    assert.equal((await h.runner.decide(a.id, '반려', a.subjectHash)).status, 409, 'a different decision is refused')
  } finally { await h.close() }
})

test('v3-12. accept card 반려 is refused (409); /reject needs the reason and the card subject', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A')])
    await h.approve(id)
    await h.waitFor(() => req(h, id).status === 'awaiting_acceptance', 'awaiting_acceptance')
    const card = h.store.approval(`accept:${id}`)!
    const r = await h.runner.decide(card.id, '반려', card.subjectHash)
    assert.equal(r.status, 409)
    assert.match(String(r.body.error), /사유와 함께 반려 버튼/)
    assert.equal(h.store.approval(card.id)!.state, 'open')
    assert.match(h.runner.rejectResult(id, '다시', 'stale-hash')!, /바뀌었습니다/)
    assert.equal(h.runner.rejectResult(id, '다시', card.subjectHash), null)
    assert.equal(req(h, id).status, 'executing')
  } finally { await h.close() }
})

test('v3-13/14. overageStatus is not a signal; a rejection without resetsAt waits 15 then 30 minutes', async () => {
  const h = harness()
  try {
    const now = Math.floor(h.clock.t / 1000)
    h.runner.observe({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected', rateLimitType: 'five_hour', resetsAt: now + 3600,
      unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: now + 3600 } } } })
    assert.equal(h.runner.quota().mode, 'normal')
    h.runner.observe({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' } })
    assert.equal(h.runner.quota().mode, 'hold')
    assert.equal(h.runner.holdUntil(), new Date(h.clock.t + 15 * 60_000).toISOString())
    h.clock.t += 16 * 60_000
    assert.notEqual(h.runner.quota().mode, 'hold')
    h.runner.observe({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' } })
    assert.equal(h.runner.holdUntil(), new Date(h.clock.t + 30 * 60_000).toISOString())
  } finally { await h.close() }
})

test('v3-15. "Not logged in" → global hold and one system:login card (first in order); deciding it releases the hold', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '[[FAKE:nologin]]' })])
    await h.approve(id)
    await h.waitFor(() => h.store.approval('system:login')?.state === 'open', 'login card')
    const items = decisionItems(h.store, h.clock.t)
    assert.equal(items[0].kind, 'system')
    assert.equal(items[0].requestId, '')
    assert.equal(items[0].taskId, null)
    assert.deepEqual(items[0].options, ['다시 확인'])
    assert.equal(items[0].situation, 'Claude CLI에 로그인되어 있지 않아 모든 작업을 멈췄어요')
    assert.equal(items[0].causeConfirmed, true)
    assert.deepEqual(items[0].optionHelp, { '다시 확인': '로그인 후 누르면 다음 작업부터 다시 시도해요' })
    assert.equal(h.runner.quota().mode, 'hold')
    assert.equal(tsk(h, `${id}.A`).status, 'held')
    assert.equal(h.store.attempts(`${id}.A`).length, 1)
    assert.equal(await h.decide('system:login', '다시 확인'), null)
    assert.notEqual(h.runner.quota().mode, 'hold')
    assert.equal(h.runner.cancelRequest(id), null)
  } finally { await h.close() }
})

test('v3-16. save mode: one process in total and the CEO goes first', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A')])
    await h.approve(id)
    h.runner.stop()
    ;(h.runner as unknown as { stopped: boolean }).stopped = false
    h.store.setQuotaWindow({ window: 'five_hour', utilization: 0.9, resets_at: new Date(h.clock.t + 3600_000).toISOString(), status: 'allowed', observed_at: new Date(h.clock.t).toISOString() })
    assert.equal(h.runner.quota().mode, 'save')
    h.store.addRequest('req-ceo00001', 'p', 'CEO가 먼저 볼 요청')
    for (let i = 0; i < 3; i++) await h.runner.tick()
    assert.equal(h.store.attempts(`${id}.A`).length, 0, 'no worker while a CEO turn waits')
    assert.equal(h.runner.canStartCeo(), true)
    h.store.updateRequest('req-ceo00001', { status: 'cancelled' })
    await h.waitFor(() => h.store.attempts(`${id}.A`).length > 0, 'worker starts once the CEO queue is empty')
    await h.waitFor(() => h.store.liveAttempts().length > 0 || tsk(h, `${id}.A`).status !== 'running', 'live')
    if (h.store.liveAttempts().length) assert.equal(h.runner.canStartCeo(), false, 'save mode: CEO waits while a worker runs')
  } finally { await h.close() }
})

test('v3-17. merge recovery: HEAD == integration → merged; HEAD == target → card again; otherwise stale → re-integration', async () => {
  for (const kase of ['merged', 'target', 'other'] as const) {
    const h = harness()
    try {
      const id = h.plan([task('A')])
      await h.approve(id)
      await toMergeCard(h, id)
      const m = h.store.mergeRow(id, 'p')!
      const card = h.store.approval(`merge:${id}:p`)!
      // Crash right after the intent was recorded.
      h.store.tx(() => { h.store.decide(card.id, '병합', card.subjectHash, h.clock.t); h.store.updateRequest(id, { status: 'merging' }); h.store.putMerge(id, 'p', { state: 'merging' }) })
      if (kase === 'merged') {
        sh(h.repo, 'fetch', '-q', join(h.runner.home, 'repos', 'p.git'), `refs/hq/integration/${id}/p`)
        sh(h.repo, 'merge', '-q', '--ff-only', m.integration_sha!)
      } else if (kase === 'other') commitFile(h.repo, 'user.txt', 'u\n', 'user commit')
      h.runner.stop()
      const { Runner } = await import('../../src/exec/runner.ts')
      const { ROOT } = await import('./helpers.ts')
      const r2 = new Runner({ store: h.store, bus: h.bus, cfg: h.cfg, projects: h.projects, hqRoot: ROOT, hqPort: 17999, notify: () => {}, now: () => h.clock.t, tokenDir: join(h.dir, 'tok') })
      ;(h as { runner: Runner }).runner = r2
      await r2.recover()
      if (kase === 'merged') {
        assert.equal(h.store.mergeRow(id, 'p')!.state, 'merged')
        assert.equal(req(h, id).status, 'merged')
      } else if (kase === 'target') {
        assert.equal(req(h, id).status, 'accepted')
        await h.waitFor(() => h.store.approval(`merge:${id}:p`)!.state === 'open', 'card re-offered')
        assert.equal(h.store.mergeRow(id, 'p')!.integration_sha, m.integration_sha)
      } else {
        assert.equal(h.store.mergeRow(id, 'p')!.state, 'pending')
        await h.waitFor(() => h.store.approval(`merge:${id}:p`)!.state === 'open', 'new card after re-integration')
        assert.notEqual(h.store.mergeRow(id, 'p')!.integration_sha, m.integration_sha)
      }
    } finally { await h.close() }
  }
})
