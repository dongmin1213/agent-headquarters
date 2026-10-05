// Raw technical errors → one Korean sentence for the chairman; raw text kept as detail (src/humanize.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_PATTERNS, explainError, UNKNOWN_ERROR } from '../../src/humanize.ts'

const say = (re: RegExp) => ERROR_PATTERNS.find(([r]) => r.source === re.source)?.[1]
const LOGIN = 'Codex에 로그인되어 있지 않아요 · 터미널에서 codex login으로 로그인해 주세요'

test('error mapping table: known patterns', () => {
  const rows: [string, RegExp][] = [
    ['CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed; fix conflicts and then commit the result.', /합치는 중에 같은 부분을/],
    ['merge: abc123 - not something we can merge', /합칠 커밋을 찾지 못했어요/],
    ['fatal: bad object 0123456789abcdef', /필요한 커밋을 저장소에서 찾지 못했어요/],
    ["fatal: Unable to create '/x/.git/index.lock': File exists.", /index\.lock을 지운 뒤/],
    ["Error: ENOENT: no such file or directory, open '/x/y'", /필요한 파일이나 프로그램을 찾지 못했어요/],
    ["Error: EACCES: permission denied, open '/x/y'", /권한이 없어/],
    ['Not logged in · Please run /login', /^Codex에 로그인되어 있지 않아요/],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error"}}', /^Codex에 로그인되어 있지 않아요/],
    ['rate limit exceeded, retry later', /사용 한도에 걸렸어요/],
    ['Error: connect ECONNREFUSED 127.0.0.1:7777', /연결을 받지 않았어요/],
    ['Error: connect ETIMEDOUT 1.2.3.4:443', /네트워크 응답이 없어요/],
  ]
  for (const [raw, want] of rows) {
    const e = explainError(raw)
    assert.match(e.cause, want, raw)
    assert.equal(e.detail, raw.trim(), 'raw text kept as detail')
    assert.equal(e.known, true)
    assert.doesNotMatch(e.cause, /[A-Za-z]{2,}:|fatal|Error/, `cause is Korean only: ${e.cause}`)
  }
  assert.equal(explainError('Not logged in').cause, LOGIN)
  assert.ok(say(/Not logged in|Please run \/login|Invalid API key|authentication_error|\b401\b|Unauthorized/i))
})

test('error mapping: hq Korean lead-in kept, unknown output, plain hq sentences, empty', () => {
  assert.equal(explainError("미러 갱신 실패: Error: git clone --bare 실패: fatal: repository '/x' does not exist").cause, '미러 갱신 실패 · 필요한 파일이나 프로그램을 찾지 못했어요 · 경로가 맞는지 확인해 주세요')
  assert.equal(explainError('판정 중 오류: TypeError: Cannot read properties of undefined').cause, '판정 중 오류 · 원문을 확인해 주세요')
  assert.equal(explainError('something odd happened (code 7)').cause, UNKNOWN_ERROR)
  assert.equal(explainError('TypeError: x is not a function\n    at f (/a/b.ts:1:2)').cause, UNKNOWN_ERROR)
  // hq's own Korean sentences pass through unchanged (first line).
  assert.equal(explainError('통합 충돌 (A): src/a.ts, src/b.ts').cause, '통합 충돌 (A): src/a.ts, src/b.ts')
  assert.equal(explainError('done.json이 없어요\n자세히').cause, 'done.json이 없어요')
  assert.deepEqual(explainError(''), { cause: UNKNOWN_ERROR, detail: '', known: false })
})
