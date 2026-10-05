// §G 18: decision item order, needsYou and headline sentences (execution.md §17 §18).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHeadline, CONFIRM_STOP, decisionItems, MERGE_UNCHANGED, recommendMerges, type HeadlineInput } from '../../src/exec/decisions.ts'
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

test('18. headline shows recurring teams working / in error', () => {
  const team = (o: Partial<{ name: string; state: string; bubble: string }>) => ({ name: '수익자동화', state: 'working', bubble: '리서치·대본 작성 중: 웅진그룹', ...o })
  assert.equal(buildHeadline({ ...base, teams: [team({})] }).text, '수익자동화: 리서치·대본 작성 중: 웅진그룹')
  assert.equal(buildHeadline({ ...base, teams: [team({}), team({ name: '뉴스', bubble: '수집 중' })] }).text, '수익자동화: 리서치·대본 작성 중: 웅진그룹 외 1팀')
  assert.equal(buildHeadline({ ...base, teams: [team({}), team({ state: 'error', bubble: '업로드 실패\n' + 'x'.repeat(100) })] }).text, `수익자동화 팀 오류: ${('업로드 실패\n' + 'x'.repeat(100)).slice(0, 80)}`)
  assert.equal(buildHeadline({ ...base, teams: [team({ name: '뉴스팀', state: 'error', bubble: '끊김' })] }).text, '뉴스팀 오류: 끊김')
  assert.equal(buildHeadline({ ...base, teams: [team({ state: 'idle' }), team({ state: 'sleeping' })] }).text, '지금 하실 일은 없어요')
  const d = { title: '계획 승인: X' } as DecisionItem
  assert.deepEqual(buildHeadline({ ...base, decisions: [d], teams: [team({})] }), { text: '회장님 결정 1건: 계획 승인: X', needsYou: 1 })
  assert.equal(buildHeadline({ ...base, failures: [{ title: '요청 A', reason: '통합 충돌' }], teams: [team({ state: 'error' })] }).text, '막혔어요 · 요청 A: 통합 충돌')
  assert.equal(buildHeadline({ ...base, workers: [w({})], teams: [team({})] }).text, '로그인 고치기 구현 중 · sonnet · 다음: 검증')
  assert.equal(buildHeadline({ ...base, teams: [] }).text, '지금 하실 일은 없어요')
  assert.equal(buildHeadline({ ...base, teams: [team({})] }).needsYou, 0)
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
    s.putApproval({ id: 'system:login', teamId: 'hq', subjectId: '', title: 'Codex 로그인 필요', body: 'Not logged in', options: ['다시 확인'], subjectHash: 'l' })
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
    assert.ok(snap.workers.some((x) => x.state === 'blocked' && x.bubble === '막힘 · 사장에게 보고'))
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
      title: '수익자동화 · 다음 영상 주제를 골라 주세요', detail: '후보 3개', situation: '수익자동화 팀: 후보 3개',
      cause: null, causeConfirmed: false, recommendation: null,
      optionHelp: { A안: '이 선택으로 팀이 다음 단계를 진행해요', 보류: '지금은 고르지 않아요 · 팀이 나중에 다시 물어요', 반려: '팀이 이 항목을 진행하지 않아요' },
      detailPath: null, options: ['A안', '보류', '반려'], subjectHash: 'ht1', createdAt: rev.createdAt,
    })
    assert.equal(other.situation, '시험 팀이 회장님 결정을 기다려요', 'a name ending in 팀 is not doubled; no body → generic sentence')
    assert.ok(decisionItems(s, h.clock.t).some((d) => d.title === 'revenue · 다음 영상 주제를 골라 주세요'), 'unknown team falls back to its id')
    const snap = h.runner.views()
    assert.equal(snap.headline.needsYou, 2)
    assert.equal(snap.headline.text, `회장님 결정 2건: ${snap.decisions[0].title}`)
    assert.deepEqual(snap.decisions.map((d) => d.kind), ['team', 'team'])
    await h.runner.tick()
    assert.equal(h.notes.filter(([t]) => t === '팀 결정이 필요해요').length, 2, 'one notification per team card')
  } finally { await h.close() }
})

test('U1/U3/U4. cards: Korean cause + raw detail, inline confirms for irreversible options, recommendations hq can state', async () => {
  const h = harness()
  try {
    const s = h.store
    const mk = (id: string, status: string) => { s.addRequest(id, 'p', id); s.updateRequest(id, { status }) }
    // system/login: raw CLI text → Korean cause; raw kept as detail; recommendation names the real option.
    s.putApproval({ id: 'system:login', teamId: 'hq', subjectId: '', title: 'Codex 로그인 필요', body: 'Not logged in · Please run /login', options: ['다시 확인'], subjectHash: 'l' })
    // integration with raw git output in the merge note.
    mk('req-integ002', 'blocked')
    const raw = "미러 갱신 실패: Error: git fetch -q --no-tags 실패: fatal: bad object 0123456789"
    s.putMerge('req-integ002', 'p', { state: 'failed', note: raw })
    s.putApproval({ id: 'integration:req-integ002:p', teamId: 'hq', subjectId: 'req-integ002', title: '통합 문제: P', body: '대상 브랜치 위에 합치지 못했어요', options: ['다시 통합', '해당 작업 재작업', '요청 중단'], subjectHash: 'i' })
    // merge card on main.
    mk('req-merge002', 'accepted'); s.putMerge('req-merge002', 'p', { state: 'offered', target: 'main', target_sha: 'a'.repeat(40), integration_sha: 'b'.repeat(40) })
    s.putApproval({ id: 'merge:req-merge002:p', teamId: 'hq', subjectId: 'req-merge002', title: 'merge', body: '', options: ['병합', '보류'], subjectHash: 'm' })
    // team card with a multi-line body.
    s.putApproval({ id: 'team:revenue:t1', teamId: 'revenue', title: '주제 고르기', body: '후보 3개를 찾았어요\n1. A\n2. B\n3. C', options: ['A', '보류'], subjectHash: 't' })
    // blocked task.
    const id = h.plan([task('A')])
    await h.approve(id)
    s.updateTask(`${id}.A`, { status: 'blocked', note: '판정 중 오류: TypeError: Cannot read properties of undefined', block_count: 1 })

    const items = decisionItems(s, h.clock.t, { revenue: '수익자동화' })
    const by = (k: string) => items.find((d) => d.kind === k)!
    const sys = by('system')
    assert.equal(sys.cause, 'Codex에 로그인되어 있지 않아요 · 터미널에서 codex login으로 로그인해 주세요')
    assert.equal(sys.detail, 'Not logged in · Please run /login')
    assert.deepEqual(sys.recommendation, { option: '다시 확인', reason: "터미널에서 codex login으로 로그인한 뒤 '다시 확인'을 눌러 주세요" })
    assert.ok(sys.options.includes(sys.recommendation!.option))

    const integ = by('integration')
    assert.equal(integ.cause, '미러 갱신 실패 · 필요한 커밋을 저장소에서 찾지 못했어요 · 다시 통합하거나 작업을 다시 해 주세요')
    assert.ok(integ.detail.includes(raw), 'raw git output behind 원문 보기')
    assert.deepEqual(integ.confirm, { '요청 중단': CONFIRM_STOP })
    assert.equal(CONFIRM_STOP, '정말 중단할까요? · 되돌릴 수 없어요')

    const blocked = by('blocked')
    assert.equal(blocked.cause, '판정 중 오류 · 원문을 확인해 주세요')
    assert.match(blocked.detail, /TypeError/)
    assert.deepEqual(blocked.confirm, { stop: CONFIRM_STOP })

    const team = by('team')
    assert.equal(team.situation, '수익자동화 팀: 후보 3개를 찾았어요')
    assert.equal(team.detail, '후보 3개를 찾았어요\n1. A\n2. B\n3. C')
    assert.equal(team.confirm, undefined)

    assert.equal(by('plan'), undefined, 'plan approved already')
    const merge = by('merge')
    assert.deepEqual(merge.confirm, { 병합: 'main에 병합할까요?' })
    assert.equal(merge.recommendation, null, 'decisionItems alone does not know the current target')
    const same = recommendMerges(items, s, (project, branch) => (project === 'p' && branch === 'main' ? 'a'.repeat(40) : null))
    assert.deepEqual(same.find((d) => d.kind === 'merge')!.recommendation, { option: '병합', reason: MERGE_UNCHANGED })
    assert.equal(MERGE_UNCHANGED, '대상 브랜치가 검사한 뒤로 바뀌지 않았어요')
    assert.equal(recommendMerges(items, s, () => 'c'.repeat(40)).find((d) => d.kind === 'merge')!.recommendation, null, 'target moved: no recommendation')
    assert.equal(recommendMerges(items, s, () => null).find((d) => d.kind === 'merge')!.recommendation, null, 'unknown target: no recommendation')
    assert.deepEqual(recommendMerges(items, s, () => 'a'.repeat(40)).filter((d) => d.kind !== 'merge'), items.filter((d) => d.kind !== 'merge'), 'other cards untouched')
  } finally { await h.close() }
})

test('U4. snapshot recommends 병합 only while the checkout branch still points at the checked target', async () => {
  const h = harness()
  try {
    const { snapshot } = await import('../../src/server.ts')
    const { commitFile, sh } = await import('./helpers.ts')
    const s = h.store
    const head = sh(h.repo, 'rev-parse', 'HEAD')
    s.addRequest('req-merge003', 'p', 'x'); s.updateRequest('req-merge003', { status: 'accepted' })
    s.putMerge('req-merge003', 'p', { state: 'offered', target: 'main', target_sha: head, integration_sha: 'b'.repeat(40) })
    s.putApproval({ id: 'merge:req-merge003:p', teamId: 'hq', subjectId: 'req-merge003', title: 'merge', body: '', options: ['병합', '보류'], subjectHash: 'm' })
    const deps = { port: 1, store: s, bus: h.bus, scheduler: { views: () => [] }, token: 't', engine: h.engine, runner: h.runner, projects: h.projects } as never
    assert.deepEqual(snapshot(deps).decisions.find((d) => d.kind === 'merge')!.recommendation, { option: '병합', reason: MERGE_UNCHANGED })
    commitFile(h.repo, 'moved.txt', 'x')
    assert.equal(snapshot(deps).decisions.find((d) => d.kind === 'merge')!.recommendation, null)
  } finally { await h.close() }
})
