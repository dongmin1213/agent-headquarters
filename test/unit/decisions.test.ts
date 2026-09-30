// §G 18: decision item order, needsYou and headline sentences (execution.md §17 §18).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHeadline, decisionItems, type HeadlineInput } from '../../src/exec/decisions.ts'
import type { DecisionItem, WorkerView } from '../../src/types.ts'
import { harness, task } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()

const q = { mode: 'normal' as const, until: null, window: null, pct: null }
const base: HeadlineInput = { decisions: [], failures: [], workers: [], ceoThinking: false, waiting: 0, quota: q, recentMerged: null }
const w = (o: Partial<WorkerView>): WorkerView => ({ attemptId: 'a', taskId: 't', requestId: 'r', title: '로그인 고치기', project: 'p', role: 'implement', model: 'sonnet', kind: 'work', state: 'running', bubble: '', startedAt: '', ...o })

test('18. headline sentences', () => {
  const d = { kind: 'plan', title: '계획 승인: X' } as DecisionItem
  assert.deepEqual(buildHeadline({ ...base, decisions: [d, d] }), { text: '회장님 결정 2건: 계획 승인: X', needsYou: 2 })
  assert.equal(buildHeadline({ ...base, failures: [{ title: '요청 A', reason: '통합 충돌\n자세히' }] }).text, '막혔어요 · 요청 A: 통합 충돌')
  assert.equal(buildHeadline({ ...base, workers: [w({}), w({ kind: 'review', model: 'opus', state: 'reviewing' })] }).text, '로그인 고치기 구현 중 · sonnet · 다음: 검증 외 1명')
  assert.equal(buildHeadline({ ...base, workers: [w({ kind: 'review', model: 'opus', state: 'reviewing' })] }).text, '로그인 고치기 검토 중 · opus · 다음: 통합')
  assert.equal(buildHeadline({ ...base, workers: [w({ kind: 'verify', model: 'hq', state: 'verifying' })] }).text, '로그인 고치기 검증 중 · hq · 다음: 검토')
  assert.equal(buildHeadline({ ...base, ceoThinking: true }).text, '사장이 계획 중이에요')
  const until = new Date(2026, 8, 30, 14, 5).toISOString()
  assert.equal(buildHeadline({ ...base, waiting: 1, quota: { mode: 'hold', until, window: 'five_hour', pct: 0.96 } }).text, '사용 한도 5시간 96% — 14:05까지 쉬어요')
  assert.equal(buildHeadline({ ...base, workers: [w({ state: 'held' })], quota: { mode: 'hold', until, window: 'seven_day', pct: 1 } }).text, '사용 한도 7일 100% — 14:05까지 쉬어요')
  assert.equal(buildHeadline({ ...base, waiting: 2, quota: { ...q, mode: 'unobserved' } }).text, '한도 관측 전이라 하나씩 실행 중')
  assert.equal(buildHeadline({ ...base, waiting: 2 }).text, '빈 자리 기다리는 중 (2건)')
  assert.equal(buildHeadline({ ...base, recentMerged: '로그인 개선' }).text, '병합 완료: 로그인 개선')
  assert.deepEqual(buildHeadline(base), { text: '지금 하실 일은 없어요', needsYou: 0 })
  assert.equal(buildHeadline({ ...base, workers: [w({ state: 'blocked' })] }).text, '지금 하실 일은 없어요', 'blocked worker is not "running"')
})

test('18. decision items: kind order plan → ceo_question → worker_question → revise → blocked → integration → accept → merge, oldest first', async () => {
  const h = harness()
  try {
    const s = h.store
    const mk = (id: string, status: string) => { s.addRequest(id, 'p', id); s.updateRequest(id, { status }) }
    mk('req-merge001', 'accepted'); s.putMerge('req-merge001', 'p', { state: 'offered', target: 'main', target_sha: 'a'.repeat(40), integration_sha: 'b'.repeat(40) })
    s.putApproval({ id: 'merge:req-merge001:p', teamId: 'hq', subjectId: 'req-merge001', title: 'merge', body: '', options: ['병합', '보류'], subjectHash: 'm' })
    mk('req-accept01', 'awaiting_acceptance')
    s.putApproval({ id: 'accept:req-accept01', teamId: 'hq', subjectId: 'req-accept01', title: 'accept', body: '', options: ['수락', '반려'], subjectHash: 'a' })
    mk('req-integ001', 'blocked')
    s.putApproval({ id: 'integration:req-integ001:p', teamId: 'hq', subjectId: 'req-integ001', title: 'integration', body: '', options: ['다시 통합', '해당 작업 재작업', '요청 중단'], subjectHash: 'i' })
    s.putApproval({ id: 'system:login', teamId: 'hq', subjectId: '', title: 'Claude 로그인 필요', body: 'Not logged in', options: ['다시 확인'], subjectHash: 'l' })
    const id = h.plan([task('A'), task('B'), task('C')])
    await h.approve(id)
    s.updateTask(`${id}.A`, { status: 'blocked', note: '3번 실패', block_count: 2 })
    s.updateTask(`${id}.B`, { status: 'question' })
    s.addTaskQuestions(`${id}.B`, null, 0, [{ id: 'tq-1', question: '어느 쪽?', options: ['왼쪽', '오른쪽'], default: '왼쪽' }])
    s.updateTask(`${id}.C`, { status: 'revising' })
    s.putApproval({ id: `revise:${id}.C`, teamId: 'hq', subjectId: id, title: 'revise', body: '', options: ['승인', '반려'], subjectHash: 'r' })
    mk('req-ask00001', 'asking'); s.addQuestions('req-ask00001', [{ id: 'q-1', question: '범위?', options: ['작게', '크게'], default: '작게', reason: '모호' }])
    h.plan([task('Y')], '두 번째 계획')
    h.plan([task('Z')], '세 번째 계획')
    const items = decisionItems(s, h.clock.t)
    assert.deepEqual(items.map((d) => d.kind), ['system', 'plan', 'plan', 'ceo_question', 'worker_question', 'revise', 'blocked', 'integration', 'accept', 'merge'])
    assert.equal(items.find((d) => d.kind === 'blocked')!.revision, 2, 'blocked revision = block count')
    assert.ok(items[1].createdAt <= items[2].createdAt)
    for (const d of items) {
      assert.ok(d.situation.length > 0, `${d.kind} situation`)
      for (const o of d.options) assert.ok(d.optionHelp[o], `${d.kind} optionHelp ${o}`)
      if (d.kind === 'system') assert.equal(d.detailPath, null)
      else assert.ok(d.detailPath?.startsWith('/ui/#request='))
    }
    const wq = items.find((d) => d.kind === 'worker_question')!
    assert.deepEqual(wq.options, ['왼쪽', '오른쪽'])
    assert.deepEqual(wq.recommendation?.option, '왼쪽')
    const snap = h.runner.views()
    assert.equal(snap.headline.needsYou, items.length)
    assert.equal(snap.headline.text, `회장님 결정 ${items.length}건: ${items[0].title}`)
    assert.ok(snap.workers.some((x) => x.state === 'blocked' && x.bubble === '멈춤 · 사장에게 보고'))
  } finally { await h.close() }
})

test('18. team approvals are decision items (내 차례, headline, notifications)', async () => {
  const h = harness()
  try {
    const s = h.store
    s.putApproval({ id: 'team:revenue:topic-1', teamId: 'revenue', title: '다음 영상 주제를 골라 주세요', body: '후보 3개', options: ['A안', '보류', '반려'], subjectHash: 'ht1' })
    s.putApproval({ id: 'team:other:x', teamId: 'other', title: '다른 팀 질문', body: '', options: ['예'], subjectHash: 'ht2' })
    s.putApproval({ id: 'team:revenue:done', teamId: 'revenue', title: '이미 결정됨', body: '', options: ['예'], subjectHash: 'ht3' })
    assert.ok(s.decide('team:revenue:done', '예', 'ht3', h.clock.t))
    s.putApproval({ id: 'team:revenue:old', teamId: 'revenue', title: '만료됨', body: '', options: ['예'], subjectHash: 'ht4', expiresAt: new Date(h.clock.t - 1000).toISOString() })
    const items = decisionItems(s, h.clock.t, { revenue: '수익자동화', other: '시험 팀' })
    assert.deepEqual(items.map((d) => d.id).sort(), ['team:other:x', 'team:revenue:topic-1'], 'decided and expired cards are excluded')
    const rev = items.find((d) => d.teamId === 'revenue')!, other = items.find((d) => d.teamId === 'other')!
    assert.deepEqual(rev, {
      kind: 'team', teamId: 'revenue', id: 'team:revenue:topic-1', revision: rev.revision, requestId: '', taskId: null,
      title: '수익자동화 · 다음 영상 주제를 골라 주세요', detail: '후보 3개', situation: '수익자동화 팀이 회장님 결정을 기다려요',
      cause: null, causeConfirmed: false, recommendation: null,
      optionHelp: { A안: '이 선택으로 팀이 다음 단계를 진행해요', 보류: '지금은 고르지 않아요 · 팀이 나중에 다시 물어요', 반려: '팀이 이 항목을 진행하지 않아요' },
      detailPath: null, options: ['A안', '보류', '반려'], subjectHash: 'ht1', createdAt: rev.createdAt,
    })
    assert.equal(other.situation, '시험 팀이 회장님 결정을 기다려요', 'a name ending in 팀 is not doubled')
    assert.ok(decisionItems(s, h.clock.t).some((d) => d.title === 'revenue · 다음 영상 주제를 골라 주세요'), 'unknown team falls back to its id')
    const snap = h.runner.views()
    assert.equal(snap.headline.needsYou, 2)
    assert.equal(snap.headline.text, `회장님 결정 2건: ${snap.decisions[0].title}`)
    assert.deepEqual(snap.decisions.map((d) => d.kind), ['team', 'team'])
    await h.runner.tick()
    assert.equal(h.notes.filter(([t]) => t === '팀 결정이 필요해요').length, 2, 'one notification per team card')
  } finally { await h.close() }
})
