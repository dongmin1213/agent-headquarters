// §G 4: reviewer verdict validation (execution.md §10), including stream Bash evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkVerdict } from '../../src/exec/review.ts'
import { extractBashRuns } from '../../src/exec/stream.ts'
import { tmp } from './helpers.ts'

const ids = ['A1', 'A2']
const runs = [{ command: 'npm test', exitCode: 0 }, { command: 'npm run lint', exitCode: 1 }]
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
  assert.equal(r.kind, 'pass', 'command contained in a compound Bash run')
})
