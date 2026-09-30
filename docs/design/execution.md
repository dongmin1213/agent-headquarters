# 실행 단계 설계 (계약)

상태: 구현 기준 문서. 병렬 작업자는 이 문서의 계약(데이터 형태·상태·API·경로)을 바꾸지 않는다. 바꿔야 하면 BLOCKED로 돌려준다.

## 0. 목표
승인된 계획을 사람 개입 없이 끝까지 실행한다: 작업자 실행 → 완료 계약 확인 → hq가 수용 기준 직접 재실행 → 새 worktree 교차 검토 → 실패 시 재작업 사다리 → 결과 수락 → 병합 승인 → 로컬 병합.
사람은 **질문 답변, 계획 승인, 결과 수락, 병합 승인, 회로 차단 판단**에서만 개입한다.

## 1. 경로
| 경로 | 내용 |
| --- | --- |
| `$HQ_HOME` (기본 `~/.hq`) | hq의 모든 실행 데이터. 코드 저장소와 분리 |
| `$HQ_HOME/hq.db` | SQLite (WAL) |
| `$HQ_HOME/worktrees/<requestId>/<taskId>` | 작업 worktree (재작업 시 재사용) |
| `$HQ_HOME/worktrees/<requestId>/<taskId>.review-a<n>` | 검토용 detached worktree (매번 새로) |
| `$HQ_HOME/runs/<requestId>/<taskId>/a<n>/` | 시도별 증거 폴더 (아래) |
| `~/.config/hq/token` | 데몬 API 토큰 (0600) |
| `<hq repo>/config/hq.json` | 설정 (없으면 기본값). `config/projects.json` 프로젝트 목록 |

토큰은 기존대로 `~/.config/hq/token`. DB는 `.data/hq.db`에서 `$HQ_HOME/hq.db`로 옮긴다(최초 1회 복사 마이그레이션: `.data/hq.db`가 있고 새 파일이 없으면 복사).

증거 폴더 파일:
| 파일 | 쓰는 쪽 | 내용 |
| --- | --- | --- |
| `prompt.md` | hq | 작업자에게 준 전체 프롬프트 |
| `spec.json` | hq | 실행 argv(비밀 없음), 모델, base/branch, 시작 시각, attempt_token |
| `stream.jsonl` | claude stdout | stream-json 원문 |
| `stderr.log` | claude stderr | |
| `process.json` | hq | `{pid, startedAt, sessionId}` — spawn 직후 원자적 기록 |
| `done.json` | 작업자 | 완료 계약 (아래) |
| `report.md` | 작업자 | 보고서 (`## 요약` 절 필수) |
| `activity.jsonl` | hq | 사람이 읽는 활동 로그 (아래) |
| `checks.json` | hq | 기계 검증 결과 |
| `verdict.json` | hq | 검토 결과(검토 시도에서만) |
| `result.json` | hq | 시도 최종 판정 |

파일 쓰기는 모두 같은 폴더의 임시 파일 → rename (원자적).

## 2. 설정 `config/hq.json` (모든 키 선택, 기본값)
```json
{
  "maxWorkers": 2,
  "attemptWallMinutes": { "L0": 20, "L1": 45, "L2": 90, "L3": 120 },
  "maxTurns": 200,
  "checkTimeoutMinutes": 15,
  "models": { "haiku": "haiku", "sonnet": "sonnet", "opus": "opus" },
  "ladder": ["haiku", "sonnet", "opus"],
  "maxAttempts": 3,
  "quota": { "saveAt": 0.85, "reviewOnlyAt": 0.90, "holdAt": 0.95 },
  "workerDisallowedTools": ["Bash(git push:*)", "Bash(git remote:*)", "Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)"],
  "notify": true
}
```
`src/config.ts`가 로드·검증·기본값 병합을 담당한다(이미 작성됨).

## 3. 데이터 모델 (store 확장)
```sql
create table tasks (
  id text primary key,            -- "<requestId>/<taskKey>"
  request_id text not null, task_key text not null, project text not null,
  title text not null, role text not null, grade text not null, model text not null,
  spec text not null,             -- PlanTask JSON (brief, owns, acceptance, depends_on, external)
  review_brief text,              -- verify 역할 작업이 가리키는 검토 지시 (없으면 기본 검토)
  status text not null,           -- TaskStatus
  attempts integer not null default 0,
  branch text, worktree text, base_sha text, head_sha text,
  note text, updated_at text not null);
create table attempts (
  id text primary key,            -- "<taskId>#a<n>" 또는 "<taskId>#r<n>"(검토)
  task_id text not null, kind text not null,   -- work | review
  n integer not null, model text not null, status text not null,  -- AttemptStatus
  session_id text, pid integer, attempt_token text not null, dir text not null,
  started_at text, ended_at text, cost_usd real, input_tokens integer, output_tokens integer,
  outcome text, reason text);
create table quota (id integer primary key check (id = 1), five_hour real, seven_day real,
  five_hour_resets_at text, seven_day_resets_at text, status text, observed_at text);
```
요청 테이블의 status에 실행 단계 값이 추가된다(§4).

## 4. 상태
**Request.status**: `queued → thinking → asking → planned → approved → executing → awaiting_acceptance → accepted → merging → merged`, 분기 `rejected | failed | blocked`(회로 차단 등 사람 판단 필요) `| cancelled`.

**TaskStatus**: `pending`(의존 대기·배정 대기) → `running` → `verifying` → `reviewing` → `passed`. 분기: `rework`(다음 시도 대기) · `revising`(CEO 지시서 수정 중, §9a) · `question`(작업자 질문 대기) · `held`(한도 보류) · `blocked`(3회 실패 또는 확인 불가 → 사람 판단) · `cancelled`.
`collect` 역할: `running → verifying(보고서 존재·요약 확인만) → passed`. 검토 없음.
`verify` 역할 작업은 독립 실행하지 않는다: 의존 대상 구현 작업의 `review_brief`로 합쳐진다.

**AttemptStatus**: `starting → running → ended` 후 판정 `succeeded | failed | brief_blocked | question | limited | runaway | unverifiable | start_failed`.

## 5. 작업자 실행 계약
- worktree: 프로젝트가 git repo가 아니면 계획 승인 시 요청을 `failed`(사유 명시). base = 승인 시점 프로젝트 `HEAD` 커밋(요청 단위 고정). 같은 프로젝트에서 의존하는 작업은 선행 작업의 `head_sha`에서 분기. 브랜치 `hq/<requestId>/<taskKey>`.
- 실행: `claude -p --output-format stream-json --verbose --model <models[x]> --session-id <uuid> --permission-mode acceptEdits --allowedTools Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch --disallowedTools <workerDisallowedTools> --setting-sources "" --strict-mcp-config --disable-slash-commands --add-dir <증거폴더> --max-turns <maxTurns>`, cwd = worktree, stdin = `prompt.md` 파일, stdout/stderr = 증거 폴더 파일. `detached: true`로 띄워 데몬 재시작에도 살아남는다. 환경변수에서 `CLAUDECODE` 제거, `HQ_ATTEMPT_DIR` 설정.
  - `collect`: `--allowedTools Read,Glob,Grep,WebFetch,WebSearch,Write(<증거폴더>/**)`, 커밋 없음.
- 프롬프트(`src/exec/prompt.ts`): 지시서 + owns + 수용 기준 + 아래 규칙. 재작업이면 이전 실패 증거(checks.json 실패 항목·검토 blocking·반려 사유) 요약을 붙인다.
  0. **지시서대로만 구현한다. 설계를 새로 하지 않는다.** 지시서가 코드 현실과 다르거나 모호하면 추측하지 말고 `outcome: "blocked"`로 멈추고, 어느 지시가 무엇과 어떻게 다른지 증거(파일:줄, 명령 출력)를 report.md에 적는다. (판단은 CEO가, 실행은 작업자가 — decisions/0001)
  1. owns 밖 파일을 바꾸지 않는다. 필요하면 멈추고 `outcome: "blocked"`로 이유를 적는다.
  2. 작업을 코드 커밋으로 남긴다(여러 개 가능). 마지막에 작업 트리가 깨끗해야 한다. push 금지.
  3. `report.md`를 증거 폴더에 쓴다: 첫 절은 `## 요약`(200자 이상: 무엇을·왜·검증 결과), 그 뒤 수용 기준별 확인 결과(실행한 명령과 종료 코드).
  4. 마지막에 `done.json`을 증거 폴더에 **임시 파일로 쓴 뒤 rename**한다. 이후 아무것도 바꾸지 않는다.
  5. 사람에게 물어야만 진행 가능하면 `outcome: "question"`과 `questions`를 넣고 끝낸다.
- `done.json`:
```json
{ "attempt_token": "<그대로 복사>", "outcome": "succeeded|failed|blocked|question",
  "head_sha": "<git rev-parse HEAD>", "files_modified": ["..."], "summary": "한 줄",
  "questions": [{ "question": "...", "options": ["..."], "default": "..." }] }
```

## 6. 완료 판정 (`src/exec/contract.ts`, 순수 함수 + git 호출)
프로세스 종료 후(또는 재시작 복구 시 종료가 확인된 뒤) 순서대로:
1. 한도: stream의 result/stderr가 한도 패턴이거나 `rate_limit_event.status`가 `rejected` → `limited` (시도 수에 안 셈, 작업 `held`).
2. 폭주로 죽였으면 → `runaway` (실패로 셈).
3. `done.json` 없음·파싱 실패·토큰 불일치 → `unverifiable` (자동 재실행 안 함 → 작업 `blocked`, 사람 판단). 종료 코드 0이어도 같다.
4. outcome `question` → `question`.
5. outcome `blocked` → `brief_blocked`: 지시서 문제이므로 같은 지시서로 재시도하지 않는다(시도 수에 안 셈). task `revising` → CEO 지시서 수정 턴(§9a).
6. outcome `failed` → `failed` (reason에 요약).
6. `succeeded`면 검사: `head_sha` = worktree HEAD, base..HEAD 변경 파일 집합 = `files_modified`, 모두 owns glob 안, `git status --porcelain` 비어 있음, report.md 존재·`## 요약` 200자 이상, done.json 이후 HEAD 불변. 하나라도 실패 → `failed`(사유 목록).

## 7. 기계 검증 (hq가 직접)
`succeeded` 판정 뒤 task `verifying`. 각 acceptance의 `check`가 `manual`이 아니면 worktree에서 `/bin/sh -c <check>` 실행(타임아웃 `checkTimeoutMinutes`, 출력 앞뒤 200줄 보관). 추가 공통 검사: 변경 diff에 비밀값 패턴(`-----BEGIN .*PRIVATE KEY`, `sk-ant-`, `ghp_`, `AKIA[0-9A-Z]{16}`, `xox[bp]-`) 없음. 결과 `checks.json`: `{checks:[{id, command, exitCode, durationMs, pass, outputTail}], secrets:[...], pass}`. 명령은 계획 승인 카드 본문에 그대로 보였으므로 승인된 명령으로 본다. 실패 → 재작업.

## 8. 교차 검토
기계 검증 통과 → task `reviewing`. `git worktree add --detach <검토 worktree> <head_sha>`. 모델: 구현 모델과 다르게(가능하면 한 단계 위, 최상위면 한 단계 아래) — 같은 Claude 계열이므로 verdict에 `sameFamily: true` 기록. 실행: `claude -p --output-format stream-json --verbose --model <m> --json-schema <VERDICT_SCHEMA> --permission-mode acceptEdits --allowedTools Bash,Read,Glob,Grep --disallowedTools Edit,Write,NotebookEdit,<workerDisallowedTools> --setting-sources "" --strict-mcp-config --disable-slash-commands`. 프롬프트: 원 지시서, 수용 기준, 변경 요약(diff stat), hq의 checks.json 요약, review_brief. **관련 테스트를 직접 실행하고 명령·종료 코드·결과를 `tests_run`에 적을 것**을 요구.
```json
VERDICT_SCHEMA = { pass: boolean, blocking: [{id, summary, evidence}], advisory: [{id, summary}],
  criteria: [{id, result: "pass|fail|manual", evidence}], tests_run: [{command, exit_code, summary}] }
```
hq 검사: `pass=true`인데 blocking 있음·fail 기준 있음·tests_run 비어 있음(코드 변경이 있을 때) → 검토 무효로 보고 재검토 1회, 또 무효면 `blocked`. hq가 verdict.json에 `{task, head_sha, base_sha, reviewer_model, implementer_model, sameFamily}`를 직접 붙인다(검토자에게 옮겨 쓰게 하지 않는다). blocking → 재작업(사유 = blocking 목록). 검토 worktree는 끝나면 제거.

## 9. 재작업 사다리·회로 차단
작업 실패(`failed`, `runaway`, 기계 검증 실패, 검토 blocking, 결과 반려) 시 `attempts < maxAttempts`면 다음 시도: 2번째는 같은 모델, 3번째는 `ladder`에서 한 단계 위(최상위면 그대로). 같은 worktree에서 이어서(이전 커밋 유지). `maxAttempts` 도달 → task `blocked`, request `blocked`, 사람 카드 "작업 X가 3번 실패했어요" [한 번 더(최상위 모델)] [이 작업 취소하고 계속] [요청 중단].

## 9a. 지시서 수정 턴 (CEO)
작업자가 `blocked`로 멈추면 CEO가 판단한다(작업자는 설계하지 않는다). 입력: 원 PlanTask, 작업자 report.md, 현재 worktree diff stat. 출력(JSON 스키마): `{ revised_task: PlanTask | null, questions: CeoQuestion[] }` 정확히 하나.
- `revised_task`의 `id·project·role`은 원래와 같아야 한다. `owns`가 원래의 부분집합이고 `acceptance`의 `check` 명령 집합이 같으면 자동 적용(시도 수 초기화 없음) → task `rework`. 아니면 승인 카드 `revise:<taskId>`(옵션 `승인`,`반려`, subjectHash=수정 task JSON 해시) → 승인 시 적용, 반려 시 task `blocked`.
- `questions` → 회장에게(요청의 CEO 질문과 같은 카드), 답 오면 수정 턴 재실행.
- task당 수정 턴 최대 2회. 초과 → task `blocked`(회로 차단 카드).

## 10. 동시성·스케줄
- 전역 동시 시도(작업+검토) ≤ `maxWorkers`. 요청은 접수 순서, 작업은 의존이 모두 `passed`인 것 중 계획 순서.
- 한도: 매 stream의 `rate_limit_event.rate_limit_info.unifiedWindows`를 quota 테이블에 기록. `max(five_hour, seven_day) ≥ holdAt` 또는 status `rejected` → 새 시작 금지, 해당 창의 `resetsAt`까지 보류(CEO 턴 포함). `≥ reviewOnlyAt` → 새 작업 시작 금지, 검토·CEO만. `≥ saveAt` → 동시 1. 관측이 없으면 0으로 보지 않는다: 첫 시작은 허용하고 관측을 기다린다.
- 폭주 감시: 시도 경과 > `attemptWallMinutes[grade]` 또는 같은 도구 오류 문자열 3회 연속 → 프로세스 그룹 SIGTERM, 10초 뒤 SIGKILL → `runaway`.

## 11. 결과 수락·병합
- 모든 task `passed` → request `awaiting_acceptance`, 승인 카드 `accept:<requestId>` (옵션 `수락`, `반려`), subjectHash = 각 task head_sha 목록 해시. 본문: 작업별 요약·변경 파일 수·검사 결과·검토 결과. 반려는 사유 입력(`POST /api/requests/:id/reject {reason}`)을 받아 해당 요청의 모든 task를 재작업(사유 첨부).
- 수락 → request `accepted` → 프로젝트별 병합 카드 `merge:<requestId>:<project>` (옵션 `병합`, `보류`), subjectHash = (대상 브랜치명 + 대상 브랜치 현재 SHA + 병합할 head_sha들)의 해시. 대상 브랜치 = 프로젝트 checkout의 현재 브랜치.
- 병합 실행(`src/exec/merge.ts`): 결정 순간 다시 확인 — 프로젝트 checkout이 같은 브랜치·같은 SHA·`git status --porcelain` 비어 있음. 아니면 병합하지 않고 카드를 새 해시로 다시 만든다(사유 표시). 통과하면 의존 순서대로 `git merge --no-ff -m "hq: <title> (<requestId>/<taskKey>)" <branch>`. 충돌 → `git merge --abort`, request `blocked`(충돌 파일 표시). 성공 → `merged`, 해당 worktree·브랜치 정리(`git worktree remove`, 브랜치는 병합됐으므로 `git branch -d`). push 없음.

## 12. 재시작 복구
데몬 시작 시 `attempts.status in (starting, running)`:
- `process.json` 없음 → `start_failed` (시도 수에 안 셈, 작업 `pending`으로 되돌림).
- pid 살아 있고 시작 시각이 일치(`ps -o lstart= -p <pid>`) → `running` 유지, stream.jsonl 꼬리 추적 재개.
- 죽었음 → §6 판정 진행.
모든 상태 전이는 DB 트랜잭션 하나로. 외부 부작용(spawn, merge) 전에 의도를 먼저 기록.

## 13. 활동 로그
stream.jsonl을 꼬리 추적해 `activity.jsonl`에 `{at, kind, text}`로 변환: `message`(assistant 텍스트 첫 200자), `tool`(도구명 + 대상: Bash 명령 첫 120자, Edit/Write 파일 경로), `error`(tool_result is_error), `usage`(result의 토큰·비용). 마지막 활동 한 줄이 펫 말풍선·웹에 표시된다.

## 14. API (데몬, `127.0.0.1` 전용)
기존 인증(Bearer 토큰 + Origin 거부)은 펫·CLI용. 웹 화면용은 §15.
| 메서드·경로 | 설명 |
| --- | --- |
| `GET /api/state` | Snapshot (§16) |
| `GET /api/events` | SSE |
| `GET /api/requests/:id` | RequestDetail (§16) |
| `GET /api/attempts/:id/activity?after=<n>` | 활동 로그 줄 (n번째 이후) |
| `GET /api/attempts/:id/files/:name` | 증거 파일 원문 (`report.md`, `checks.json`, `verdict.json`, `done.json`, `stderr.log` 만 허용, 1MB 제한) |
| `GET /api/requests/:id/diff?task=<key>` | base..head diff (최대 2MB) |
| `POST /api/requests` | 기존 |
| `POST /api/requests/:id/answer` | 기존 (CEO 질문) |
| `POST /api/tasks/:id/answer` | `{questionIndex, answer}` 작업자 질문 답변 → 같은 세션 `--resume`으로 재개 |
| `POST /api/requests/:id/reject` | `{reason}` 결과 반려 |
| `POST /api/requests/:id/cancel` | 요청 중단 (실행 중 시도 SIGTERM) |
| `POST /api/tasks/:id/decide` | 회로 차단 카드 결정 `{decision: "retry"|"skip"|"stop"}` |
| `POST /api/approvals/:id` | 기존 (plan:/accept:/merge: 접두어별 처리) |
| `GET /api/quota` | 최근 관측 |

## 15. 웹 화면 인증
- `GET /ui/open?code=<일회용 코드>`: 펫이 `POST /api/ui-code`(Bearer)로 60초 유효 일회용 코드를 받아 브라우저로 연다. 성공하면 `hq_session` 쿠키(HttpOnly, SameSite=Strict, Path=/)와 CSRF 토큰을 발급하고 `/ui`로 리다이렉트.
- `/ui*`, `/ui-api/*`는 쿠키 인증. `/ui-api/*` 쓰기 요청은 `X-CSRF-Token` 헤더 + `Origin: http://127.0.0.1:<port>` 필수. `/ui-api/*`는 `/api/*`와 같은 핸들러를 공유한다.
- Host는 `127.0.0.1:<port>`만 허용(DNS 재바인딩 방지).

## 16. 화면용 데이터 (src/types.ts)
`Snapshot`에 추가: `workers: WorkerView[]`, `headline: Headline`, `quota: QuotaView | null`. `RequestView`에 `tasks: TaskView[]` 추가(plan 요약과 별도). 정확한 필드는 `src/types.ts`를 기준으로 한다(이미 작성됨).

### 상황 문장 (headline) 규칙
사람이 할 일이 있으면 그것부터. 없으면 진행 중인 것. 모두 한국어 한 문장.
- 할 일 있음: "회장님 결정 N건: <첫 항목 제목>" (`needsYou = N`)
- 실행 중: "<모델>가 <작업 제목> 구현 중 · 다음: <다음 단계>" / "검증 중" / "검토 중"
- 한도 보류: "사용 한도 <창> <n>% — <시각>까지 쉬어요"
- 한가함: "지금 하실 일은 없어요"

## 17. 펫 표시 규칙
- CEO(피카츄)는 항상. 요청 처리 중이면 CEO 말풍선에 headline.
- `workers`마다 캐릭터 하나(모델별 캐릭터: haiku/sonnet/opus 서로 다르게), 상태별 말풍선 = 마지막 활동. 끝나면 사라진다.
- 결정 필요(`needsYou > 0`) → CEO가 뛰고 배지 숫자, macOS 알림(결정 항목 생길 때 1회).
- 한도 보류 → 캐릭터 잠자는 표시.
- 결과 수락·병합 카드는 CEO 창에서 요약 + [수락][반려(사유)] / [병합][보류] + "자세히 보기"(웹 화면 열기).
