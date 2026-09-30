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
  return { revision: 0, taskId: null, detail: '', subjectHash: null, createdAt: iso(-3600_000 + 1000 * order++), ...p }
}

// v2 ids are URL-safe: request req-xxxxxxxx, task <req>.<key>, attempt <task>~a<n> / ~r<n>.
const decisions: DecisionItem[] = [
  decision({ kind: 'plan', id: 'plan:req-a1b2c3d4', requestId: 'req-a1b2c3d4', title: '계획 승인: 로그인 화면 다듬기',
    detail: '작업 2개 · 폼 검증(L1·sonnet), 오류 문구(L0·haiku)\ncheck: npm test -- login', options: ['승인', '반려'], subjectHash: 'h-plan' }),
  decision({ kind: 'ceo_question', id: 'q1', requestId: 'req-e5f6a7b8', title: '사장 질문: 모바일도 포함할까요?',
    detail: '요청에 화면 크기 언급이 없어요', options: ['포함', '데스크톱만'] }),
  decision({ kind: 'worker_question', id: 'wq1', requestId: 'req-search01', taskId: 'req-search01.index', revision: 1,
    title: '작업자 질문: 색인을 SQLite FTS5로 만들까요?', detail: '색인 스키마 · sonnet', options: ['FTS5', '단순 LIKE'] }),
  decision({ kind: 'revise', id: 'revise:req-search01.api', requestId: 'req-search01', taskId: 'req-search01.api', revision: 1,
    title: '지시서 수정안: 검색 API 추가', detail: 'owns에 src/db/** 추가 요청 (작업자가 막힘)', options: ['승인', '반려'], subjectHash: 'h-rev' }),
  decision({ kind: 'blocked', id: 'req-search01.perf', requestId: 'req-search01', taskId: 'req-search01.perf', revision: 0,
    title: '성능 측정이 막혔어요', detail: '3번 실패: 벤치마크 시간 초과', options: ['retry', 'skip', 'stop'] }),
  decision({ kind: 'integration', id: 'integration:req-search01:hq', requestId: 'req-search01', title: '통합 실패: agent-headquarters',
    detail: '충돌: src/server.ts', options: ['다시 통합', '요청 중단'], subjectHash: 'h-int' }),
  decision({ kind: 'accept', id: 'accept:req-rss00001', requestId: 'req-rss00001', title: '결과 수락: 블로그 RSS 고치기',
    detail: 'RSS 날짜 형식 · 파일 2개 · 검사 통과 · 검토 통과', options: ['수락', '반려'], subjectHash: 'h-acc' }),
  decision({ kind: 'merge', id: 'merge:req-dark0001:hq', requestId: 'req-dark0001', title: '병합 승인: 다크 모드 → main',
    detail: 'main@abc1234 ← integration@def5678', options: ['병합', '보류'], subjectHash: 'h-merge' }),
]

const snapshot: Snapshot = {
  updatedAt: iso(0),
  lastEventId: 1,
  teams: [{ id: 'revenue', name: '수익 자동화', pack: 'digimon', state: 'working', bubble: '상품 목록 갱신 중', lastRun: null, nextRunAt: null }],
  projects: [{ id: 'hq', name: 'agent-headquarters' }, { id: 'blog', name: 'blog' }],
  limit: { blockedUntil: null },
  decisions,
  headline: { text: `회장님 결정 ${decisions.length}건: 계획 승인 — 로그인 화면 다듬기`, needsYou: decisions.length },
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
      if (url.pathname.endsWith('/decide')) return send(409, { error: '이미 다른 결정이 반영됐어요 (revision 불일치)' })
      send(200, { ok: true })
    })
    return
  }
  send(404, { error: 'not found' })
}).listen(port, '127.0.0.1', () => console.log(`mock hq daemon on http://127.0.0.1:${port}`))
