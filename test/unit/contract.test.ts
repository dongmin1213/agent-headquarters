// §G 2: completion judgement (execution.md §8).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DONE_MAX, judgeWork, readOut, type WorkFacts } from '../../src/exec/contract.ts'
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
    ['dirty', facts({}, { status: '?? junk.txt' }), 'failed'],
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
