// §G 4: reviewer verdict validation (execution.md §10), including stream Bash evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkVerdict } from '../../src/exec/review.ts'
import { extractBashRuns } from '../../src/exec/stream.ts'
import { tmp } from './helpers.ts'

const ids = ['A1', 'A2']
const runs: { command: string; exitCode: number | null }[] = [{ command: 'npm test', exitCode: 0 }, { command: 'npm run lint', exitCode: 1 }]
const v = (o: Record<string, unknown> = {}) => ({ pass: true, blocking: [], advisory: [],
  criteria: [{ id: 'A1', result: 'pass', evidence: 'e' }, { id: 'A2', result: 'pass', evidence: 'e' }], tests_run: [{ command: 'npm test', exit_code: 0, summary: 'ok' }], ...o })
const kind = (raw: unknown) => checkVerdict(raw, { acceptanceIds: ids, codeChanged: true, bashRuns: runs }).kind

test('4. verdict table', () => {
  assert.equal(kind(v({ criteria: [{ id: 'A1', result: 'pass', evidence: 'e' }] })), 'invalid', 'criteria missing')
  assert.equal(kind(v({ criteria: [...v().criteria, { id: 'A9', result: 'pass', evidence: 'e' }] })), 'invalid', 'criteria extra')
  assert.equal(kind(v({ criteria: [...v().criteria, { id: 'A1', result: 'pass', evidence: 'e' }] })), 'invalid', 'criteria duplicate')
  assert.equal(kind(v({ tests_run: [{ command: 'make test-all', exit_code: 0, summary: '' }] })), 'invalid', 'command not in stream')
  assert.equal(kind(v({ tests_run: [{ command: 'npm run lint', exit_code: 0, summary: '' }] })), 'invalid', 'exit code mismatch')
  assert.equal(kind(v({ tests_run: [] })), 'invalid', 'no tests with code change')
  assert.equal(kind(v({ blocking: [{ id: 'B', summary: 's', evidence: 'e' }] })), 'invalid', 'pass + blocking')
  assert.equal(kind(v({ pass: false })), 'invalid', 'fail without blocking')
  assert.equal(kind(v()), 'pass', 'normal pass')
  assert.equal(kind(v({ pass: false, blocking: [{ id: 'B', summary: 's', evidence: 'e' }], criteria: [{ id: 'A1', result: 'fail', evidence: 'e' }, { id: 'A2', result: 'pass', evidence: 'e' }] })), 'blocking', 'normal blocking')
  assert.equal(kind(null), 'invalid')
})

test('4. Bash runs and exit codes come from the reviewer stream', () => {
  const dir = tmp('hq-stream-')
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cd pkg && npm run lint' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 2\nlint failed' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: 'x' } }] } },
  ]
  writeFileSync(join(dir, 'stream.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const got = extractBashRuns(join(dir, 'stream.jsonl'))
  assert.deepEqual(got, [{ command: 'npm test', exitCode: 0 }, { command: 'cd pkg && npm run lint', exitCode: 2 }])
  const r = checkVerdict(v({ tests_run: [{ command: 'npm run lint', exit_code: 2, summary: '' }] }), { acceptanceIds: ids, codeChanged: true, bashRuns: got })
  assert.equal(r.kind, 'invalid', 'v3: a command contained in a compound Bash run is not a match')
})

test('game review checkpoints distinguish unverified work from product defects and require real progress', () => {
  const opts = { acceptanceIds: ids, codeChanged: true, bashRuns: runs, judgeIds: ids, allowContinuation: true }
  const incomplete = v({ pass: false, continuation: { next_step: 'A2 실제 플레이를 저장 지점부터 확인' },
    criteria: [{ id: 'A1', result: 'pass', evidence: '직접 확인' }, { id: 'A2', result: 'manual', evidence: '플레이 미완료' }] })
  assert.equal(checkVerdict(incomplete, opts).kind, 'incomplete')
  assert.equal(checkVerdict(incomplete, { ...opts, allowContinuation: false }).kind, 'invalid')
  for (const extra of [
    { pass: true }, { blocking: [{ id: 'bug', summary: '충돌', evidence: '직접 재현' }] },
    { continuation: { next_step: '' } }, { tests_run: [] },
    { tests_run: [{ command: 'not executed', exit_code: 0, summary: 'fake' }] },
    { criteria: incomplete.criteria.map(c => ({ ...c, result: 'manual' })) },
    { criteria: incomplete.criteria.map(c => ({ ...c, result: c.result === 'manual' ? 'fail' : c.result })) },
  ]) assert.equal(checkVerdict({ ...incomplete, ...extra }, opts).kind, 'invalid')
  assert.equal(checkVerdict({ ...incomplete, continuation: null }, opts).kind, 'invalid', 'final review cannot leave required criteria unverified')
  assert.equal(checkVerdict(v({ continuation: null }), opts).kind, 'pass')
})


test('checkpoint keeps corrected invocation failures without weakening final approval or command verification', () => {
  const opts = { acceptanceIds: ids, codeChanged: true, bashRuns: runs, judgeIds: ids, allowContinuation: true }
  const raw = v({ pass: false, continuation: {next_step:'remaining real play'},
    criteria:[{id:'A1',result:'pass',evidence:'observed'},{id:'A2',result:'manual',evidence:'remaining'}],
    tests_run:[{command:'npm test',exit_code:0,summary:'ok'},{command:'npm run lint',exit_code:1,summary:'recorded failure; not an approval'}] })
  const checked = checkVerdict(raw,opts)
  assert.equal(checked.kind,'incomplete')
  assert.equal(checked.verdict?.tests_run[1].exit_code,1)
  assert.equal(checkVerdict({...raw,tests_run:[raw.tests_run[1]]},opts).kind,'invalid','requires a successful executed check')
  assert.equal(checkVerdict({...raw,tests_run:[raw.tests_run[0],{...raw.tests_run[1],exit_code:0}]},opts).kind,'invalid','cannot rewrite failure')
  assert.equal(checkVerdict({...raw,pass:true,continuation:null,criteria:v().criteria},opts).kind,'invalid','final pass still rejects failures')
})
