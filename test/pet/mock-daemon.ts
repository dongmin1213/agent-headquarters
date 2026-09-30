// Mock hq daemon for the desk pet (no deps). Run: node test/pet/mock-daemon.ts [port]   (default 7788)
// Serves GET /api/state (fixture Snapshot), GET /api/events (SSE with heartbeat), and logs every POST.
// Then launch the pet: HQ_URL=http://127.0.0.1:7788 HQ_TOKEN_FILE=<file> HQ_ALLOW_SECOND_INSTANCE=1 pet/HQPet.app/Contents/MacOS/hqpet
import { createServer, type ServerResponse } from 'node:http'
import type { Snapshot, TaskView, RequestView, Approval } from '../../src/types.ts'

const port = Number(process.argv[2] ?? process.env.PORT ?? 7788)
const now = Date.now()
const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString()

function task(p: Partial<TaskView> & Pick<TaskView, 'key' | 'requestId' | 'title' | 'model' | 'status'>): TaskView {
  return { id: `${p.requestId}/${p.key}`, project: 'hq', role: 'build', grade: 'L1', attempts: 1, currentAttemptId: null,
    lastActivity: null, questions: [], note: null, headSha: null, updatedAt: iso(0), ...p }
}
function request(p: Partial<RequestView> & Pick<RequestView, 'id' | 'text' | 'status'>): RequestView {
  return { project: 'hq', note: null, turns: 1, costUsd: 0.12, questions: [], plan: null, tasks: [], updatedAt: iso(0), ...p }
}
function approval(id: string, title: string, body: string, options: string[]): Approval {
  return { id, teamId: 'ceo', title, body, options, subjectHash: 'h-' + id, expiresAt: iso(3600_000), createdAt: iso(-60_000), decision: null, decidedAt: null }
}

const snapshot: Snapshot = {
  updatedAt: iso(0),
  lastEventId: 1,
  teams: [],
  projects: [{ id: 'hq', name: 'agent-headquarters' }, { id: 'blog', name: 'blog' }],
  limit: { blockedUntil: null },
  headline: { text: '회장님 결정 3건: 계획 승인 — 로그인 화면 다듬기', needsYou: 3 },
  quota: { fiveHour: 0.42, sevenDay: 0.18, fiveHourResetsAt: iso(2 * 3600_000), sevenDayResetsAt: iso(4 * 86400_000), mode: 'normal', observedAt: iso(-30_000) },
  workers: [
    { attemptId: 'r2/api#a1', taskId: 'r2/api', requestId: 'r2', title: '검색 API 추가', project: 'hq', role: 'build', model: 'sonnet',
      kind: 'work', state: 'running', bubble: 'Edit src/search.ts', startedAt: iso(-5 * 60_000) },
    { attemptId: 'r2/ui#r1', taskId: 'r2/ui', requestId: 'r2', title: '검색 화면', project: 'hq', role: 'build', model: 'opus',
      kind: 'review', state: 'reviewing', bubble: 'Bash npm test', startedAt: iso(-2 * 60_000) },
    { attemptId: 'r2/docs#a2', taskId: 'r2/docs', requestId: 'r2', title: '문서 갱신', project: 'hq', role: 'collect', model: 'haiku',
      kind: 'work', state: 'held', bubble: '한도 보류 — 15:00까지', startedAt: iso(-20 * 60_000) },
  ],
  requests: [
    request({ id: 'r1', text: '로그인 화면 다듬기', status: 'planned',
      plan: { summary: '로그인 폼 검증과 오류 문구를 정리합니다.', assumptions: [], tasks: [
        { id: 'form', title: '폼 검증', project: 'hq', role: 'build', grade: 'L1', model: 'sonnet' },
        { id: 'copy', title: '오류 문구', project: 'hq', role: 'build', grade: 'L0', model: 'haiku' }] } }),
    request({ id: 'r2', text: '검색 기능 추가', status: 'executing', tasks: [
      task({ key: 'api', requestId: 'r2', title: '검색 API 추가', model: 'sonnet', status: 'running', currentAttemptId: 'r2/api#a1', lastActivity: 'Edit src/search.ts' }),
      task({ key: 'ui', requestId: 'r2', title: '검색 화면', model: 'sonnet', status: 'reviewing', currentAttemptId: 'r2/ui#r1' }),
      task({ key: 'docs', requestId: 'r2', title: '문서 갱신', model: 'haiku', status: 'held', attempts: 2 }),
      task({ key: 'index', requestId: 'r2', title: '색인 스키마', model: 'sonnet', status: 'question',
        questions: [{ question: '색인을 SQLite FTS5로 만들까요?', options: ['FTS5', '단순 LIKE'], default: 'FTS5' }] }),
      task({ key: 'perf', requestId: 'r2', title: '성능 측정', model: 'opus', status: 'blocked', attempts: 3, note: '벤치마크가 3번 모두 시간 초과' }),
    ] }),
    request({ id: 'r3', text: '블로그 RSS 고치기', status: 'awaiting_acceptance', project: 'blog', tasks: [
      task({ key: 'rss', requestId: 'r3', project: 'blog', title: 'RSS 날짜 형식', model: 'haiku', status: 'passed' })] }),
    request({ id: 'r4', text: '다크 모드', status: 'accepted', tasks: [
      task({ key: 'theme', requestId: 'r4', title: '테마 토큰', model: 'sonnet', status: 'passed' })] }),
  ],
  approvals: [
    approval('plan:r1', '계획 승인: 로그인 화면 다듬기', '작업 2개 · L1', ['승인', '반려']),
    approval('accept:r3', '결과 수락: 블로그 RSS 고치기', 'RSS 날짜 형식 · 파일 2개 변경 · 검사 통과 · 검토 통과', ['수락', '반려']),
    approval('merge:r4:hq', '다크 모드 → main', 'main@abc1234 에 브랜치 1개 병합', ['병합', '보류']),
  ],
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
      if (url.pathname === '/api/ui-code') return send(200, { url: `http://127.0.0.1:${port}/ui/open?code=mock` })
      send(200, { ok: true })
    })
    return
  }
  send(404, { error: 'not found' })
}).listen(port, '127.0.0.1', () => console.log(`mock hq daemon on http://127.0.0.1:${port}`))
