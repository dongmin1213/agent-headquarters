// §G 2: completion judgement (execution.md §8).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DONE_MAX, judgeWork, ownsMatch, readOut, readOutResult, type WorkFacts } from '../../src/exec/contract.ts'
import { DEFAULTS } from '../../src/config.ts'
import { tmp } from './helpers.ts'

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40)
const summary = (n: number) => `## 요약\n${'가'.repeat(n)}\n\n## 기준\n- ok\n`
const done = (o: Record<string, unknown> = {}) => JSON.stringify({ attempt_token: 'tok', outcome: 'succeeded', head_sha: HEAD, files_modified: ['src/a.ts'], summary: 's', questions: [], ...o })
const facts = (o: Partial<WorkFacts> = {}, g: Partial<NonNullable<WorkFacts['git']>> = {}): WorkFacts => ({
  role: 'implement', token: 'tok', owns: ['src/**'], protectedPaths: DEFAULTS.protectedPaths, base: BASE, runaway: false,
  result: { type: 'result', subtype: 'success', is_error: false, result: 'ok' }, stderr: '', rejectedSeen: false,
  doneRaw: done(), report: summary(200),
  git: { head: HEAD, changed: ['src/a.ts'], status: '', baseIsAncestor: true, hasMerges: false, ...g }, ...o,
})
const outcome = (f: WorkFacts) => judgeWork(f).outcome

test('whole-repository owns includes dotfiles without weakening narrow scopes or protected-path review', () => {
  const changed = ['.gitignore', '.github/workflows/build.yml', 'src/.config/settings.json', 'src/a.ts']
  for (const file of changed) assert.ok(ownsMatch(file, ['**']), file)
  for (const file of ['', '/tmp/outside', '../outside', 'src/../../outside', 'src//a']) assert.ok(!ownsMatch(file, ['**']), file)
  assert.equal(ownsMatch('.gitignore', ['src/**']), false)
  assert.equal(ownsMatch('.gitignore', ['*']), false)
  assert.equal(ownsMatch('.gitignore', ['.gitignore']), true)
  const result = judgeWork(facts({ owns: ['**'], doneRaw: done({ files_modified: changed }) }, { changed }))
  assert.equal(result.outcome, 'succeeded')
  assert.ok(result.protectedChanges.includes('.github/workflows/build.yml'))
  assert.equal(outcome(facts({ owns: ['**'], doneRaw: done({ head_sha: BASE }) })), 'failed', 'whole-repository scope still verifies the commit')
})

test('2. unverifiable: no done, token mismatch, symlink done, oversized done', () => {
  assert.equal(outcome(facts({ doneRaw: null })), 'unverifiable')
  assert.equal(outcome(facts({ doneRaw: done({ attempt_token: 'other' }) })), 'unverifiable')
  assert.equal(outcome(facts({ doneRaw: '{not json' })), 'unverifiable')
  const dir = tmp('hq-out-')
  mkdirSync(join(dir, 'out'))
  writeFileSync(join(dir, 'real.json'), done())
  symlinkSync(join(dir, 'real.json'), join(dir, 'out', 'done.json'))
  assert.equal(readOut(join(dir, 'out'), 'done.json', DONE_MAX), null, 'symlink ignored')
  assert.equal(outcome(facts({ doneRaw: readOut(join(dir, 'out'), 'done.json', DONE_MAX) })), 'unverifiable')
  mkdirSync(join(dir, 'out2'))
  writeFileSync(join(dir, 'out2', 'done.json'), 'x'.repeat(DONE_MAX + 1))
  assert.equal(readOut(join(dir, 'out2'), 'done.json', DONE_MAX), null, 'oversized ignored')
  writeFileSync(join(dir, 'out2', 'report.md'), 'ok')
  assert.equal(readOut(join(dir, 'out2'), 'report.md', DONE_MAX), 'ok')
})

test('large complete file lists survive submission without relaxing commit, scope or token checks', () => {
  const dir = tmp('hq-large-done-')
  const changed = Array.from({ length: 969 }, (_, i) => `src/world/evidence/independent-playtest-capture/vertical-traversal/camera-proof-${i}.json`)
  const raw = done({ files_modified: changed })
  assert.ok(Buffer.byteLength(raw) > 64 * 1024)
  assert.ok(Buffer.byteLength(raw) < DONE_MAX)
  writeFileSync(join(dir, 'done.json'), raw)
  const file = readOutResult(dir, 'done.json', DONE_MAX)
  assert.equal(file.problem, null)
  const f = facts({ doneRaw: file.text, doneReadProblem: file.problem }, { changed })
  assert.equal(outcome(f), 'succeeded')
  assert.equal(outcome({ ...f, token: 'stale' }), 'unverifiable')
  assert.equal(outcome({ ...f, owns: ['src/other/**'] }), 'failed')
  assert.equal(outcome({ ...f, git: { ...f.git!, head: BASE } }), 'failed')
  assert.equal(outcome({ ...f, git: { ...f.git!, changed: [...changed, 'src/missing.ts'] } }), 'failed')
})

test('submission read failures distinguish oversized, missing and non-regular files', () => {
  const dir = tmp('hq-out-reasons-')
  assert.match(readOutResult(dir, 'missing.json', DONE_MAX).problem!, /파일 없음/)
  mkdirSync(join(dir, 'directory.json'))
  assert.match(readOutResult(dir, 'directory.json', DONE_MAX).problem!, /일반 파일이 아님/)
  writeFileSync(join(dir, 'done.json'), 'x'.repeat(DONE_MAX + 1))
  const file = readOutResult(dir, 'done.json', DONE_MAX)
  assert.equal(file.text, null)
  assert.match(file.problem!, /크기 제한 초과 \(1048577 bytes > 1048576 bytes\)/)
  assert.deepEqual(judgeWork(facts({ doneRaw: file.text, doneReadProblem: file.problem })).reasons, [file.problem])
  symlinkSync(join(dir, 'done.json'), join(dir, 'link.json'))
  assert.match(readOutResult(dir, 'link.json', DONE_MAX).problem!, /심볼릭 링크 금지/)
})

test('2. judgement table', () => {
  const cases: [string, WorkFacts, string][] = [
    ['blocked', facts({ doneRaw: done({ outcome: 'blocked' }) }), 'brief_blocked'],
    ['failed', facts({ doneRaw: done({ outcome: 'failed' }) }), 'failed'],
    ['question without questions', facts({ doneRaw: done({ outcome: 'question', questions: [] }) }), 'failed'],
    ['question with questions', facts({ doneRaw: done({ outcome: 'question', questions: [{ question: 'q?', options: ['a'], default: 'a' }] }) }), 'question'],
    ['max_turns', facts({ result: { type: 'result', subtype: 'error_max_turns', is_error: true } }), 'failed'],
    ['429', facts({ result: { type: 'result', is_error: true, api_error_status: 429 }, doneRaw: null }), 'limited'],
    ['rejected event', facts({ rejectedSeen: true, doneRaw: null }), 'limited'],
    ['529', facts({ result: { type: 'result', is_error: true, api_error_status: 529 }, doneRaw: null }), 'transient'],
    ['503', facts({ result: { type: 'result', is_error: true, api_error_status: 503 }, doneRaw: null }), 'transient'],
    ['"rate limit" text in a normal result', facts({ result: { type: 'result', subtype: 'success', is_error: false, result: 'I hit a rate limit earlier but finished' }, stderr: 'rate limit' }), 'succeeded'],
    ['stderr limit without result line', facts({ result: null, stderr: 'Claude usage limit reached', doneRaw: null }), 'limited'],
    ['runaway', facts({ runaway: true }), 'runaway'],
    ['head mismatch', facts({}, { head: 'c'.repeat(40) }), 'failed'],
    ['files missing', facts({}, { changed: ['src/a.ts', 'src/b.ts'] }), 'failed'],
    ['files extra', facts({ doneRaw: done({ files_modified: ['src/a.ts', 'src/z.ts'] }) }), 'failed'],
    ['outside owns', facts({ doneRaw: done({ files_modified: ['src/a.ts', 'lib/x.ts'] }) }, { changed: ['src/a.ts', 'lib/x.ts'] }), 'failed'],
    ['rename old path outside owns', facts({ doneRaw: done({ files_modified: ['lib/old.ts', 'src/new.ts'] }) }, { changed: ['lib/old.ts', 'src/new.ts'] }), 'failed'],
    ['uncommitted edits are simply not part of the fetched result (v3)', facts({}, { status: '?? junk.txt' }), 'succeeded'],
    ['runaway wins over an earlier limit event', facts({ runaway: true, rejectedSeen: true }), 'runaway'],
    ['not logged in', facts({ result: { type: 'result', is_error: true, result: 'Not logged in · Please run /login' }, doneRaw: null }), 'limited'],
    ['hq-work could not be fetched', facts({}, { head: null }), 'failed'],
    ['merge commit', facts({}, { hasMerges: true }), 'failed'],
    ['not a descendant of base', facts({}, { baseIsAncestor: false }), 'failed'],
    ['summary 199', facts({ report: summary(199) }), 'failed'],
    ['summary 200', facts({ report: summary(200) }), 'succeeded'],
  ]
  for (const [name, f, want] of cases) assert.equal(outcome(f), want, name)
})

test('2. protected path changes inside owns pass and are listed', () => {
  const j = judgeWork(facts({ owns: ['src/**', 'package.json'], doneRaw: done({ files_modified: ['src/a.ts', 'src/a.test.ts', 'package.json'] }) },
    { changed: ['package.json', 'src/a.test.ts', 'src/a.ts'] }))
  assert.equal(j.outcome, 'succeeded')
  assert.deepEqual(j.protectedChanges.sort(), ['package.json', 'src/a.test.ts'])
})

test('2. collect: read-only cwd and report summary', () => {
  const c = (g: Partial<NonNullable<WorkFacts['git']>>, report = summary(200)) => outcome(facts({ role: 'collect', doneRaw: done({ head_sha: BASE, files_modified: [] }), report }, { head: BASE, changed: [], ...g }))
  assert.equal(c({}), 'succeeded')
  assert.equal(c({ status: ' M README.md' }), 'failed')
  assert.equal(c({}, summary(10)), 'failed')
})

test('game checkpoint requires fresh owned evidence, a bounded continuation, and the full commit contract', () => {
  const d = { outcome: 'checkpoint', checkpoint: { next_step: '남은 적 반복 처치를 확인한다', evidence: ['src/a.ts'] } }
  const f = facts({ doneRaw: done(d), checkpoint: { count: 0, freshFiles: ['src/a.ts'] } })
  assert.equal(outcome(f), 'checkpoint')
  assert.equal(outcome({ ...f, checkpoint: undefined }), 'brief_blocked', 'no opt-in outside game')
  assert.equal(outcome({ ...f, role: 'collect' }), 'brief_blocked', 'no collect checkpoints')
  assert.equal(outcome({ ...f, checkpoint: { count: 3, freshFiles: ['src/a.ts'] } }), 'brief_blocked', 'lifetime cap')
  assert.equal(outcome({ ...f, checkpoint: { count: 0, freshFiles: [] } }), 'brief_blocked', 'same head/deleted/symlink evidence rejected')
  for (const checkpoint of [undefined, { next_step: '', evidence: ['src/a.ts'] }, { next_step: 'continue', evidence: [] }, { next_step: 'continue', evidence: ['../elsewhere'] }])
    assert.equal(outcome({ ...f, doneRaw: done({ ...d, checkpoint }) }), 'brief_blocked')
  assert.equal(outcome({ ...f, doneRaw: done({ ...d, files_modified: [] }) }), 'failed', 'whole base diff still required')
  assert.equal(outcome({ ...f, git: { ...f.git!, hasMerges: true } }), 'failed')
  assert.equal(outcome({ ...f, report: summary(10) }), 'failed')
  assert.equal(outcome({ ...f, runaway: true }), 'runaway', 'wall cap still applies')
  assert.equal(outcome({ ...f, rejectedSeen: true }), 'limited', 'quota still applies')
})
