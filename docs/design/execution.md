# 실행 단계 설계 (계약) v2

상태: 구현 기준 문서. v1(d9e5089)에 대한 두 독립 검토(Codex·Claude, 둘 다 NO SIGN)의 지적을 판정해 반영했다. 판정 기록은 §20.
병렬 작업자는 이 문서의 계약(데이터 형태·상태·API·경로)을 바꾸지 않는다. 바꿔야 하면 멈추고 보고한다.

## 0. 목표와 역할
승인된 계획을 사람 개입 없이 끝까지 실행한다. 사람은 **질문 답변, 계획 승인, 결과 수락, 병합 승인, 회로 차단·수정안 판단**에서만 개입한다.
- **판단은 CEO, 구현은 작업자** (decisions/0001). CEO는 코드를 조사해 "어디를·무엇을·어떤 규칙으로·무엇으로 확인하는지"를 지시서에 확정하고 코드 본문은 쓰지 않는다. 작업자는 지시서대로 구현만 하고, 지시서가 현실과 다르면 설계하지 않고 `blocked`로 멈춘다.
- **작업자·검토자·검사 명령은 신뢰하지 않는다.** 권한 규칙은 가드레일이고, 경계는 OS 샌드박스(§6)와 hq의 직접 재검증(§8·§9)이다.

## 1. 경로
| 경로 | 내용 | 작업자 접근 |
| --- | --- | --- |
| `$HQ_HOME` (기본 `~/.hq`) | hq 실행 데이터 | 기본 거부 |
| `$HQ_HOME/hq.db` | SQLite(WAL) | 거부 |
| `$HQ_HOME/worktrees/<requestId>/<key>` | 작업 worktree | 자기 것만 읽기·쓰기 |
| `$HQ_HOME/worktrees/<requestId>/<key>.r<n>` | 검토 worktree (detached, 매번 새로) | 자기 것만 |
| `$HQ_HOME/worktrees/<requestId>/_integration-<project>` | 통합 worktree (§12) | 작업자 없음 |
| `$HQ_HOME/runs/<requestId>/<key>/<attemptId>/hq/` | hq 소유 증거: prompt.md, spec.json, stream.jsonl, stderr.log, process.json, tail.json, activity.jsonl, checks.json, verdict.json, result.json | 거부 |
| `$HQ_HOME/runs/<requestId>/<key>/<attemptId>/out/` | 작업자 제출: `report.md`, `done.json` 만 | 이 폴더만 쓰기 |
| `~/.config/hq/token` | 데몬 API 토큰 (0600) | 거부 |
| `<hq repo>/config/hq.json`, `config/projects.json` | 설정 | — |

- **ID 형식 (URL 안전)**: 요청 `req-xxxxxxxx`, 작업 `<requestId>.<key>`(key는 `[A-Za-z0-9_-]{1,32}`), 시도 `<taskId>~a<n>`(작업) / `<taskId>~r<n>`(검토). 클라이언트는 그래도 경로 세그먼트를 percent-encode하고, 서버는 한 번만 decode한다.
- `out/` 파일은 hq가 `lstat`로 일반 파일인지 확인하고 `O_NOFOLLOW` + 크기 상한(report 1MB, done 64KB)으로만 읽는다. symlink·디렉터리·과대 파일은 없는 것으로 취급한다.
- **로그는 append-only**(stream.jsonl, stderr.log, activity.jsonl; 마지막 불완전 줄은 다음 읽기에서 복구). **스냅샷 파일은 원자적 교체**(tmp→rename). 판정의 원본은 DB이며 파일은 사본이다.

## 2. 설정 `config/hq.json` (모든 키 선택)
```json
{
  "maxWorkers": 2,
  "attemptWallMinutes": { "L0": 20, "L1": 45, "L2": 90, "L3": 120 },
  "maxTurns": 200,
  "checkTimeoutMinutes": 15,
  "models": { "haiku": "haiku", "sonnet": "sonnet", "opus": "opus" },
  "ladder": ["haiku", "sonnet", "opus"],
  "maxAttempts": 3,
  "quota": { "saveAt": 0.85, "holdAt": 0.95 },
  "protectedPaths": ["**/*.test.*", "**/*.spec.*", "test/**", "tests/**", "**/__tests__/**", "package.json", "*.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".github/**", "tsconfig*.json", "**/*.config.*"],
  "sandbox": { "extraWritable": ["~/.npm", "~/.cache", "~/Library/Caches"] },
  "notify": true
}
```
`projects.json` 항목에 선택 필드 `setup`(문자열, 예: `"npm ci --prefer-offline"`) 추가: worktree 생성 직후 샌드박스 안에서 실행.
`quota.reviewOnlyAt`은 v2에서 제거(검토 A14: 실익 작음). `workerDisallowedTools`는 가드레일로 유지(§6).

## 3. 계획 형태 (CEO 스키마 v2)
- 역할은 `collect | implement` 둘. **verify 역할 폐지**: 구현 작업마다 선택 필드 `review: { brief, model }`(model `sonnet|opus|none`). 없으면 등급 표 기본값(L0 none, L1 sonnet, L2·L3 opus). `none`은 LLM 검토 없이 기계 검증만.
- `external: true` 작업과 `model: none` 작업은 이번 단계에서 **거부**(validate 오류). 외부 게시·삭제·결제는 지원하지 않는다고 CEO 규칙에 명시.
- `validate()` 추가 검사: 자기 의존·순환(위상 정렬), 존재하지 않는 의존, owns 정규화(선행 `./` 제거, 뒤 `/` 제거) 후 **겹침 검사**(한쪽이 다른 쪽의 접두 경로이거나, glob과 경로가 `matchesGlob` 양방향 중 하나라도 맞거나, 두 glob의 고정 접두부가 겹치면 겹침으로 본다) — 병렬 구현 작업이 겹치면 오류, 같은 프로젝트 의존으로 순서가 있으면 허용.
- 계획 승인 카드 본문: 작업별 `[key] 제목 · 역할·등급·모델 · 검토 모델`, 소유 경로, **수용 기준의 check 명령 원문**, 프로젝트 setup 명령. 사람이 본 명령만 실행된다.

## 4. 데이터 모델
```sql
tasks(id pk, request_id, key, project, title, role, grade, model, review_model,
      spec text,            -- PlanTask JSON (revision마다 교체)
      revision int default 0, status, attempts int default 0, limited_streak int default 0,
      branch, worktree, base_sha, head_sha, checks_state, resume_session, note, updated_at)
attempts(id pk, task_id, kind work|review, n, model, status, session_id not null,
      pid, lstart, attempt_token, dir, started_at, ended_at, cost_usd, input_tokens, output_tokens, outcome, reason,
      unique(task_id, kind, n))
quota(window pk, utilization, resets_at, status, observed_at)      -- window: five_hour | seven_day | …
merges(request_id, project, target, target_sha, integration_sha, state, result_sha, note, updated_at, pk(request_id, project))
task_questions(id pk, task_id, attempt_id, revision, question, options, default_option, answer, created_at)
approvals: 기존 + kind, subject_id, revision 컬럼, 상태 superseded 추가
schema_version: pragma user_version
```
- 모든 상태 전이는 한 트랜잭션. 외부 부작용(spawn, git 쓰기, kill) 전에 의도를 먼저 기록.
- DB 이전(`.data/hq.db` → `$HQ_HOME/hq.db`): 원본을 열어 `VACUUM INTO '<tmp>'` → `pragma integrity_check` → rename. 표식 `kv: migrated_from`. 원본은 지우지 않는다.

## 5. 상태 (전이표는 exec-engine-spec.md §C가 권위)
**Request**: `queued → thinking → asking → planned → executing → awaiting_acceptance → accepted → merging → merged`; 분기 `rejected | failed | blocked | cancelled | expired`.
**Task**: `pending → running → verifying → reviewing → passed`; 분기 `rework · revising · question · held · blocked · cancelled`.
**Attempt**: `starting → running →` 판정 `succeeded | failed | brief_blocked | question | limited | runaway | unverifiable | start_failed | transient`.
**불변식**: 종결되지 않은 요청·작업은 항상 (a) 살아 있는 프로세스 (b) 열린 카드·미답 질문 (c) 시각 타이머(한도 해제 등) (d) 배정 대기(스케줄러가 다음 틱에 시작 가능) 중 하나를 가진다. 1분마다 조정기(reconciler)가 검사해 위반을 `blocked` + 카드로 드러낸다.

## 6. 작업자 실행 경계 (샌드박스)
작업자·검토자·collect·setup·check 명령은 모두 macOS Seatbelt(`sandbox-exec -f <profile>`)로 감싼다. 프로필(실측 검증됨: 토큰 읽기·hq 포트 접속·허용 밖 쓰기 거부, claude 정상 동작):
- 읽기·쓰기 거부: `~/.config/hq`, `$HQ_HOME` 전체 — 단 자기 worktree·자기 `out/`은 허용(뒤 규칙 우선).
- 쓰기 허용 목록 외 전부 거부: 자기 worktree, 자기 `out/`, 프로젝트 repo의 `.git`(worktree 커밋에 필요), `~/.claude`, `~/.claude.json*`, `/private/tmp`, `/private/var/folders`, `/dev`, `sandbox.extraWritable`.
- 네트워크: `localhost:<hq port>`·`127.0.0.1:<hq port>` 거부.
- 환경변수 허용 목록만 전달: `PATH HOME USER LANG LC_ALL TERM TMPDIR SHELL`, `HQ_ATTEMPT_OUT`, git 보조(`GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_COUNT/KEY/VALUE`로 `remote.pushDefault`·`push.default=nothing`). `HQ_TOKEN`·API 키·`SSH_AUTH_SOCK` 제거.
- **알려진 한계(문서화)**: 공유 `.git`에 쓸 수 있으므로 작업자가 다른 브랜치 ref를 바꿀 수 있다 → hq는 브랜치 이름이 아니라 **기록한 SHA**로만 검증·통합·병합한다(§12).
- 권한 플래그(가드레일): 모든 역할에 `--tools <목록>`(사용 가능 도구 자체 제한) + `--setting-sources "" --strict-mcp-config --disable-slash-commands`.
  - implement: `--tools Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch --permission-mode acceptEdits --add-dir <out>`
  - collect: `--tools Read,Glob,Grep,WebFetch,WebSearch,Write --permission-mode dontAsk --allowedTools Read,Glob,Grep,WebFetch,WebSearch,Write(//<out 절대경로>/**)` (cwd = base의 detached worktree)
  - review: `--tools Bash,Read,Glob,Grep --permission-mode dontAsk --allowedTools Bash,Read,Glob,Grep --json-schema <VERDICT>`
- 실행: `--output-format stream-json --verbose --model <m> --session-id <uuid>|--resume <uuid> --max-turns <n>`. stdin = prompt 파일, stdout/stderr = `hq/` 로그 파일, `detached: true`(자기 프로세스 그룹).

## 7. 시작·종료 프로토콜 (중복 실행 방지)
1. 트랜잭션: attempt 행 `starting` + `session_id` + `attempt_token` + 폴더 기록 → task `running`.
2. spawn → 즉시 `pid`와 `ps -o lstart=`(LC_ALL=C)를 attempt 행과 `hq/process.json`에 기록.
3. 복구 시 `starting` 행: pid 없으면 `pgrep -f -- "--session-id <uuid>"`(또는 `--resume <uuid>`)로 고아를 찾는다 → 찾으면 채택(pid 기록), 없으면 `start_failed`. pid가 있으면 `lstart` 일치로 동일 프로세스 확인.
4. 시도가 끝나면(판정 직후, 정상 포함) 프로세스 그룹 전체 SIGTERM → 10초 후 SIGKILL(작업자가 띄운 백그라운드 프로세스 정리).
5. 저장소 단위 뮤텍스: 같은 repo에 대한 git 쓰기(worktree add/remove, branch, merge, 통합)는 직렬.
6. 다음 시도 전 worktree가 더러우면 `git diff`와 미추적 목록을 `hq/dirty.patch`로 저장 후 `reset --hard HEAD` + `clean -fd`, 프롬프트에 알림.

## 8. 완료 판정 (작업 시도)
프로세스 종료 확인 후:
1. **한도**: 구조화 신호만 — `rate_limit_info.status == "rejected"` 또는 result `is_error` && `api_error_status == 429`. result 줄이 없을 때만 stderr 정규식. → `limited`(시도 수 안 셈, task `held`, 같은 세션 `--resume`으로 이어감). 작업당 연속 3회 → `blocked`.
2. **일시 오류**: result `is_error` && `api_error_status` 5xx·과부하 → `transient`(시도 수 안 셈, 1회 자동 재시작, 2회 연속이면 `failed`).
3. 폭주로 죽였으면 → `runaway`. result `subtype == error_max_turns` → `failed`("턴 상한").
4. 정상 종료인데 `out/done.json` 없음·파싱 실패·토큰 불일치 → `unverifiable` → task `blocked`(자동 재시도 없음).
5. outcome `question` → `question` (라운드 최대 3, 초과 → `blocked`).
6. outcome `blocked` → `brief_blocked` → task `revising` (§10a).
7. outcome `failed` → `failed`.
8. `succeeded` 검사 (implement): `head_sha` = worktree HEAD = 종료 시점 HEAD; `git diff --name-only --no-renames <task.base_sha> HEAD` = `files_modified`; 모두 owns 안(rename 양쪽 경로 포함); 작업 트리 깨끗함; `out/report.md` `## 요약` 200자 이상; base..HEAD 모든 커밋이 base의 자손(`rev-list`)이고 merge 커밋 없음. 하나라도 실패 → `failed`.
   collect: done/토큰/outcome 공통 검사 + report 요약 + cwd 트리 무변경. 보고서는 hq가 `hq/report.sealed.md`로 복사하고 sha256을 task에 기록(후행 작업에는 봉인본 경로 전달).
9. 보호 경로(`protectedPaths`)에 해당하는 변경은 통과시키되 목록을 기록 → 검토 프롬프트에 "보호 경로 변경: 테스트·설정 약화 여부 반드시 판정"으로, 수락 카드에 표시.

## 9. 기계 검증 (hq가 직접)
- worktree HEAD가 `head_sha`인지 확인 후, 모든 non-manual check를 샌드박스 안 `/bin/sh -c <check>`(stdin /dev/null, 최소 env, 그룹 타임아웃)로 실행. 검사 전후 `git status --porcelain`·HEAD 불변 확인(검사가 소스를 바꾸면 실패).
- **기준선**: 처음 그 base에서 작업을 시작할 때, 같은 check들을 base의 임시 detached worktree에서 한 번 실행해 캐시(`kv: baseline:<repo>:<sha>:<checkId>`). base에서 이미 실패한 check는 `baselineFailed`로 표시하고 합격 판정에서 제외(수락 카드에 "기존 실패" 표시).
- 비밀값 검사: base..HEAD의 **모든 커밋**의 추가 줄 + 파일명 거부 목록(`.env*`, `*.pem`, `id_rsa*`, `*.p12`, `*.key`). 값은 기록하지 않는다.
- 결과 `hq/checks.json`. 실패 → 재작업.

## 10. 교차 검토
- 검토 worktree: `git worktree add --detach <path> <head_sha>` + setup. 모델: `task.review_model`(§3). 독립성은 새 세션·새 worktree에서 오며 같은 Claude 계열임을 표시한다(`sameFamily: true`).
- VERDICT 스키마(정식 JSON Schema, 추가 필드 금지): `pass, blocking[{id,summary,evidence}], advisory[{id,summary}], criteria[{id,result pass|fail|manual,evidence}], tests_run[{command,exit_code,summary}]`.
- hq 검증:
  1. `criteria[].id` 집합 = 작업 acceptance id 집합(누락·중복·모르는 id → 무효).
  2. `tests_run[]`의 각 명령은 검토자 stream의 실제 Bash `tool_use`와 대응 `tool_result`에서 찾아 종료 코드가 일치해야 한다(불일치 → 무효). 코드 변경이 있는데 `tests_run` 비면 무효.
  3. `pass=true`인데 blocking 또는 fail 기준 → 무효. `pass=false`인데 blocking 없음 → 무효.
  4. 무효 → 같은 head에서 재검토 1회, 두 번째 무효 → task `blocked`.
- hq가 verdict에 바인딩 필드를 직접 붙인다(`task, head_sha, base_sha, reviewer_model, implementer_model, sameFamily`).
- blocking → 재작업(사유 = blocking 목록). 검토 worktree는 끝나면 제거.

## 10a. 지시서 수정 턴 (CEO)
작업자 `blocked` → CEO 수정 턴: 입력 원 PlanTask·report.md·diff stat. 출력 `{ revised_task | null, questions }` 정확히 하나.
- 자동 적용 조건: `key·project·role` 동일, `owns`가 원래의 부분집합, acceptance check 명령 집합 동일. 그 밖은 카드 `revise:<taskId>`(수정 전후 diff 표시).
- 적용 시 task `revision+1`, 이 작업에 의존하는 후행 작업 무효화(§11).
- task당 최대 2회, 초과 → `blocked`.

## 11. 재작업·의존·무효화
- 실패(`failed`, `runaway`, 검사 실패, 검토 blocking, 결과 반려) 시 `attempts < maxAttempts`면 재작업: 2번째는 같은 모델, 3번째는 ladder 한 단계 위. 도달 → `blocked`("N번 실패", N = 실제 횟수).
- **작업별 base**: 같은 프로젝트 의존이 없으면 요청 base(승인 시점 프로젝트 HEAD), 하나면 그 `head_sha`, 여럿이면 hq가 worktree에서 의존 head들을 `--no-ff` 병합한 커밋(충돌 → `blocked`). owns·diff·검토는 모두 이 `base_sha` 기준.
- 다른 프로젝트 의존·collect 의존: 봉인된 산출물(보고서 경로·해시, 선행 head SHA)을 프롬프트로 전달.
- **무효화**: `passed` 작업의 `head_sha`가 바뀌면(재작업·수정·반려) 그 작업에 전이적으로 의존하는 모든 작업을 `pending`으로 되돌리고 worktree·브랜치를 폐기(브랜치는 `hq/<req>/<key>-v<n>`로 보관), attempts 0, 이전 검증·검토 무효. 수락 카드가 열려 있으면 superseded.

## 12. 수락·통합·병합
- 모든 작업이 `passed` 또는 `cancelled`(최소 1개 passed) → 프로젝트별 **통합**: 통합 worktree를 대상 브랜치의 현재 SHA에서 만들고 통과 작업의 **기록된 head SHA**를 계획 순서로 `--no-ff` 병합 → setup → 모든 작업의 non-manual check + 비밀값 검사. 결과 `integration_sha`. 충돌·검사 실패 → 요청 `blocked` + 카드 `integration:<req>:<project>`(다시 통합 / 요청 중단).
- 수락 카드 `accept:<req>` (옵션 `수락`·`반려`), subject = 정렬된 `(taskId, head_sha, report sha256, checks 결과 해시)` + 프로젝트별 `integration_sha`. 본문: 작업별 요약·변경 파일 수·검사·검토·보호 경로 변경·기존 실패·취소된 작업. collect만 있는 요청은 수락으로 `merged`와 같은 완료 상태 `accepted`에서 끝난다(병합 없음 → `merged`로 표시하지 않고 `accepted` 종결).
- 반려: 사유 + 선택적 작업 key 목록(없으면 통과 작업 전부) → 해당 작업 재작업, 후행 무효화.
- 수락 → 프로젝트별 병합 카드 `merge:<req>:<project>` (옵션 `병합`·`보류`), subject = `(target, target_sha, integration_sha)`.
- 병합 실행: 저장소 뮤텍스 → 사용자 checkout이 `target` 브랜치·`target_sha`·깨끗함인지 확인 → `git merge --ff-only <integration_sha>` 한 번. 다르면 병합하지 않고 통합부터 다시(새 카드, 본문 첫 줄 사유). 사용자 checkout이 detached HEAD면 카드 대신 사유 표시.
- 모든 프로젝트 병합 → `merged`, 작업 worktree·브랜치 정리(worktree는 `--force` 제거 — 검증된 SHA가 이미 병합됨, 브랜치 `-d`). 대상 프로젝트가 hq 자신이면 "hq 재시작 필요" 알림.
- 카드 만료: plan 7일(만료 → 요청 `expired`), accept·merge·revise·integration·blocked는 만료 없음(해시 고정). 보류된 병합은 `POST /api/requests/:id/merge`로 다시 제시.

## 13. 한도·동시성·폭주
- quota: stream의 `rate_limit_event.rate_limit_info`(`status`, `resetsAt` epoch초, `unifiedWindows.{창}.{utilization,resetsAt}`)를 창별 행으로 저장. `resets_at`이 지난 창은 알 수 없음으로 본다.
- 모드: `hold` = 어떤 창이든 `rejected` 또는 ≥ holdAt → 모든 시작 중지(CEO 턴·팀 포함), 가장 늦은 차단 창의 resetsAt까지. `save` = ≥ saveAt → 동시 1. 관측 없음 → 동시 1(관측을 얻기 위한 별도 호출은 하지 않음).
- CEO 턴도 stream-json으로 실행해 관측을 얻는다. 팀 스케줄러도 hold를 따른다. 기존 `limit.blockedUntil`은 quota 관리자로 통합.
- 동시성: 살아 있는 claude 프로세스(작업·검토·CEO) 합계 ≤ `maxWorkers + 1`(CEO 1자리 예약).
- 폭주: 경과 > `attemptWallMinutes[grade]`(검토·collect·resume도 동일 적용), 또는 같은 도구 오류 3회 연속 → 그룹 SIGTERM→KILL → `runaway`.

## 14. 활동 로그
stream.jsonl → activity.jsonl `{at, kind: message|tool|error|usage, text}`. 표시 전에 비밀 패턴 마스킹 + 제어문자 제거 + 200자 제한. `(attemptId, byte offset)` 체크포인트로 재시작 후 중복 없이 이어감. 로그 보존: 시도당 stream 50MB 상한(초과 시 앞부분 절단 표시), 요청 종결 30일 후 정리.

## 15. API (`127.0.0.1` 전용)
인증: Host가 정확히 `127.0.0.1:<port>`, Origin 없음, Bearer 토큰(펫·CLI). 웹은 §16.
| 메서드·경로 | 설명 |
| --- | --- |
| `GET /api/state` | Snapshot |
| `GET /api/events` | SSE (`id:` 연속 번호) |
| `GET /api/requests/:id` | RequestDetail |
| `GET /api/attempts/:id/activity?after=<n>` | `{lines, next}` (최대 500줄) |
| `GET /api/attempts/:id/files/:name` | `report.md, done.json`(out) · `checks.json, verdict.json, stderr.log`(hq), `text/plain` + nosniff, 1MB |
| `GET /api/requests/:id/diff?task=<key>` | `{files:[{path,added,removed}], diff, truncated}` base..head, 2MB |
| `POST /api/requests` / `POST /api/requests/:id/answer` | 기존 (answer는 questionId가 그 요청 소유일 때만) |
| `POST /api/tasks/:id/answer` | `{questionId, answer, revision}` |
| `POST /api/tasks/:id/decide` | `{decision: retry|skip|stop, revision}` |
| `POST /api/requests/:id/reject` | `{reason, tasks?: string[]}` |
| `POST /api/requests/:id/cancel` | 중단 |
| `POST /api/requests/:id/merge` | 보류된 병합 다시 제시 |
| `POST /api/approvals/:id` | `{decision, subjectHash}` — plan/accept/merge/revise/integration/team |
| `POST /api/approvals` | 팀 전용: id는 `team:<teamId>:`로 시작해야 함, 예약 접두어 거부 |
| `POST /api/ui-code` | 웹 로그인 코드 |
| `GET /api/quota` | 창별 관측 |
잘못된 상태·오래된 revision → 409. 모든 오류 응답 본문은 `{"error": "<한국어 사유>"}`. 크기 초과 413. JSON 본문 64KB 제한.

## 16. 웹 화면 인증
- `POST /api/ui-code`(Bearer) → `http://127.0.0.1:<port>/ui/#code=<32바이트 랜덤, 60초, 1회>`. 코드는 fragment라 서버 로그·Referer에 남지 않는다.
- 페이지 JS가 `POST /ui-api/session {code}`로 교환(원자적 1회 소비) → 세션 토큰(32바이트, 유휴 12시간·최대 7일)을 `sessionStorage`에 두고 `Authorization: Bearer`로 호출. **쿠키 없음**(포트 간 쿠키 공유 문제 제거, CSRF 불필요). 데몬 재시작 시 세션 폐기.
- `/ui-api/*`: 세션 토큰 확인 → `/api/*` 라우터로 위임(Bearer를 데몬 토큰으로 교체). SSE는 `EventSource`가 헤더를 못 보내므로 `?t=<세션 토큰>` 쿼리 허용(해당 경로만).
- 모든 `/ui*` 응답: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. 작업자 산출물은 textContent로만 렌더링(마크다운은 원시 HTML 불허 렌더러, 링크는 http(s)만 + `rel=noopener noreferrer`).

## 17. 화면용 데이터 (src/types.ts가 권위)
Snapshot: `workers`, `headline`, `quota`, `decisions: DecisionItem[]`, `RequestView.tasks`. `needsYou = decisions.length`.
`DecisionItem.options`는 **서버에 그대로 보낼 값**이다: 승인형 카드는 카드 옵션 문자열(`승인`·`반려`, `수락`·`반려`, `병합`·`보류`, `다시 통합`·`요청 중단`), 질문은 선택지 문자열, blocked는 `retry`·`skip`·`stop`. blocked 표시 이름은 클라이언트가 고정 매핑한다: retry → `한 번 더 (최상위 모델)`, skip → `이 작업 건너뛰기`, stop → `요청 중단`.
DecisionItem 순서: plan → ceo_question → worker_question → revise → blocked → integration → accept → merge (각 종류 안에서는 오래된 순). 알림은 `decision id + revision`으로 중복 방지.

## 18. 상황 문장 (headline)
우선순위: 결정 → 장애(blocked·unverifiable·통합 실패) → 실행 중 → 한도 보류·대기 → 유휴.
- `회장님 결정 N건: <첫 항목>`
- `<작업>이 막혔어요: <사유 한 줄>`
- `<모델>가 <작업> <구현|검토|검증> 중 · 다음: <단계>` (+ `외 N명`)
- `사장이 계획 중이에요` / `빈 자리 기다리는 중 (N건)`
- `사용 한도 <창> <n>% — <HH:mm>까지 쉬어요` / `한도 관측 전이라 하나씩 실행 중`
- `병합 완료: <요청>` (완료 후 10분간)
- `지금 하실 일은 없어요` / 데몬 끊김은 펫이 `hq 꺼짐`

## 19. 펫 표시 규칙
- 캐릭터는 Dock 위 한 줄로 늘어선다(CEO가 맨 왼쪽). 드래그로 옮기면 위치를 기억한다.
- 모든 캐릭터 아래에 이름표: CEO `사장 · 구독 기본 모델`, 작업자 `<프로젝트> · <작업 제목 요약> · <모델>`(검토자는 `검토 · …`, 검사는 `기계 검증 · hq`). 위에는 말풍선.
- CEO(피카츄) 항상, 말풍선 = headline(결정 있으면 `확인해 주세요 (N)`), 배지 = needsYou, 결정 있을 때만 튐.
- `workers`마다 캐릭터(모델별). `held`는 잠자는 표시 + `한도 보류 · HH:mm까지`. `blocked` 작업도 캐릭터로 남기고 말풍선 `멈춤 · 사장에게 보고`(결정 카드가 CEO에게 있음).
- 종료된 작업의 결과·실패 사유는 CEO 창의 "최근 결과"에 남는다.
- CEO 창: 결정 카드 전부(§17 순서) + 최근 결과 + 새 요청 + 자세히 보기(웹).

## 20. 검토 판정 기록 (v1 → v2)
Codex(X-B01~B15, A01~A07)와 Claude(C-B1~B13, A1~A15)의 지적에 대한 오케스트레이터 판정.
| 지적 | 판정 | 반영 |
| --- | --- | --- |
| 작업자 Bash가 거부 규칙 우회·토큰 읽기로 자기 승인 (C-B1, X-B05) | 채택 | §6 Seatbelt 샌드박스(실측 검증), env 허용 목록, 팀 승인 namespace §15 |
| hq 판정 파일이 작업자 쓰기 폴더에 (C-B2, X-B06) | 채택 | §1 `hq/`·`out/` 분리, lstat·O_NOFOLLOW |
| collect 쓰기 제한 무효 (C-B3) | 채택 | §6 dontAsk + `--tools` + `//` 절대경로 규칙 |
| 기계 검증 무력화·check 명령 미표시 (C-B4, X-B08) | 채택 | §3 카드에 check 원문, §8.9 보호 경로 표시, §9 검사 전후 불변 |
| 새 worktree 의존성 없음·기존 실패 (C-B5) | 채택 | §2 setup, §9 기준선 |
| 작업별 base·다중 의존·무효화 (C-B6, X-B04) | 채택 | §11 |
| 수락과 병합 대상 불일치·부분 병합 (C-B7, X-B09) | 채택 | §12 통합 worktree + `--ff-only <integration_sha>` |
| 끝나지 않는 상태 (C-B8, X-B02) | 채택 | §5 불변식 + 조정기, 전이표(spec §C) |
| 재시작 중복 실행 (C-B9, X-B01) | 채택 | §7 시작 프로토콜 + pgrep 세션 id |
| 한도 정규식 오판 (C-B10, X-B12) | 채택 | §8.1 구조화 신호, 연속 상한 |
| model none·external (C-B11, X-B03, X-B11) | 채택(범위 축소) | §3 거부 |
| XSS → 승인 위조 (C-B12, X-B15) | 채택 | §16 CSP·textContent·쿠키 폐지 |
| tests_run 자기 보고 (C-B13, X-B07) | 채택 | §10 stream 대조, criteria 집합 일치 |
| WAL 단순 복사 (X-B13) | 채택 | §4 VACUUM INTO |
| id 인코딩·질문 소유 (X-B14, C-A9) | 채택 | §1 URL 안전 id, §15 소유 검증 |
| verify 역할 폐지 (C-A14) | 채택 | §3 review 필드 |
| 검토 모델 하향 규칙이 등급 표와 충돌 (C-A2) | 채택 | §3·§10 review_model |
| unverifiable 범위 축소 (C-A1) | 채택 | §8.2·8.3 |
| 시도 사이 더러운 worktree (C-A4) | 채택 | §7.6 |
| 반려 범위 (C-A5, X-A03) | 채택 | §12 작업 지정 반려 |
| git 동시성 (C-A6) | 채택 | §7.5 뮤텍스 |
| 비밀값·로그 마스킹 (C-A8, X-A02) | 채택 | §9, §14 |
| 웹 쿠키 포트 공유 (C-A10) | 채택 | §16 |
| 상황 문장 누락 (C-A12, X-A01) | 채택 | §17·§18 |
| hq 자신 병합 (C-A13) | 채택 | §12 재시작 알림 |
| quota 3단계 과설계 (C-A14) | 채택 | §2·§13 2단계 |
| 전체 OS 수준 격리(사용자 분리·VM) (X-B05 일부) | 보류 | 1인 로컬 도구 위협 모델에서 Seatbelt로 충분하다고 판단, 한계는 §6에 명시 |
| 결과 manifest 서명 (X-B06 일부) | 보류 | 작업자가 hq/ 폴더·DB에 접근 불가(§6)하므로 해시 기록으로 대체 |
| 조사 후 계획 revision 경로 (X-A06) | 부분 채택 | §10a 작업 단위 수정 턴. 계획 전체 재작성은 다음 단계 |
| 스키마 생성 프레임워크 (X-A05) | 기각 | types.ts + 런타임 검증 + fixture로 충분 |
