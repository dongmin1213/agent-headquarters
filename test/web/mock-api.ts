// Fake daemon /api/* router for developing and testing the web UI without the execution engine.
// Fixtures conform to src/types.ts and cover every request/task/attempt status and every decision kind.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiRouter } from '../../src/server.ts'
import type { Approval, AttemptView, CheckResult, DecisionItem, HqEvent, RequestDetail, RequestView, Snapshot, TaskStatus, TaskView, Verdict, WorkerView } from '../../src/types.ts'

export interface MockCall { method: string; url: string; headers: IncomingMessage['headers']; body: string }
export interface MockApi {
  routeApi: ApiRouter
  calls: MockCall[]
  emit(e: Omit<HqEvent, 'at'>): void
  /** Stops live timers and closes SSE clients. */
  close(): void
  /** Ends every open SSE stream (to exercise client reconnects). */
  dropStreams(): void
}

export const XSS = '<script>alert("xss")</script><img src=x onerror=alert(1)>'

type DetailTask = RequestDetail['tasks'][number]

export function createMockApi(opts: { live?: boolean } = {}): MockApi {
  const t0 = Date.now()
  const ago = (min: number) => new Date(t0 - min * 60_000).toISOString()
  const ahead = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const calls: MockCall[] = []
  const clients = new Set<ServerResponse>()
  let eventId = 4120

  // ---------- requests ----------
  const R1 = 'req-7f3a9c21', R2 = 'req-2b81d0e4', R3 = 'req-c09e55a7', R4 = 'req-5d6e1f02', R5 = 'req-91aa7c3b', R6 = 'req-0e4f8812', R7 = 'req-3c7d2a90'

  const attempts = new Map<string, AttemptView[]>()
  const details = new Map<string, DetailTask[]>()

  function task(req: string, key: string, title: string, role: string, grade: string, model: string, status: TaskStatus, n: number, extra: Partial<DetailTask> = {}): DetailTask {
    const id = `${req}.${key}`
    const list: AttemptView[] = []
    for (let i = 1; i <= n; i++) {
      const last = i === n
      const started = 70 - i * 18
      const workStatus = last
        ? status === 'running' ? 'running' : status === 'question' ? 'question' : status === 'held' ? 'limited' : status === 'blocked' ? 'unverifiable' : status === 'pending' ? 'starting' : 'succeeded'
        : 'failed'
      list.push({ id: `${id}~a${i}`, taskId: id, kind: 'work', n: i, model: i === 3 ? 'opus' : model, status: workStatus as AttemptView['status'],
        startedAt: ago(started), endedAt: workStatus === 'running' || workStatus === 'starting' ? null : ago(started - 11 - i),
        costUsd: workStatus === 'running' || workStatus === 'starting' ? null : 0.18 + i * 0.21,
        reason: last ? (status === 'blocked' ? 'done.json 없음 — 종료 코드 0이지만 완료 계약을 확인할 수 없어요' : status === 'held' ? '5시간 한도 도달' : null)
          : i === 1 ? '기계 검증 실패: npm test (종료 코드 1) — 2개 테스트 실패' : '검토 blocking 1건: 세션 만료 처리 누락' })
      if (!last || ['reviewing', 'passed'].includes(status)) {
        const reviewStatus = !last ? 'failed' : status === 'reviewing' ? 'running' : 'succeeded'
        list.push({ id: `${id}~r${i}`, taskId: id, kind: 'review', n: i, model: model === 'opus' ? 'sonnet' : 'opus', status: reviewStatus as AttemptView['status'],
          startedAt: ago(started - 12), endedAt: reviewStatus === 'running' ? null : ago(started - 16), costUsd: reviewStatus === 'running' ? null : 0.31,
          reason: reviewStatus === 'failed' ? 'blocking: 쿠키 만료 경계값 테스트 없음' : null })
      }
    }
    if (status === 'rework') list[list.length - 1] = { ...list[list.length - 1], status: 'failed', reason: '기계 검증 실패: node --test (종료 코드 1)' }
    attempts.set(id, list)
    const cur = list.length ? list[list.length - 1].id : null
    const base: DetailTask = {
      id, key, requestId: req, project: 'hq', title, role, grade, model, status, attempts: list.filter((a) => a.kind === 'work').length,
      currentAttemptId: cur, lastActivity: null, questions: [], note: null, headSha: status === 'pending' ? null : sha(key), revision: 0, reviewModel: model === 'opus' ? 'sonnet' : 'opus', updatedAt: ago(n * 3),
      spec: { brief: `${title}.`, owns: [`src/${key}/**`], acceptance: [{ id: 'a1', text: '테스트 통과', check: 'node --test' }], depends_on: [] },
      branch: status === 'pending' ? null : `hq/${req}/${key}`, baseSha: 'e90ee5a41c2d8b7f', attemptsList: list,
    }
    return { ...base, ...extra }
  }

  const r1Tasks: DetailTask[] = [
    task(R1, 'schema', 'DB 스키마에 tasks·attempts 테이블 추가', 'implement', 'L1', 'sonnet', 'passed', 1, { lastActivity: '보고서 작성 완료' }),
    task(R1, 'runner', '작업자 프로세스 실행기 (detached spawn)', 'implement', 'L2', 'sonnet', 'running', 2, { lastActivity: 'Bash: node --test test/exec/runner.test.ts' }),
    task(R1, 'contract', '완료 계약 판정 순수 함수', 'implement', 'L1', 'haiku', 'verifying', 1, { lastActivity: '기계 검증: npm test 실행 중' }),
    task(R1, 'review', '교차 검토 실행과 verdict 검사', 'implement', 'L2', 'sonnet', 'reviewing', 1, { lastActivity: '검토자: test/exec/review.test.ts 실행' }),
    task(R1, 'ladder', '재작업 사다리와 회로 차단', 'implement', 'L2', 'sonnet', 'pending', 0),
    task(R1, 'quota', '한도 관측과 보류 스케줄', 'implement', 'L1', 'haiku', 'rework', 1, { lastActivity: '실패: node --test (2개 실패)', note: '재작업 2회차 대기 — 같은 모델' }),
    task(R1, 'merge', '로컬 병합과 worktree 정리', 'implement', 'L2', 'sonnet', 'held', 1, { note: '5시간 한도 93% — 18:40까지 보류' }),
    task(R1, 'recover', '재시작 복구 (process.json 확인)', 'implement', 'L3', 'opus', 'blocked', 3, { note: '3번 실패했어요: done.json 없음 (확인 불가)', lastActivity: '종료 코드 0, done.json 없음', revision: 1 }),
    task(R1, 'sandbox', '샌드박스 프로필 생성', 'implement', 'L2', 'sonnet', 'revising', 1, { note: 'CEO가 지시서를 고치는 중 (owns 확장 요청)' }),
    task(R1, 'notify', 'macOS 알림 문구 정리', 'collect', 'L0', 'haiku', 'question', 1, {
      lastActivity: '질문을 남기고 멈췄어요',
      questions: [{ id: 'wq-1a2b3c4d', question: '알림을 결정 항목이 생길 때마다 보낼까요, 아니면 5분에 한 번 묶어서 보낼까요?', options: ['매번', '5분 묶음'], default: '매번' },
        { id: 'wq-5e6f7a8b', question: `알림 제목 예시에 들어간 ${XSS} 같은 문자열은 그대로 둘까요?`, options: ['그대로', '제거'], default: '제거' }] }),
    task(R1, 'docs', 'README 실행 단계 문서화', 'collect', 'L0', 'haiku', 'cancelled', 0, { note: '회장님이 취소' }),
  ]
  details.set(R1, r1Tasks)
  const r4Tasks: DetailTask[] = [
    task(R4, 'parser', '활동 로그 변환기 (stream.jsonl → activity.jsonl)', 'implement', 'L1', 'sonnet', 'passed', 2),
    task(R4, 'ui', '펫 말풍선에 마지막 활동 표시', 'implement', 'L1', 'haiku', 'passed', 1),
  ]
  for (const t of r4Tasks) t.project = 'pet'
  details.set(R4, r4Tasks)
  const r5Tasks: DetailTask[] = [task(R5, 'fix', '요청 목록 정렬 버그 수정', 'implement', 'L0', 'haiku', 'passed', 1)]
  details.set(R5, r5Tasks)
  const r6Tasks: DetailTask[] = [task(R6, 'xss', `README 예시 ${XSS}`, 'implement', 'L0', 'haiku', 'passed', 1)]
  details.set(R6, r6Tasks)

  const view = (t: DetailTask): TaskView => { const { spec: _s, branch: _b, baseSha: _bs, attemptsList: _a, ...v } = t; return v }
  const planOf = (tasks: DetailTask[], summary: string, assumptions: string[]): RequestView['plan'] =>
    ({ summary, assumptions, tasks: tasks.map((t) => ({ id: t.key, title: t.title, project: t.project, role: t.role, grade: t.grade, model: t.model })) })

  const requests: RequestView[] = [
    { id: R1, project: 'hq', text: '실행 단계를 만들어 줘: 작업자 실행, 완료 계약, 기계 검증, 교차 검토, 재작업, 병합까지', status: 'executing', note: null, turns: 3, costUsd: 4.83,
      questions: [{ id: 'q-11aa22bb', question: '동시 작업자는 몇 명까지?', options: ['1', '2', '3'], default: '2', reason: '구독 한도를 넘지 않게', answer: '2' }],
      plan: planOf(r1Tasks, '실행 단계를 10개 작업으로 나눠 구현합니다. 스키마 → 실행기 → 판정 → 검토 → 사다리 순서이고, 병합은 수락 뒤 별도 승인입니다.',
        ['프로젝트는 모두 git 저장소다', '작업자는 push 권한이 없다', 'quota 관측은 stream의 rate_limit_event로 충분하다']),
      tasks: r1Tasks.map(view), updatedAt: ago(1) },
    { id: R2, project: 'blog', text: '블로그 글 목록에 태그 필터 추가하고 모바일에서 카드 간격 다듬기', status: 'planned', note: null, turns: 1, costUsd: 0.42, questions: [],
      plan: { summary: '태그 필터 컴포넌트와 모바일 카드 간격 수정, 두 작업으로 나눕니다.', assumptions: ['태그 데이터는 이미 frontmatter에 있다'],
        tasks: [{ id: 'filter', title: '태그 필터 컴포넌트', project: 'blog', role: 'implement', grade: 'L1', model: 'sonnet' }, { id: 'spacing', title: '모바일 카드 간격', project: 'blog', role: 'implement', grade: 'L0', model: 'haiku' }] },
      tasks: [], updatedAt: ago(6) },
    { id: R3, project: 'hq', text: '펫 캐릭터를 모델별로 다르게 보여 줘', status: 'asking', note: null, turns: 1, costUsd: 0.21,
      questions: [{ id: 'q-5e6f7a8b', question: 'haiku·sonnet·opus 캐릭터를 어느 팩에서 고를까요?', options: ['포켓몬', '디지몬', '섞어서'], default: '포켓몬', reason: '팩마다 스프라이트 크기가 달라 표시 방식이 바뀝니다', answer: null },
        { id: 'q-9c0d1e2f', question: '작업이 끝난 캐릭터는 바로 사라지게 할까요?', options: ['바로', '10초 뒤'], default: '10초 뒤', reason: '완료를 눈으로 확인할 시간', answer: null }],
      plan: null, tasks: [], updatedAt: ago(9) },
    { id: R4, project: 'pet', text: '활동 로그를 펫 말풍선에 한 줄로 보여 주기', status: 'awaiting_acceptance', note: null, turns: 2, costUsd: 1.37, questions: [],
      plan: planOf(r4Tasks, '활동 로그 변환기와 말풍선 표시 두 작업.', ['말풍선은 60자에서 자른다']), tasks: r4Tasks.map(view), updatedAt: ago(14) },
    { id: R5, project: 'hq', text: '요청 목록이 가끔 역순으로 나오는 버그 고치기', status: 'accepted', note: null, turns: 1, costUsd: 0.36, questions: [],
      plan: planOf(r5Tasks, '정렬 기준을 created_at desc로 고정.', []), tasks: r5Tasks.map(view), updatedAt: ago(22) },
    { id: R6, project: 'hq', text: `README에 ${XSS} 예시 추가`, status: 'merged', note: `병합 완료 ${XSS}`, turns: 1, costUsd: 0.12, questions: [],
      plan: planOf(r6Tasks, `예시 코드 블록 추가 ${XSS}`, [XSS]), tasks: r6Tasks.map(view), updatedAt: ago(180) },
    { id: R7, project: 'blog', text: '배포 스크립트를 GitHub Actions로 옮기기', status: 'failed', note: '프로젝트가 git 저장소가 아니에요 (~/Sites/blog-old)', turns: 1, costUsd: 0.09, questions: [], plan: null, tasks: [], updatedAt: ago(60 * 26) },
  ]

  const approvals: Approval[] = [
    { id: `accept:${R4}`, teamId: 'ceo', title: '결과 수락: 활동 로그를 펫 말풍선에', body: 'parser — 파일 4개 변경 · 검사 3/3 통과 · 검토 통과 (advisory 1)\nui — 파일 2개 변경 · 검사 2/2 통과 · 검토 통과',
      options: ['수락', '반려'], subjectHash: 'h-accept-5d6e', expiresAt: ahead(60 * 20), createdAt: ago(14), decision: null, decidedAt: null },
    { id: `merge:${R5}:hq`, teamId: 'ceo', title: '병합 승인: hq ← hq/req-91aa7c3b/fix', body: '대상 브랜치 main @ 4c1e9a0\n병합할 커밋 1개: 요청 목록 정렬 버그 수정',
      options: ['병합', '보류'], subjectHash: 'h-merge-91aa', expiresAt: ahead(60 * 23), createdAt: ago(20), decision: null, decidedAt: null },
    { id: `plan:${R2}`, teamId: 'ceo', title: '계획 승인: 태그 필터 컴포넌트와 모바일 카드 간격 수정', body: 'filter [L1·sonnet] 태그 필터 컴포넌트\n  check: npm test -- tags\nspacing [L0·haiku] 모바일 카드 간격\n  check: manual',
      options: ['승인', '반려'], subjectHash: 'h-plan-2b81', expiresAt: ahead(60 * 18), createdAt: ago(6), decision: null, decidedAt: null },
    { id: `revise:${R1}.sandbox`, teamId: 'ceo', title: '지시서 수정 승인: 샌드박스 프로필 생성', body: '- owns: src/exec/sandbox.ts\n+ owns: src/exec/sandbox.ts, src/exec/profiles/**\n  이유: 프로필 템플릿을 별도 파일로 두어야 검사가 가능',
      options: ['승인', '반려'], subjectHash: 'h-revise-sbx', expiresAt: ahead(60 * 24 * 30), createdAt: ago(12), decision: null, decidedAt: null },
    { id: `integration:${R5}:blog`, teamId: 'ceo', title: '통합 실패: blog', body: `충돌 파일: src/list.ts\ncheck 실패: npm test (종료 코드 1) ${XSS}`,
      options: ['다시 통합', '요청 중단'], subjectHash: 'h-integ-91aa', expiresAt: ahead(60 * 24 * 30), createdAt: ago(18), decision: null, decidedAt: null },
    { id: 'team:blog:publish-2026-09-30', teamId: 'blog', title: `새 글 발행: 주간 회고 ${XSS}`, body: '초안 1,840자 · 이미지 2개 · 예약 발행 09:00', options: ['발행', '보류', '폐기'],
      subjectHash: 'h-blog-0930', expiresAt: ahead(90), createdAt: ago(40), decision: null, decidedAt: null },
  ]

  const workers: WorkerView[] = [
    { attemptId: `${R1}.runner~a2`, taskId: `${R1}.runner`, requestId: R1, title: '작업자 프로세스 실행기 (detached spawn)', project: 'hq', role: 'implement', model: 'sonnet', kind: 'work', state: 'running', bubble: 'Bash: node --test test/exec/runner.test.ts', startedAt: ago(34) },
    { attemptId: `${R1}.contract~a1`, taskId: `${R1}.contract`, requestId: R1, title: '완료 계약 판정 순수 함수', project: 'hq', role: 'implement', model: 'haiku', kind: 'verify', state: 'verifying', bubble: '기계 검증: npm test 실행 중', startedAt: ago(4) },
    { attemptId: `${R1}.review~r1`, taskId: `${R1}.review`, requestId: R1, title: '교차 검토 실행과 verdict 검사', project: 'hq', role: 'implement', model: 'opus', kind: 'review', state: 'reviewing', bubble: '검토자: test/exec/review.test.ts 실행', startedAt: ago(8) },
  ]

  // ---------- evidence ----------
  const activity = new Map<string, { at: string; kind: string; text: string }[]>()
  const runnerLines = [
    ['message', '실행기 구조를 먼저 살펴볼게요. src/exec 폴더가 비어 있어서 새로 만듭니다.'],
    ['tool', 'Read src/types.ts'], ['tool', 'Read docs/design/execution.md'], ['tool', 'Write src/exec/runner.ts'],
    ['tool', 'Bash: node --test test/exec/runner.test.ts'], ['error', 'AssertionError: expected process.json to exist before spawn returns'],
    ['message', 'process.json을 spawn 직후 원자적으로 쓰도록 고칩니다 (임시 파일 → rename).'], ['tool', 'Edit src/exec/runner.ts'],
    ['tool', 'Bash: node --test test/exec/runner.test.ts'], ['message', `테스트 7개 통과. 출력에 ${XSS} 같은 문자열이 있어도 그대로 기록합니다.`],
    ['tool', 'Bash: git add -A && git commit -m "exec: detached runner"'], ['usage', '입력 182,340 · 출력 9,812 토큰 · $0.61'],
  ]
  const base = t0 - 34 * 60_000
  activity.set(`${R1}.runner~a2`, runnerLines.map(([kind, text], i) => ({ at: new Date(base + i * 150_000).toISOString(), kind, text })))
  activity.set(`${R1}.runner~a1`, [{ at: ago(60), kind: 'message', text: '첫 시도: 실행기 뼈대 작성' }, { at: ago(55), kind: 'tool', text: 'Write src/exec/runner.ts' }, { at: ago(52), kind: 'error', text: 'npm test 실패 (종료 코드 1)' }])
  for (const [id] of attempts) if (!activity.has(`${id}~a1`)) activity.set(`${id}~a1`, [{ at: ago(30), kind: 'message', text: '작업을 시작합니다.' }, { at: ago(25), kind: 'tool', text: `Edit src/${id.split('.')[1]}/index.ts` }, { at: ago(20), kind: 'usage', text: '입력 40,120 · 출력 3,004 토큰 · $0.18' }])

  const report = `## 요약
작업자 프로세스를 \`detached: true\`로 띄우고, spawn 직후 \`process.json\`을 **원자적으로** 기록하도록 구현했습니다. 데몬이 재시작돼도 pid와 시작 시각으로 같은 프로세스인지 확인할 수 있습니다. 수용 기준 3개를 모두 직접 실행해 확인했습니다.

## 수용 기준별 확인
| 기준 | 명령 | 종료 코드 |
| --- | --- | --- |
| a1 | \`node --test test/exec/runner.test.ts\` | 0 |
| a2 | \`npx tsc --noEmit\` | 0 |
| a3 | manual | — |

### 변경 사항
- \`src/exec/runner.ts\` 새 파일: spawn, stdout/stderr 파일 연결
- \`test/exec/runner.test.ts\`: 7개 테스트
1. 임시 파일 → rename
2. 환경변수에서 \`CLAUDECODE\` 제거

> 주의: ${XSS} 는 문자 그대로 보여야 합니다. [링크](javascript:alert(1)) 도 텍스트입니다.

\`\`\`ts
const child = spawn('claude', argv, { detached: true, stdio: ['pipe', out, err] })
writeAtomic(join(dir, 'process.json'), { pid: child.pid, startedAt })
\`\`\`
`
  const checks: { checks: CheckResult[]; secrets: string[]; pass: boolean } = {
    checks: [
      { id: 'a1', command: 'node --test test/exec/runner.test.ts', exitCode: 0, durationMs: 4210, pass: true, outputTail: '▶ runner\n  ✔ writes process.json atomically (12ms)\n  ✔ strips CLAUDECODE (3ms)\n✔ runner (41ms)\nℹ tests 7\nℹ pass 7\nℹ fail 0' },
      { id: 'a2', command: 'npx tsc --noEmit', exitCode: 0, durationMs: 9832, pass: true, outputTail: '' },
      { id: 'a4', command: 'node --test test/exec/recover.test.ts', exitCode: 1, durationMs: 1203, pass: false, outputTail: `✖ recovers running attempt (8ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  'running' !== 'start_failed'\n${XSS}\nℹ fail 1` },
    ],
    secrets: [], pass: false,
  }
  const verdict: Verdict = {
    pass: false,
    blocking: [{ id: 'b1', summary: '세션 만료 경계값(정확히 12시간) 처리 테스트가 없습니다', evidence: `test/web/auth.test.ts 에 경계 케이스 없음 · ${XSS}` }],
    advisory: [{ id: 'v1', summary: 'runner.ts의 오류 메시지를 한국어로 통일하면 좋겠습니다' }, { id: 'v2', summary: 'spawn 실패 시 stderr.log 경로를 note에 남기기' }],
    criteria: [{ id: 'a1', result: 'pass', evidence: 'node --test 7/7 통과' }, { id: 'a2', result: 'pass', evidence: 'tsc 오류 없음' }, { id: 'a3', result: 'manual', evidence: '사람 확인 필요' }, { id: 'a4', result: 'fail', evidence: 'recover 테스트 1개 실패' }],
    tests_run: [{ command: 'node --test test/exec/', exit_code: 1, summary: '15개 중 14개 통과' }, { command: 'npx tsc --noEmit', exit_code: 0, summary: '오류 없음' }],
    task: `${R1}.review`, head_sha: sha('review'), base_sha: 'e90ee5a41c2d8b7f', reviewer_model: 'opus', implementer_model: 'sonnet', sameFamily: true,
  }
  const diff = `diff --git a/src/exec/runner.ts b/src/exec/runner.ts
new file mode 100644
index 0000000..3f9a1c2
--- /dev/null
+++ b/src/exec/runner.ts
@@ -0,0 +1,14 @@
+// Starts a worker attempt as a detached process group.
+import { spawn } from 'node:child_process'
+import { writeAtomic } from './fsutil.ts'
+
+export function startAttempt(dir: string, argv: string[], cwd: string) {
+  const env = { ...process.env, HQ_ATTEMPT_DIR: dir }
+  delete env.CLAUDECODE
+  const child = spawn('claude', argv, { cwd, env, detached: true })
+  writeAtomic(dir + '/process.json', { pid: child.pid, startedAt: new Date().toISOString() })
+  child.unref()
+  // ${XSS}
+  return child.pid
+}
+
diff --git a/src/store.ts b/src/store.ts
index 8d2e1f0..b71c3aa 100644
--- a/src/store.ts
+++ b/src/store.ts
@@ -41,7 +41,9 @@ export class Store {
   constructor(path: string) {
     this.db = new DatabaseSync(path)
-    this.db.exec('pragma journal_mode = wal')
+    this.db.exec(\`pragma journal_mode = wal;
+      pragma busy_timeout = 5000\`)
+    this.migrate()
   }

   requests(limit: number) {
@@ -88,4 +90,3 @@ export class Store {
-  // TODO attempts
-  legacy() { return null }
+  attempts(taskId: string) { return this.db.prepare('select * from attempts where task_id = ?').all(taskId) }
 }
\\ No newline at end of file
diff --git a/docs/logo.png b/docs/logo.png
index 1b2c3d4..5e6f7a8 100644
Binary files a/docs/logo.png and b/docs/logo.png differ
`

  // ---------- helpers ----------
  const allTasks = () => [...details.values()].flat()
  /** The daemon builds this list (execution.md §17); the mock mirrors its order: plan → ceo_question → worker_question → revise → blocked → integration → accept → merge → team. */
  type Explain = Pick<DecisionItem, 'situation' | 'cause' | 'causeConfirmed' | 'recommendation' | 'optionHelp' | 'detailPath'>
  const HELP: Record<string, string> = {
    retry: '같은 작업을 같은 모델로 한 번 더 해요 · 사용량이 들어요',
    skip: '이 작업과 여기에 의존하는 작업을 빼고 계속해요 · 나중에 새 요청으로 다시 할 수 있어요',
    stop: '요청 전체를 멈춰요 · 만든 브랜치는 남겨 둬요',
    수락: '통합본을 병합 대기로 넘겨요 · 병합은 따로 승인해요',
    반려: '사유를 붙여 다시 작업시켜요',
    병합: '대상 브랜치에 fast-forward로 반영해요',
    보류: '지금은 병합하지 않고 둬요 · 나중에 다시 제시할 수 있어요',
  }
  const help = (opts: string[], extra: Record<string, string> = {}) => Object.fromEntries(opts.map((o) => [o, extra[o] ?? HELP[o] ?? '']).filter(([, v]) => v))
  const detailPath = (requestId: string, taskId: string | null) => `/ui/#request=${encodeURIComponent(requestId)}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}`
  /** Explanation fields per decision (execution.md §17 "결정 카드 설명"): with a recommendation, without one, and a cause marked 추정. */
  const EXPLAIN: Record<string, Omit<Explain, 'optionHelp' | 'detailPath'> & { help?: Record<string, string> }> = {
    [`plan:${R2}`]: { situation: '태그 필터 계획이 준비됐어요 · 작업 2개(필터 컴포넌트, 모바일 카드 간격)로 나눴어요', cause: null, causeConfirmed: false,
      recommendation: { option: '승인', reason: '요청 범위와 일치하고 둘 다 작은 작업이라 사용량 부담이 적어요' },
      help: { 승인: '작업자 2명이 바로 시작해요', 반려: '사유를 붙여 사장이 계획을 다시 짜요' } },
    'q-5e6f7a8b': { situation: '펫 캐릭터를 모델별로 다르게 보여 주려면 캐릭터 팩을 먼저 정해야 해요', cause: null, causeConfirmed: false,
      recommendation: { option: '포켓몬', reason: '이미 사장 캐릭터(피카츄)가 포켓몬이라 한 팩으로 맞추면 크기가 일정해요' },
      help: { 포켓몬: '사장과 같은 팩으로 맞춰요', 디지몬: '작업자만 디지몬으로 바꿔요 · 스프라이트 크기 조정이 필요해요', 섞어서: '모델마다 팩을 섞어요 · 표시 규칙이 복잡해져요' } },
    'q-9c0d1e2f': { situation: '작업이 끝난 캐릭터를 언제 치울지 정해야 해요', cause: null, causeConfirmed: false, recommendation: null,
      help: { 바로: '끝나는 즉시 사라져요', '10초 뒤': '완료 표시를 10초 보여 주고 사라져요' } },
    'wq-1a2b3c4d': { situation: '알림 작업자가 알림을 보내는 주기를 묻고 있어요', cause: null, causeConfirmed: false,
      recommendation: { option: '매번', reason: '결정은 늦게 알수록 작업이 멈춰 있는 시간이 길어져요' },
      help: { 매번: '결정이 생길 때마다 바로 알려요', '5분 묶음': '5분마다 모아서 한 번에 알려요 · 알림이 줄어요' } },
    'wq-5e6f7a8b': { situation: `알림 제목 예시에 ${XSS} 같은 문자열이 들어 있어요`, cause: null, causeConfirmed: false, recommendation: null,
      help: { 그대로: '예시 문자열을 남겨요', 제거: '예시에서 빼요' } },
    [`revise:${R1}.sandbox`]: { situation: '샌드박스 작업자가 지시서의 담당 파일 범위를 넓혀 달라고 했어요', cause: '프로필 템플릿을 별도 파일로 둬야 검사를 돌릴 수 있어요 (작업자 보고 · 검사 로그 확인)', causeConfirmed: true,
      recommendation: { option: '승인', reason: '넓히는 범위가 src/exec/profiles/** 하나뿐이고 다른 작업과 겹치지 않아요' },
      help: { 승인: '고친 지시서로 작업을 이어가요', 반려: '원래 범위 안에서 다시 하게 해요' } },
    [`${R1}.recover`]: { situation: '재시작 복구 작업이 3번 시도했지만 끝났다는 표시(done.json)를 남기지 못했어요', cause: '작업자가 종료 코드 0으로 끝났지만 done.json을 쓰기 전에 프로세스가 끝난 것 같아요', causeConfirmed: false,
      recommendation: { option: 'retry', reason: '실패 원인이 코드가 아니라 마무리 단계로 보여 같은 모델로 한 번 더 하면 풀릴 가능성이 높아요' } },
    [`integration:${R5}:blog`]: { situation: 'blog 브랜치를 합치는 중에 충돌이 나고 검사가 실패했어요', cause: `src/list.ts가 두 작업에서 함께 바뀌었고 npm test가 종료 코드 1로 실패했어요 ${XSS}`, causeConfirmed: true,
      recommendation: { option: '다시 통합', reason: '충돌이 파일 하나뿐이라 순서를 바꿔 다시 합치면 풀릴 수 있어요' },
      help: { '다시 통합': '작업 순서를 바꿔 다시 합쳐요 · 사용량이 조금 들어요', '요청 중단': '요청 전체를 멈춰요 · 만든 브랜치는 남겨 둬요' } },
    [`accept:${R4}`]: { situation: '작업 2개가 검사·검토를 통과했어요 · 결과를 확인하고 수락해 주세요', cause: null, causeConfirmed: false, recommendation: null },
    [`merge:${R5}:hq`]: { situation: 'hq/req-91aa7c3b/fix를 main(4c1e9a0)에 병합할 차례예요 · 커밋 1개, 파일 2개 변경', cause: null, causeConfirmed: false, recommendation: null },
  }
  function explain(id: string, requestId: string, taskId: string | null, options: string[]): Explain {
    const e = EXPLAIN[id] ?? { situation: '', cause: null, causeConfirmed: false, recommendation: null }
    return { situation: e.situation, cause: e.cause, causeConfirmed: e.causeConfirmed, recommendation: e.recommendation, optionHelp: help(options, e.help), detailPath: detailPath(requestId, taskId) }
  }
  function decisionItems(): DecisionItem[] {
    const open = approvals.filter((a) => a.decision === null)
    const fromApproval = (prefix: string, kind: DecisionItem['kind']): DecisionItem[] => open.filter((a) => a.id.startsWith(prefix)).map((a) => {
      const rest = a.id.slice(prefix.length)
      const requestId = rest.split(/[.:]/)[0]
      const taskId = kind === 'revise' ? rest : null
      return { kind, id: a.id, revision: kind === 'revise' ? 1 : 0, requestId, taskId, title: a.title, detail: a.body, ...explain(a.id, requestId, taskId, a.options), options: a.options, subjectHash: a.subjectHash, createdAt: a.createdAt }
    })
    const ceoQ: DecisionItem[] = requests.filter((r) => r.status === 'asking').flatMap((r) => r.questions.filter((q) => q.answer === null).map((q) => ({
      kind: 'ceo_question' as const, id: q.id, revision: 0, requestId: r.id, taskId: null, title: q.question, detail: `이유: ${q.reason}\n기본값: ${q.default}`, ...explain(q.id, r.id, null, q.options), options: q.options, subjectHash: null, createdAt: r.updatedAt })))
    const workerQ: DecisionItem[] = allTasks().filter((t) => t.status === 'question').flatMap((t) => t.questions.map((q) => ({
      kind: 'worker_question' as const, id: q.id, revision: t.revision, requestId: t.requestId, taskId: t.id, title: q.question, detail: `${t.title} · 기본값: ${q.default}`, ...explain(q.id, t.requestId, t.id, q.options), options: q.options, subjectHash: null, createdAt: t.updatedAt })))
    const blocked: DecisionItem[] = allTasks().filter((t) => t.status === 'blocked').map((t) => ({
      kind: 'blocked' as const, id: t.id, revision: t.revision, requestId: t.requestId, taskId: t.id, title: `작업이 막혔어요: ${t.title}`, detail: t.note ?? '',
      ...explain(t.id, t.requestId, t.id, ['retry', 'skip', 'stop']), options: ['retry', 'skip', 'stop'], subjectHash: null, createdAt: t.updatedAt }))
    return [...fromApproval('plan:', 'plan'), ...ceoQ, ...workerQ, ...fromApproval('revise:', 'revise'), ...blocked, ...fromApproval('integration:', 'integration'),
      ...fromApproval('accept:', 'accept'), ...fromApproval('merge:', 'merge'), ...teamItems(open)]
  }
  /** Team cards (posted by team commands): same shape the daemon builds in src/exec/decisions.ts. */
  const TEAM_NAMES: Record<string, string> = { blog: '블로그 팀' }
  const teamHelp = (o: string) => o === '보류' ? '지금은 고르지 않아요 · 팀이 나중에 다시 물어요' : o === '반려' ? '팀이 이 항목을 진행하지 않아요' : '이 선택으로 팀이 다음 단계를 진행해요'
  function teamItems(open: Approval[]): DecisionItem[] {
    return open.filter((a) => a.id.startsWith('team:')).map((a) => {
      const name = TEAM_NAMES[a.teamId] ?? a.teamId
      return { kind: 'team' as const, teamId: a.teamId, id: a.id, revision: 0, requestId: '', taskId: null, title: `${name} · ${a.title}`, detail: a.body,
        situation: `${/팀$/.test(name) ? name : `${name} 팀`}이 회장님 결정을 기다려요`, cause: null, causeConfirmed: false, recommendation: null,
        optionHelp: Object.fromEntries(a.options.map((o) => [o, teamHelp(o)])), detailPath: null, options: a.options, subjectHash: a.subjectHash, createdAt: a.createdAt }
    })
  }

  function snapshot(): Snapshot {
    const open = approvals.filter((a) => a.decision === null)
    for (const r of requests) if (details.has(r.id)) r.tasks = details.get(r.id)!.map(view)
    const decisions = decisionItems()
    const needs = decisions.length
    return {
      updatedAt: new Date().toISOString(), lastEventId: eventId, teams: [
        { id: 'blog', name: '블로그 팀', pack: 'digimon', state: 'waiting', bubble: '발행 승인 대기', lastRun: { id: 88, teamId: 'blog', startedAt: ago(45), endedAt: ago(41), exitCode: 0, summary: '초안 작성' }, nextRunAt: ahead(60) },
      ],
      approvals: open, requests, projects: [{ id: 'hq', name: 'agent-headquarters' }, { id: 'blog', name: '블로그' }, { id: 'pet', name: '데스크 펫' }],
      limit: { blockedUntil: null }, workers, decisions,
      headline: needs ? { text: `회장님 결정 ${needs}건: ${decisions[0].title}`, needsYou: needs } : { text: '지금 하실 일은 없어요', needsYou: 0 },
      quota: {
        windows: [
          { name: 'five_hour', utilization: 0.72, resetsAt: ahead(95), status: 'allowed' },
          { name: 'seven_day', utilization: 0.41, resetsAt: ahead(60 * 24 * 3 + 200), status: 'allowed' },
          { name: 'seven_day_opus', utilization: 0.88, resetsAt: ahead(60 * 24 * 2), status: 'allowed_warning' },
        ],
        fiveHour: 0.72, sevenDay: 0.41, fiveHourResetsAt: ahead(95), sevenDayResetsAt: ahead(60 * 24 * 3 + 200), mode: 'save', observedAt: ago(1),
      },
    }
  }

  function emit(e: Omit<HqEvent, 'at'>): void {
    const ev: HqEvent = { at: new Date().toISOString(), id: ++eventId, ...e }
    const payload = `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`
    for (const c of clients) c.write(payload)
  }

  const timers: NodeJS.Timeout[] = []
  if (opts.live) {
    let k = 0
    const extra = ['tool', 'Read src/exec/runner.ts', 'message', '다음: 재시작 복구와 연결되는 부분 확인', 'tool', 'Bash: npx tsc --noEmit', 'tool', 'Grep "attempt_token" src/']
    timers.push(setInterval(() => {
      const list = activity.get(`${R1}.runner~a2`)!
      const i = (k++ % (extra.length / 2)) * 2
      list.push({ at: new Date().toISOString(), kind: extra[i], text: extra[i + 1] })
      workers[0].bubble = extra[i + 1]
      const t = r1Tasks[1]; t.lastActivity = extra[i + 1]; t.updatedAt = new Date().toISOString()
      emit({ kind: 'attempt', text: extra[i + 1], data: { id: `${R1}.runner~a2`, requestId: R1 } })
    }, 4000))
    timers.push(setInterval(() => { for (const c of clients) c.write(`event: heartbeat\ndata: ${Date.now()}\n\n`) }, 15000))
  }

  function send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  const routeApi: ApiRouter = async (req, res) => {
    let raw = ''
    if (req.method !== 'GET') for await (const chunk of req) raw += chunk
    calls.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers }, body: raw })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const b = raw ? JSON.parse(raw) : {}
    if (req.headers.authorization !== 'Bearer mock-token' && req.headers.authorization !== `Bearer ${process.env.HQ_MOCK_TOKEN ?? 'mock-token'}`) return send(res, 401, { error: '인증이 필요해요' })
    if (req.method === 'GET') {
      if (url.pathname === '/api/state') return send(res, 200, snapshot())
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': connected\n\n')
        clients.add(res)
        res.on('close', () => clients.delete(res))
        return
      }
      if (parts[1] === 'requests' && parts.length === 3) {
        const r = requests.find((x) => x.id === parts[2])
        if (!r) return send(res, 404, { error: '찾을 수 없어요' })
        const detail: RequestDetail = { request: r, tasks: details.get(r.id) ?? [] }
        return send(res, 200, detail)
      }
      if (parts[1] === 'requests' && parts[3] === 'diff') {
        const key = url.searchParams.get('task')
        const t = (details.get(parts[2]) ?? []).find((x) => x.key === key)
        if (!t) return send(res, 404, { error: '찾을 수 없어요' })
        if (!t.headSha) return send(res, 200, { files: [], diff: '', truncated: false })
        return send(res, 200, { files: [{ path: 'src/exec/runner.ts', added: 14, removed: 0 }, { path: 'src/store.ts', added: 4, removed: 3 }, { path: 'docs/logo.png', added: 0, removed: 0 },
          { path: `src/huge-generated-${'x'.repeat(40)}.ts`, added: 20480, removed: 0 }], diff, truncated: true })
      }
      if (parts[1] === 'attempts' && parts[3] === 'activity') {
        const after = Number(url.searchParams.get('after') ?? 0) || 0
        const all = activity.get(parts[2]) ?? []
        const lines = all.slice(after, after + 500)
        return send(res, 200, { lines, next: after + lines.length })
      }
      if (parts[1] === 'attempts' && parts[3] === 'files') {
        const id = parts[2], name = parts[4]
        const a = [...attempts.values()].flat().find((x) => x.id === id)
        if (!a || a.status === 'running' || a.status === 'starting') return send(res, 404, { error: '찾을 수 없어요' })
        // Evidence files are served as text/plain + nosniff (execution.md §15).
        const plain = (body: string) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }); res.end(body) }
        if (name === 'report.md' && a.kind === 'work') return plain(report)
        if (name === 'checks.json' && a.kind === 'work') return plain(JSON.stringify(a.status === 'succeeded' ? { ...checks, checks: checks.checks.slice(0, 2), pass: true } : checks))
        if (name === 'verdict.json' && a.kind === 'review') return plain(JSON.stringify(a.status === 'succeeded' ? { ...verdict, pass: true, blocking: [], criteria: verdict.criteria.slice(0, 3) } : verdict))
        return send(res, 404, { error: '찾을 수 없어요' })
      }
      if (url.pathname === '/api/quota') return send(res, 200, snapshot().quota)
    }
    if (req.method === 'POST') {
      if (parts[1] === 'approvals' && parts.length === 3) {
        const a = approvals.find((x) => x.id === parts[2] && x.decision === null)
        if (a && a.id.startsWith('accept:') && b.decision === '반려') return send(res, 409, { error: '반려는 사유와 함께 따로 보내 주세요' })
        if (!a || a.subjectHash !== b.subjectHash || !a.options.includes(b.decision)) return send(res, 409, { error: '이미 결정됐거나 내용이 바뀐 카드예요' })
        a.decision = b.decision; a.decidedAt = new Date().toISOString()
        emit({ kind: 'approval', teamId: a.teamId, text: `결정: ${a.title} → ${a.decision}`, data: { id: a.id } })
        return send(res, 200, a)
      }
      if (parts[1] === 'requests' && parts[3] === 'answer') {
        const r = requests.find((x) => x.id === parts[2])
        const q = r?.questions.find((x) => x.id === b.questionId && x.answer === null)
        if (!r || !q || typeof b.answer !== 'string' || !b.answer) return send(res, 409, { error: '이미 답했거나 없는 질문이에요' })
        q.answer = b.answer
        if (r.questions.every((x) => x.answer !== null)) r.status = 'thinking'
        emit({ kind: 'request', text: '답변 받음', data: { id: r.id } })
        return send(res, 200, { ok: true })
      }
      if (parts[1] === 'requests' && parts[3] === 'reject') {
        const r = requests.find((x) => x.id === parts[2])
        if (!r || typeof b.reason !== 'string' || !b.reason.trim()) return send(res, 400, { error: '반려 사유가 필요해요' })
        const acceptCard = approvals.find((x) => x.id === `accept:${r.id}` && x.decision === null)
        if (!acceptCard || b.subjectHash !== acceptCard.subjectHash) return send(res, 409, { error: '수락 카드가 바뀌었거나 이미 결정됐어요' })
        r.status = 'executing'
        const a = approvals.find((x) => x.id === `accept:${r.id}`); if (a) { a.decision = '반려'; a.decidedAt = new Date().toISOString() }
        const only: string[] | null = Array.isArray(b.tasks) && b.tasks.length ? b.tasks : null
        for (const t of details.get(r.id) ?? []) if (t.status === 'passed' && (!only || only.includes(t.key))) { t.status = 'rework'; t.note = `반려: ${b.reason}` }
        emit({ kind: 'request', text: '결과 반려', data: { id: r.id } })
        return send(res, 200, { ok: true })
      }
      if (parts[1] === 'requests' && parts[3] === 'cancel') {
        const r = requests.find((x) => x.id === parts[2]); if (!r) return send(res, 404, { error: '찾을 수 없어요' })
        r.status = 'cancelled'; emit({ kind: 'request', text: '요청 중단', data: { id: r.id } }); return send(res, 200, { ok: true })
      }
      if (parts[1] === 'requests' && parts[3] === 'merge') {
        const r = requests.find((x) => x.id === parts[2]); if (!r) return send(res, 404, { error: '찾을 수 없어요' })
        return send(res, 409, { error: '다시 제시할 보류된 병합이 없어요' })
      }
      if (parts[1] === 'requests' && parts.length === 2) {
        if (typeof b.text !== 'string' || !b.text) return send(res, 400, { error: '요청 내용이 필요해요' })
        return send(res, 201, { id: 'req-new00001' })
      }
      if (parts[1] === 'tasks' && (parts[3] === 'answer' || parts[3] === 'decide')) {
        const t = allTasks().find((x) => x.id === parts[2])
        if (!t) return send(res, 404, { error: '찾을 수 없어요' })
        if (b.revision !== t.revision) return send(res, 409, { error: `지시서가 바뀌었어요 (리비전 ${t.revision}). 새 내용을 확인해 주세요` })
        if (parts[3] === 'answer') {
          const qi = t.questions.findIndex((q) => q.id === b.questionId)
          if (t.status !== 'question' || qi < 0 || typeof b.answer !== 'string' || !b.answer) return send(res, 409, { error: '이미 답했거나 없는 질문이에요' })
          t.questions.splice(qi, 1)
          if (!t.questions.length) { t.status = 'running'; t.lastActivity = '답변을 받아 이어서 진행' }
        } else {
          if (t.status !== 'blocked' || !['retry', 'skip', 'stop'].includes(b.decision)) return send(res, 409, { error: '막힌 작업이 아니거나 알 수 없는 결정이에요' })
          t.status = b.decision === 'retry' ? 'pending' : 'cancelled'
          t.note = b.decision === 'retry' ? '같은 모델로 한 번 더' : '회장님 결정으로 취소'
          if (b.decision === 'stop') { const r = requests.find((x) => x.id === t.requestId); if (r) r.status = 'cancelled' }
        }
        t.updatedAt = new Date().toISOString()
        emit({ kind: 'task', text: '작업 갱신', data: { id: t.id, requestId: t.requestId } })
        return send(res, 200, { ok: true })
      }
    }
    send(res, 404, { error: '찾을 수 없어요' })
  }

  return {
    routeApi, calls, emit,
    close() { for (const t of timers) clearInterval(t); for (const c of clients) c.end(); clients.clear() },
    dropStreams() { for (const c of clients) c.end(); clients.clear() },
  }
}

function sha(seed: string): string {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return ((h >>> 0).toString(16).padStart(8, '0') + 'a9c3e1f07b2d4c6e8f1a3b5c7d9e0f21').slice(0, 40)
}
