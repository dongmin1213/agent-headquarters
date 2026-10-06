import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workPrompt, reviewPrompt } from '../../src/exec/prompt.ts'
import { task } from './helpers.ts'

test('worker and independent reviewer retain quality corrections after the first 1000 request characters', () => {
  const correction = '최신 지시: 실제 수직 탐험과 두께 있는 지형 아트를 검증하고 기존 코드 재사용 때문에 품질을 낮추지 마세요.'
  const requestText = '기존 제작 요청. '.repeat(150) + '\n\n' + correction
  const t = task('A', { department: 'gameplay' })
  const work = workPrompt({ game: true, task: t, requestText, projectName: 'game', cwd: '/tmp/game', branch: 'hq-work', base: 'base', out: '/tmp/out', token: 'test', rework: null, dirtyNotice: null, upstream: [] })
  const review = reviewPrompt({ task: t, requestText, base: 'base', head: 'head', diffStat: '', checks: null, protectedChanges: [] })
  assert.ok(work.includes(correction))
  assert.ok(review.includes(correction))
})
