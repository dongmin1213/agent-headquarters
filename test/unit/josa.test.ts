// Korean particles after interpolated words (src/josa.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { josa, particle } from '../../src/josa.ts'

test('josa: Hangul by the final consonant (ㄹ counts as open for 으로/로)', () => {
  const rows: [string, Parameters<typeof josa>[1], string][] = [
    ['사장', '이/가', '사장이'], ['회사', '이/가', '회사가'], ['작업', '을/를', '작업을'], ['브랜치', '을/를', '브랜치를'],
    ['팀', '은/는', '팀은'], ['사과', '은/는', '사과는'], ['책', '와/과', '책과'], ['나', '와/과', '나와'],
    ['서울', '으로/로', '서울로'], ['집', '으로/로', '집으로'], ['바다', '으로/로', '바다로'], ['수익자동화 팀', '이/가', '수익자동화 팀이'],
    ['통합', '이에요/예요', '통합이에요'], ['병합 대기', '이에요/예요', '병합 대기예요'],
  ]
  for (const [w, p, want] of rows) assert.equal(josa(w, p), want, `${w} ${p}`)
})

test('josa: digits by Korean reading (영 일 이 삼 사 오 육 칠 팔 구; 십·백·천·만 for trailing zeros)', () => {
  const rows: [string | number, Parameters<typeof josa>[1], string][] = [
    [17933, '을/를', '17933을'], [84410, '은/는', '84410은'], [7777, '을/를', '7777을'], [2, '이/가', '2가'], [4, '은/는', '4는'],
    [5, '와/과', '5와'], [9, '을/를', '9를'], [1, '으로/로', '1로'], [7, '으로/로', '7로'], [8, '으로/로', '8로'], [3, '으로/로', '3으로'],
    [6, '이/가', '6이'], [0, '이/가', '0이'], [10, '으로/로', '10으로'], [100, '을/를', '100을'], [1000, '은/는', '1000은'], [20000, '이/가', '20000이'],
    ['L1', '은/는', 'L1은'], ['L2', '은/는', 'L2는'], ['api-1', '이/가', 'api-1이'],
  ]
  for (const [w, p, want] of rows) assert.equal(josa(w, p), want, `${w} ${p}`)
})

test('josa: latin words — final consonant only for l (ㄹ), m, n, ng; acronyms and single letters by letter name', () => {
  const rows: [string, Parameters<typeof josa>[1], string][] = [
    ['main', '으로/로', 'main으로'], ['main', '을/를', 'main을'],
    ['test', '은/는', 'test는'], ['master', '으로/로', 'master로'], ['team', '이/가', 'team이'], ['string', '와/과', 'string과'],
    ['file', '으로/로', 'file로'], ['file', '이/가', 'file이'], ['name', '을/를', 'name을'], ['sonnet', '은/는', 'sonnet는'] /* t reads as 트 by rule (소넷 is an exception: rephrase) */, ['server', '이/가', 'server가'], ['opus', '은/는', 'opus는'],
    ['A', '이/가', 'A가'], ['B', '와/과', 'B와'], ['L', '으로/로', 'L로'], ['M', '이/가', 'M이'], ['R', '을/를', 'R을'], ['HQ', '은/는', 'HQ는'], ['XML', '이/가', 'XML이'],
  ]
  for (const [w, p, want] of rows) assert.equal(josa(w, p), want, `${w} ${p}`)
})

test('josa: trailing quotes/brackets are skipped; unreadable endings get the neutral form', () => {
  assert.equal(particle('"main"', '을/를'), '을')
  assert.equal(particle('작업)', '이/가'), '이')
  assert.equal(particle('/', '이/가'), '(이)가')
  assert.equal(particle('', '을/를'), '(을)를')
  assert.equal(particle('~', '은/는'), '(은)는')
  assert.equal(particle('#', '으로/로'), '(으)로')
  assert.equal(particle('*', '와/과'), '와(과)')
  assert.equal(particle('!', '이에요/예요'), '(이)예요')
})
