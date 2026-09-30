// Mock hq daemon for the desk pet (no deps). Run: node test/pet/mock-daemon.ts [port]   (default 7788)
// Serves GET /api/state (fixture Snapshot), GET /api/events (SSE with heartbeat), and logs every POST.
// Then launch the pet: HQ_URL=http://127.0.0.1:7788 HQ_TOKEN_FILE=<file> HQ_ALLOW_SECOND_INSTANCE=1 pet/HQPet.app/Contents/MacOS/hqpet
import { createServer, type ServerResponse } from 'node:http'
import type { Snapshot, TaskView, RequestView, DecisionItem } from '../../src/types.ts'

const port = Number(process.argv[2] ?? process.env.PORT ?? 7788)
const now = Date.now()
const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString()

function task(p: Partial<TaskView> & Pick<TaskView, 'key' | 'requestId' | 'title' | 'model' | 'status'>): TaskView {
  return { id: `${p.requestId}.${p.key}`, project: 'hq', role: 'build', grade: 'L1', attempts: 1, currentAttemptId: null,
    lastActivity: null, questions: [], note: null, headSha: null, revision: 0, reviewModel: null, updatedAt: iso(0), ...p }
}
function request(p: Partial<RequestView> & Pick<RequestView, 'id' | 'text' | 'status'>): RequestView {
  return { project: 'hq', note: null, turns: 1, costUsd: 0.12, questions: [], plan: null, tasks: [], updatedAt: iso(0), ...p }
}
let order = 0
function decision(p: Partial<DecisionItem> & Pick<DecisionItem, 'kind' | 'id' | 'requestId' | 'title' | 'options'>): DecisionItem {
  return { revision: 0, taskId: null, detail: '', subjectHash: null, createdAt: iso(-3600_000 + 1000 * order++),
    situation: '', cause: null, causeConfirmed: false, recommendation: null, optionHelp: {},
    detailPath: `/ui/#request=${p.requestId}${p.taskId ? `&task=${p.taskId}` : ''}`, ...p }
}

// v2 ids are URL-safe: request req-xxxxxxxx, task <req>.<key>, attempt <task>~a<n> / ~r<n>.
const decisions: DecisionItem[] = [
  // System card (no project/task): Claude CLI is not logged in. Kind is whatever the daemon sends; the pet must render it.
  decision({ kind: 'system' as DecisionItem['kind'], id: 'system:login', requestId: '', title: 'Claude CLI 로그인이 필요해요',
    situation: '작업자를 띄우려는데 Claude CLI가 로그인되어 있지 않아요. 터미널에서 claude 를 열어 로그인한 뒤 눌러 주세요.',
    cause: 'claude -p 결과가 "Not logged in"이었어요', causeConfirmed: true, detailPath: null,
    options: ['다시 확인'], subjectHash: 'h-login', optionHelp: { '다시 확인': '멈춘 시작을 풀고 다음 시작에서 로그인을 다시 확인해요' } }),
  decision({ kind: 'plan', id: 'plan:req-a1b2c3d4', requestId: 'req-a1b2c3d4', title: 'hq · 로그인 화면 다듬기 — 계획 승인',
    detail: '작업 2개', situation: '사장이 작업 2개로 계획을 세웠어요: 폼 검증(sonnet), 오류 문구(haiku). 검사 명령은 npm test -- login 이에요.',
    options: ['승인', '반려'], subjectHash: 'h-plan',
    optionHelp: { 승인: '작업자가 바로 시작해요 · 사용량이 들어요', 반려: '사장이 계획을 다시 세워요' } }),
  decision({ kind: 'ceo_question', id: 'q1', requestId: 'req-e5f6a7b8', title: 'hq · 반응형 레이아웃 — 사장 질문',
    situation: '모바일 화면도 포함할까요? 요청에 화면 크기 언급이 없어요.', options: ['포함', '데스크톱만'],
    optionHelp: { 포함: '작업이 하나 늘어요', 데스크톱만: '지금 범위 그대로 진행해요' } }),
  decision({ kind: 'worker_question', id: 'wq1', requestId: 'req-search01', taskId: 'req-search01.index', revision: 1,
    title: 'hq · 색인 스키마 — 작업자 질문', situation: '색인을 SQLite FTS5로 만들까요? 작업자는 FTS5를 기본값으로 제안했어요.',
    options: ['FTS5', '단순 LIKE'], optionHelp: { FTS5: '검색이 빠르지만 마이그레이션이 하나 생겨요', '단순 LIKE': '간단하지만 데이터가 많으면 느려요' } }),
  decision({ kind: 'revise', id: 'revise:req-search01.api', requestId: 'req-search01', taskId: 'req-search01.api', revision: 1,
    title: 'hq · 검색 API 추가 — 지시서 수정안', situation: '작업자가 src/db/**도 고쳐야 한다며 멈췄어요. 사장이 담당 범위를 넓힌 수정안을 냈어요.',
    cause: '검색 쿼리가 src/db/query.ts의 내부 함수를 써야 해요', causeConfirmed: true,
    options: ['승인', '반려'], subjectHash: 'h-rev', optionHelp: { 승인: '넓힌 범위로 다시 작업해요', 반려: '작업을 멈춘 채로 둬요' } }),
  decision({ kind: 'blocked', id: 'req-search01.perf', requestId: 'req-search01', taskId: 'req-search01.perf', revision: 0,
    title: 'hq · 성능 측정 — 작업이 멈췄어요', detail: '3번 실패',
    situation: '성능 측정 작업이 3번 모두 검사에서 실패했어요. 벤치마크가 제한 시간 15분을 넘겼어요.',
    cause: '벤치마크가 전체 데이터(20만 건)를 매번 새로 만들어서 느려요', causeConfirmed: false,
    recommendation: { option: 'retry', reason: '타임아웃은 일시적인 부하 때문일 수 있어요' },
    options: ['retry', 'skip', 'stop'],
    optionHelp: { retry: '같은 작업을 같은 모델로 한 번 더 해요 · 사용량이 들어요',
      skip: '이 작업과 여기에 의존하는 작업을 빼고 계속해요 · 나중에 새 요청으로 다시 할 수 있어요',
      stop: '요청 전체를 멈춰요 · 만든 브랜치는 남겨 둬요' } }),
  decision({ kind: 'integration', id: 'integration:req-search01:hq', requestId: 'req-search01', title: 'hq · 검색 기능 추가 — 통합 실패',
    situation: '통과한 작업들을 합치다가 src/server.ts에서 충돌이 났어요.', cause: '두 작업이 같은 라우트 표를 고쳤어요', causeConfirmed: true,
    options: ['다시 통합', '요청 중단'], subjectHash: 'h-int',
    optionHelp: { '다시 통합': '충돌 부분을 다시 작업시켜 합쳐요', '요청 중단': '요청을 멈추고 브랜치는 남겨 둬요' } }),
  decision({ kind: 'accept', id: 'accept:req-rss00001', requestId: 'req-rss00001', title: 'blog · RSS 고치기 — 결과 수락',
    situation: '작업 1개가 검사·검토를 통과했어요 · 결과를 확인하고 수락해 주세요.', options: ['수락', '반려'], subjectHash: 'h-acc',
    optionHelp: { 수락: '통합본을 병합 대기로 넘겨요 · 병합은 따로 승인해요', 반려: '사유를 붙여 다시 작업시켜요' } }),
  decision({ kind: 'merge', id: 'merge:req-dark0001:hq', requestId: 'req-dark0001', title: 'hq · 다크 모드 — 병합 승인',
    situation: 'main(abc1234)에 통합본(def5678)을 반영해요 · 파일 6개 변경.', options: ['병합', '보류'], subjectHash: 'h-merge',
    optionHelp: { 병합: '대상 브랜치에 fast-forward로 반영해요', 보류: '지금은 병합하지 않고 둬요 · 나중에 다시 제시할 수 있어요' } }),
  // Team card (posted by a team command via POST /api/approvals): decided through POST /api/approvals/:id.
  decision({ kind: 'team', teamId: 'revenue', id: 'team:revenue:topic-1', requestId: '', title: '수익 자동화 · 다음 영상 주제를 골라 주세요', detailPath: null,
    situation: '수익 자동화 팀이 회장님 결정을 기다려요', options: ['A안', '보류', '반려'], subjectHash: 'h-team',
    optionHelp: { A안: '이 선택으로 팀이 다음 단계를 진행해요', 보류: '지금은 고르지 않아요 · 팀이 나중에 다시 물어요', 반려: '팀이 이 항목을 진행하지 않아요' } }),
  // A kind this pet build does not know: must still decode and render generically.
  decision({ kind: 'future_kind' as DecisionItem['kind'], id: 'future:1', requestId: '', title: '새 종류의 결정', detailPath: null,
    situation: '아직 모르는 종류도 카드로 보여야 해요', options: ['확인'], subjectHash: 'h-future' }),
]

const snapshot: Snapshot = {
  updatedAt: iso(0),
  lastEventId: 1,
  teams: [{ id: 'revenue', name: '수익 자동화', pack: 'digimon', state: 'working', bubble: '상품 목록 갱신 중', lastRun: null, nextRunAt: null }],
  projects: [{ id: 'hq', name: 'agent-headquarters' }, { id: 'blog', name: 'blog' }],
  limit: { blockedUntil: null },
  decisions,
  headline: { text: `회장님 결정 ${decisions.length}건: Claude CLI 로그인이 필요해요`, needsYou: decisions.length },
  quota: {
    windows: [
      { name: 'five_hour', utilization: 0.42, resetsAt: iso(2 * 3600_000), status: 'allowed' },
      { name: 'seven_day', utilization: 0.18, resetsAt: iso(4 * 86400_000), status: 'allowed' },
      { name: 'seven_day_opus', utilization: 0.61, resetsAt: iso(4 * 86400_000), status: 'allowed_warning' },
    ],
    fiveHour: 0.42, sevenDay: 0.18, fiveHourResetsAt: iso(2 * 3600_000), sevenDayResetsAt: iso(4 * 86400_000), mode: 'normal', observedAt: iso(-30_000) },
  workers: [
    { attemptId: 'req-search01.api~a1', taskId: 'req-search01.api', requestId: 'req-search01', title: '검색 API 추가', project: 'hq', role: 'build', model: 'sonnet',
      kind: 'work', state: 'running', bubble: 'Edit src/search.ts', startedAt: iso(-5 * 60_000) },
    { attemptId: 'req-search01.ui~r1', taskId: 'req-search01.ui', requestId: 'req-search01', title: '검색 화면', project: 'hq', role: 'build', model: 'opus',
      kind: 'review', state: 'reviewing', bubble: 'Bash npm test', startedAt: iso(-2 * 60_000) },
    { attemptId: 'req-search01.docs~a2', taskId: 'req-search01.docs', requestId: 'req-search01', title: '문서 갱신', project: 'hq', role: 'collect', model: 'haiku',
      kind: 'work', state: 'held', bubble: '한도 보류 — 15:00까지', startedAt: iso(-20 * 60_000) },
    { attemptId: 'req-search01.cache~a1', taskId: 'req-search01.cache', requestId: 'req-search01', title: '캐시 계층', project: 'hq', role: 'build', model: 'hq',
      kind: 'verify', state: 'verifying', bubble: '검사 2/3: npm test', startedAt: iso(-60_000) },
    { attemptId: 'req-search01.perf~a3', taskId: 'req-search01.perf', requestId: 'req-search01', title: '성능 측정 벤치마크 스크립트와 기준선 기록', project: 'hq', role: 'build', model: 'opus',
      kind: 'work', state: 'blocked', bubble: '벤치마크 시간 초과', startedAt: iso(-40 * 60_000) },
  ],
  requests: [
    request({ id: 'req-a1b2c3d4', text: '로그인 화면 다듬기', status: 'planned', updatedAt: iso(-60_000),
      plan: { summary: '로그인 폼 검증과 오류 문구를 정리합니다.', assumptions: [], tasks: [
        { id: 'form', title: '폼 검증', project: 'hq', role: 'build', grade: 'L1', model: 'sonnet' },
        { id: 'copy', title: '오류 문구', project: 'hq', role: 'build', grade: 'L0', model: 'haiku' }] } }),
    request({ id: 'req-search01', text: '검색 기능 추가', status: 'executing', updatedAt: iso(-30_000), tasks: [
      task({ key: 'api', requestId: 'req-search01', title: '검색 API 추가', model: 'sonnet', status: 'running', currentAttemptId: 'req-search01.api~a1', lastActivity: 'Edit src/search.ts' }),
      task({ key: 'ui', requestId: 'req-search01', title: '검색 화면', model: 'sonnet', status: 'reviewing', currentAttemptId: 'req-search01.ui~r1' }),
      task({ key: 'docs', requestId: 'req-search01', title: '문서 갱신', model: 'haiku', status: 'held', attempts: 2 }),
      task({ key: 'cache', requestId: 'req-search01', title: '캐시 계층', model: 'sonnet', status: 'verifying' }),
      task({ key: 'index', requestId: 'req-search01', title: '색인 스키마', model: 'sonnet', status: 'question', revision: 1,
        questions: [{ id: 'wq1', question: '색인을 SQLite FTS5로 만들까요?', options: ['FTS5', '단순 LIKE'], default: 'FTS5' }] }),
      task({ key: 'perf', requestId: 'req-search01', title: '성능 측정', model: 'opus', status: 'blocked', attempts: 3, note: '벤치마크가 3번 모두 시간 초과' }),
    ] }),
    request({ id: 'req-rss00001', text: '블로그 RSS 고치기', status: 'awaiting_acceptance', project: 'blog', updatedAt: iso(-90_000) }),
    request({ id: 'req-dark0001', text: '다크 모드', status: 'accepted', updatedAt: iso(-100_000), note: '병합 대기' }),
    request({ id: 'req-old00001', text: '설정 화면 정리', status: 'merged', updatedAt: iso(-3600_000), note: 'main에 병합됨 (abc1234)' }),
    request({ id: 'req-old00002', text: '알림 소리 바꾸기', status: 'failed', updatedAt: iso(-7200_000), note: '프로젝트가 git 저장소가 아님' }),
    request({ id: 'req-old00003', text: '오래된 요청', status: 'cancelled', updatedAt: iso(-9000_000), note: '회장님이 중단' }),
  ],
  approvals: [],
}

const clients = new Set<ServerResponse>()
setInterval(() => { for (const c of clients) c.write(`event: heartbeat\ndata: ${Date.now()}\n\n`) }, 10_000).unref()

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) return send(401, { error: 'no token' })
  if (req.method === 'GET' && url.pathname === '/api/state') return send(200, snapshot)
  if (req.method === 'GET' && /^\/api\/attempts\/[^/]+\/activity$/.test(url.pathname)) {
    const after = Number(url.searchParams.get('after') ?? 0)
    const all = ['Read src/search.ts', 'Bash npm test -- search (exit 1)', '테스트 2개 실패: 빈 검색어 처리', 'Edit src/search.ts', 'Bash npm test -- search (exit 0)', '보고서 작성 중']
      .map((text, i) => ({ at: iso(-(6 - i) * 60_000), kind: 'tool', text }))
    return send(200, { lines: all.slice(after), next: all.length })
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': connected\n\n'); clients.add(res); res.on('close', () => clients.delete(res)); return
  }
  if (req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      console.log(`POST ${url.pathname} ${body}`)
      if (url.pathname === '/api/ui-code') return send(200, { url: `http://127.0.0.1:${port}/ui/#code=mock` })
      // Stale revision → 409 with a Korean reason, so the pet's inline error path can be exercised.
      if (url.pathname.endsWith('/decide') || url.pathname.endsWith('/reject')) return send(409, { error: '이미 다른 결정이 반영됐어요 (revision 불일치)' })
      send(200, { ok: true })
    })
    return
  }
  send(404, { error: 'not found' })
}).listen(port, '127.0.0.1', () => console.log(`mock hq daemon on http://127.0.0.1:${port}`))
