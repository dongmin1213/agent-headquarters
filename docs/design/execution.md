# 실행 단계 설계 (계약) v3

상태: 구현 기준 문서. v1·v2에 대한 독립 검토(Codex·Claude 각 2회, 모두 NO SIGN)와 실사용 시험 결과를 판정해 반영했다. 판정 기록은 §20(v1→v2), §21(v2→v3).
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
| `$HQ_HOME/repos/<project>.git` | hq 미러(bare, §6.1) | 읽기만 |
| `$HQ_HOME/work/<requestId>/<key>` | 작업자 복제본(`clone --shared`) | 자기 것만 읽기·쓰기 |
| `$HQ_HOME/worktrees/<requestId>/<key>.v<n>` / `.r<n>` | 미러에서 만든 검증·검토 worktree(매번 새로) | 파일만 쓰기(미러 index는 불가) |
| `$HQ_HOME/worktrees/<requestId>/_integration-<project>` | 통합 worktree (§12) | 검사 명령만(샌드박스) |
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

## 3. 계획 형태 (CEO 스키마 v3)
- 역할은 `collect | implement` 둘. **verify 역할 없음**: 구현 작업마다 선택 필드 `review: { brief, model }`(model `sonnet|opus|none`). 없으면 등급 표 기본값(L0 none, L1 sonnet, L2·L3 opus). `none`은 LLM 검토 없이 기계 검증만. 보호 경로 변경이 생기면 `none`은 자동으로 `sonnet`으로 올린다.
- `external: true`, `model: none`인 구현·조사 작업은 거부.
- acceptance 항목: `{ id, text, check, kind: "new" | "regression" }`. `check`는 **명령 하나**: `&&`, `||`, `|`, `;`, 백틱, `$(`, 줄바꿈을 포함하면 validate 오류(회사 운영에서 굳은 규칙: 명령을 이어 붙이면 실패가 가려진다). 명령이 없으면 `manual`.
- `validate()`: 자기 의존·순환(위상 정렬), 존재하지 않는 의존, owns 정규화 후 겹침(한쪽이 다른 쪽의 접두 경로 / glob과 경로가 한쪽이라도 맞음 / 두 glob의 고정 접두부가 겹침 → 겹침) — 병렬 구현 작업끼리 겹치면 오류. check 단일 명령 규칙.
- 계획 승인 카드 본문: 작업별 `[key] 제목 · 역할·등급·모델 · 검토 모델`, 소유 경로, 수용 기준(kind·check 원문), 프로젝트 setup 명령.

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
**불변식**: 종결되지 않은 요청·작업은 항상 대기·진행 이유가 설명된다: (a) 살아 있는 프로세스(메모리의 검사·통합 작업 포함) (b) 열린 카드·미답 질문 (c) 시각 타이머(한도 해제·대기) (d) 배정 대기 (e) 진행 중인 선행 작업을 기다림 (f) 사람이 보류함(병합 보류). 조정기는 틱과 같은 잠금 안에서 1분마다 검사하고, 이유 없는 상태만 `blocked` + 카드로 드러낸다. 결정·답변·수정·복구 뒤마다 요청 상태를 남은 막힘으로 다시 계산한다.

## 6. 작업자 실행 경계 (샌드박스)
### 6.1 저장소 격리 (v3 핵심)
검토에서 공유 `.git`을 통한 탈출(hook·`core.fsmonitor`·worktree의 `.git` 파일 바꿔치기·`git replace`)이 재현됐다. 그래서 **작업자가 쓸 수 있는 git 저장소에서 hq는 git 명령을 실행하지 않는다.**
- **hq 미러**: 프로젝트마다 `$HQ_HOME/repos/<project>.git`(bare). 설정은 hq만 쓴다. 요청 시작·병합 전에 프로젝트에서 fetch.
- **작업자 복제본**: `$HQ_HOME/work/<requestId>/<key>` = `git clone --shared <미러>`(객체는 미러를 읽기 전용 참조) 후 작업 base에서 브랜치 `hq-work`. 작업자는 여기서만 쓴다.
- **결과 가져오기**: 작업자 종료 후 hq는 미러에서 `git fetch <복제본> +refs/heads/hq-work:refs/hq/<requestId>/<key>/a<n>`(시도 id의 `~`는 ref에 쓸 수 없음)만 실행한다(업로드 쪽은 저장소 설정의 실행형 키를 따르지 않는다). 복제본 안에서는 git을 실행하지 않는다.
- **검증·검토·통합**: 모두 미러에서 `git worktree add --detach`로 만든 worktree에서 한다. 샌드박스는 이 worktree 파일은 쓰게 하지만 미러 자체(index 포함)는 읽기만 허용한다 → 검사가 `assume-unchanged` 같은 index 조작으로 변경을 숨길 수 없다.
- **사용자 저장소**: 샌드박스에서 쓰기 거부. hq는 병합 때만 `git -C <프로젝트> fetch <미러> <integration_sha>` → `merge --ff-only <sha>`를 실행한다(사용자 자신의 hook·설정은 사용자 것이므로 그대로 둔다).
- hq의 모든 git 호출(미러·검증 worktree): `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.untrackedCache=false`, 환경 `GIT_NO_REPLACE_OBJECTS=1`, `GIT_CONFIG_NOSYSTEM=1`, diff는 `--no-ext-diff --no-textconv`, 명시적 `--git-dir`/`--work-tree`.

### 6.2 Seatbelt 프로필
작업자·검토자·collect·setup·check 명령은 모두 `sandbox-exec -f <profile>`로 감싼다.
- 내용 읽기·쓰기 거부(`file-read-data`, `file-write*`): `~/.config/hq`(또는 `HQ_TOKEN_FILE`의 폴더), `$HQ_HOME`의 `hq.db*`·`runs/`(자기 `out/` 제외)·`logs/`·다른 요청의 `work/`, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.docker/config.json`, 등록된 모든 프로젝트의 `.env*`. (`~/Library/Keychains`는 거부하지 않는다: 구독 로그인 토큰이 로그인 키체인에 있어 거부하면 CLI가 인증하지 못함을 실측. 키체인 파일은 암호화돼 있고 항목 접근은 macOS가 통제한다 — 한계로 둔다.)
- **메타데이터 읽기(`file-read-metadata`)는 허용**: Node 등은 경로의 모든 조상 폴더를 lstat한다. 실사용 시험에서 조상 폴더 메타데이터까지 막아 모든 검사가 EPERM으로 실패했다.
- 쓰기 허용 목록: 자기 작업 복제본 또는 자기 검증·검토 worktree, 자기 `out/`, `/private/tmp`, `/private/var/folders`, `/dev`, `sandbox.extraWritable`, 그리고 Claude CLI 실행에 필요한 `~/.claude/projects/`만(실측 최소 집합: 한 줄 응답·Bash·Write·Edit은 쓰기 없이 동작, `--resume`만 `projects/` 필요). `~/.claude/settings*.json`, `CLAUDE.md`, `skills/ agents/ commands/ plugins/ hooks/`는 쓰기 거부(사용자 세션에 훅을 심는 경로 차단). `~/.claude.json`은 CLI가 매 실행 쓰므로 허용하되 한계로 문서화(사용자 범위 MCP 추가 가능) — 다음 단계에서 `CLAUDE_CONFIG_DIR` + 토큰 인증으로 대체 검토.
- 실행 거부: `/usr/bin/open`, `/usr/bin/osascript`, `appleevent-send`, `launchctl`.
- 네트워크: `localhost`/`127.0.0.1`의 hq 포트 거부.
- 예외: 자기 시도의 `hq/prompt.md`·`stream.jsonl`·`stderr.log`는 메타데이터만(stdio 파일).
- 환경변수는 허용 목록만: `PATH HOME USER LANG LC_ALL TERM TMPDIR SHELL HQ_ATTEMPT_OUT` + git 보조(`GIT_TERMINAL_PROMPT=0`, push 기본값 무력화). `ANTHROPIC_*`, `OPENAI_*`, `HQ_TOKEN`, `SSH_AUTH_SOCK` 제거.
- 권한 플래그(가드레일): 모든 역할에 `--tools <목록>` + `--setting-sources "" --strict-mcp-config --disable-slash-commands`.
  - implement: `--tools Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch --allowedTools` 같은 목록 `--permission-mode acceptEdits --add-dir <out>` (`--allowedTools` 없이는 커밋이 거부됨을 실측)
  - collect: `--tools Read,Glob,Grep,WebFetch,WebSearch,Write --permission-mode dontAsk --allowedTools Read,Glob,Grep,WebFetch,WebSearch,Write(//<out 절대경로>/**)`, cwd = base의 미러 worktree
  - review: `--tools Bash,Read,Glob,Grep --permission-mode dontAsk --allowedTools Bash,Read,Glob,Grep --json-schema <VERDICT>`
- 실행: `--output-format stream-json --verbose --model <m> --session-id <uuid>|--resume <uuid> --max-turns <n>`, stdin = prompt 파일, `detached: true`.
- **남은 한계(문서화)**: 네트워크는 열려 있다(웹 조회 필요). 작업자가 읽을 수 있는 것(프로젝트 코드)은 외부로 보낼 수 있다. 1인 로컬 도구 위협 모델에서 "비밀 파일은 읽을 수 없다"까지를 보장 범위로 둔다.

## 7. 시작·종료 프로토콜 (중복 실행 방지)
1. 트랜잭션: attempt 행 `starting` + `session_id` + `attempt_token` + 폴더 기록 → task `running`. 시도 번호 `n`은 종류별로 **항상 증가하는 순번**(`max(n)+1`)이며 재작업 사다리용 `tasks.attempts`와 별개다.
2. spawn → 즉시 `pid`와 `ps -o lstart=`(LC_ALL=C)를 attempt 행과 `hq/process.json`에 기록.
3. 복구 시 `starting` 행: pid 없으면 셸 없이 `pgrep -f -- <세션 uuid>`로 고아를 찾는다(자기 pid 제외) → 찾으면 채택, **없으면 자동 재실행하지 않고 task `blocked`**("시작 여부 불명확") — 중복 실행보다 멈춤이 낫다. pid가 있으면 `lstart` 일치로 동일 프로세스 확인.
4. 시도가 끝나면(판정 직후, 정상 포함) 프로세스 그룹 전체 SIGTERM → 10초 후 SIGKILL(작업자가 띄운 백그라운드 프로세스 정리).
5. 저장소 단위 뮤텍스: 같은 미러·프로젝트에 대한 hq의 git 쓰기는 직렬.
6. 다음 시도는 같은 작업 복제본에서 이어간다. 복제본을 되돌리지 않는다(미커밋 작업 보존). 프롬프트에 "이전 시도의 미커밋 변경이 남아 있을 수 있음"과 이전 실패 사유를 넣는다.
7. **세대(generation)**: task마다 `generation` 정수. 무효화·취소·수정 적용 때 +1하고 살아 있는 시도 그룹을 종료(종료 확인까지)한다. 모든 판정·전이는 "시도의 generation == task의 현재 generation" 조건부로만 반영한다(늦게 도착한 결과는 증거만 남기고 무시).
8. 데몬 단일 인스턴스: `$HQ_HOME/daemon.lock`을 `O_CREAT|O_EXCL`로 만든다. 이미 있으면 안의 pid가 살아 있고 명령줄에 `src/main.ts`면 종료, 아니면 오래된 잠금으로 보고 지운 뒤 다시 배타 생성.

## 8. 완료 판정 (작업 시도)
프로세스 종료 확인 후:
1. **한도**: 구조화 신호만 — `rate_limit_info.status == "rejected"` 또는 result `is_error` && `api_error_status == 429`. result 줄이 없을 때만 stderr 정규식. → `limited`(시도 수 안 셈, task `held`, 같은 세션 `--resume`으로 이어감). 작업당 연속 3회 → `blocked`.
2. **일시 오류**: result `is_error` && `api_error_status` 5xx·과부하 → `transient`(시도 수 안 셈, 1회 자동 재시작, 2회 연속이면 `failed`).
3. 폭주로 죽였으면 → `runaway`. result `subtype == error_max_turns` → `failed`("턴 상한").
4. 정상 종료인데 `out/done.json` 없음·파싱 실패·토큰 불일치 → `unverifiable`. **자동 재시도 1회**(같은 모델, 시도 수에 셈): 작업자가 끝까지 실행됐고(result 줄 있음) done.json 이후 변경이 없을 때만. 두 번째 `unverifiable`, 폭주로 멈춘 경우, 시작 불명확은 `blocked`.
5. outcome `question` → `question` (라운드 최대 3, 초과 → `blocked`).
6. outcome `blocked` → `brief_blocked` → task `revising` (§10a).
7. outcome `failed` → `failed`.
8. `succeeded` 검사 (implement, 미러로 fetch한 뒤 미러에서): `head_sha` = fetch한 `hq-work` 끝 = 종료 시점 HEAD; `git diff --name-only --no-renames <task.base_sha> HEAD` = `files_modified`; 모두 owns 안(rename 양쪽 경로 포함); 작업 트리 깨끗함; `out/report.md` `## 요약` 200자 이상; base..HEAD 모든 커밋이 base의 자손(`rev-list`)이고 merge 커밋 없음. 하나라도 실패 → `failed`.
   collect: done/토큰/outcome 공통 검사 + report 요약 + cwd 트리 무변경. 보고서는 hq가 `hq/report.sealed.md`로 복사하고 sha256을 task에 기록(후행 작업에는 봉인본 경로 전달).
9. 보호 경로(`protectedPaths`)에 해당하는 변경은 통과시키되 목록을 기록 → 검토 프롬프트에 "보호 경로 변경: 테스트·설정 약화 여부 반드시 판정"으로, 수락 카드에 표시.

## 9. 기계 검증 (hq가 직접)
- 미러에서 `head_sha`의 **새 검증 worktree**를 만들고 setup 후, 모든 non-manual check를 샌드박스 안 `/bin/sh -c <check>`(stdin /dev/null, 최소 env, 프로세스 그룹 타임아웃)로 실행. setup 뒤·첫 검사 전에 추적 파일 내용(작업 트리·index)이 검사 대상 커밋과 같아야 한다(내용 해시 비교, 미추적·무시 파일은 허용) — 다르면 `setup이 추적 파일을 바꿨어요: <파일>`로 환경 실패(task `blocked`, 기준선은 setupFailed와 같게, 통합은 통합 카드). 검사마다 끝난 뒤 같은 비교와 HEAD를 다시 확인 — 검사가 추적 파일을 바꾸면 실패. 검증·기준선·통합·검토 worktree 모두 같은 규칙.
- **기준선은 면제에 쓰지 않는다**(v3). base에서도 같은 check를 한 번 실행해 기록만 한다(캐시 키 `<repo>:<base_sha>:sha256(setup+check)`).
  - `kind: new`: 후보에서 반드시 통과. base에서 이미 통과했다면 "이 검사는 새 동작을 확인하지 않아요" 경고를 수락 카드에 표시.
  - `kind: regression`: 후보에서 통과해야 한다. base에서 일반 실패(0이 아닌 종료)였어도 **후보에서 반드시 실행**한다. 후보에서 통과하면 통과. 후보에서도 일반 실패(126/127·시간 초과 제외 — 그건 그냥 실패)면 그 항목만 `manual`로 돌려 검토자가 후보·base 출력을 비교해 "악화 없음"을 증거로 판정하고, 수락 카드에 "기존 실패"로 표시.
  - **환경 실패는 기존 실패가 아니다**: base에서 setup 실패·시간 초과, 또는 regression 검사의 exit 126/127(실행 불가·명령 없음)이면 작업자를 띄우기 전에 task를 `blocked`로 멈추고 원인(명령·종료 코드·마지막 출력 줄)과 해결(setup 등록·계획 수정)을 적는다. 이 결과는 캐시하지 않아 재시도 때 다시 잰다. `kind: new` 검사의 126/127은 아직 없는 파일을 실행하는 정상 경우라 제외.
- 비밀값 검사: base..HEAD의 **모든 커밋**의 추가 줄 + 파일명 거부 목록(`.env*`, `*.pem`, `id_rsa*`, `*.p12`, `*.key`). 값은 기록하지 않는다.
- 검사 실행도 시도처럼 기록(pid·시작 시각). 재시작 복구 때 남은 검사 프로세스 그룹을 종료한 뒤 다시 실행.
- 결과 `hq/checks.json`. 실패 → 재작업.

## 10. 교차 검토
- 검토 worktree: 미러에서 `git worktree add --detach <path> <head_sha>` + setup(검토자는 미러를 쓸 수 없다). collect 작업도 L2 이상이면 검토한다(보고서 내용·출처 검토). 모델: `task.review_model`(§3). 독립성은 새 세션·새 worktree에서 오며 같은 Claude 계열임을 표시한다(`sameFamily: true`).
- VERDICT 스키마(정식 JSON Schema, 추가 필드 금지): `pass, blocking[{id,summary,evidence}], advisory[{id,summary}], criteria[{id,result pass|fail|manual,evidence}], tests_run[{command,exit_code,summary}]`.
- hq 검증:
  1. `criteria[].id` 집합 = 작업 acceptance id 집합(누락·중복·모르는 id → 무효).
  2. `tests_run[]`의 각 명령은 검토자 stream의 실제 Bash `tool_use`와 **공백 정규화 후 정확히 같은 명령**이어야 한다(부분 일치 불인정: 실사용에서 다른 명령과 잘못 짝지어졌다). 종료 코드: `tool_result.is_error=false` → 0, `Exit code N` 접두어 → N, 중단·백그라운드 → 알 수 없음(무효). `|`, `||`, `;`, `true`로 끝나는 명령은 근거로 인정하지 않는다. 검토 프롬프트에 "테스트 명령은 이어 붙이지 말고 하나씩 실행하고, 실행한 문자열 그대로 적을 것"을 넣는다. 코드 변경이 있는데 `tests_run` 비면 무효.
  2a. `pass=true`이면 모든 `tests_run.exit_code == 0`이어야 한다. manual 기준(명시적 `manual`과 기존 실패)은 검토자가 증거와 함께 **pass 또는 fail**로 판정해야 한다(`manual`·누락 → 무효). 수락 카드에 `검토자 판정: [id] 결과 — 근거 한 줄`로 표시. 검토 모델이 none인데 이런 기준이 있으면 sonnet 검토를 추가한다.
  명령 규칙(계획 check와 tests_run 공통, 원문 문자열 기준): 줄바꿈, `;`, `|`, `||`, `&&`, 단독 `&`, 백틱, `$(`, 단어 `exit`, 끝의 `true`/`:` 거부.
  3. `pass=true`인데 blocking 또는 fail 기준 → 무효. `pass=false`인데 blocking 없음 → 무효.
  4. 무효 → 같은 head에서 재검토 1회, 두 번째 무효 → task `blocked`.
- hq가 verdict에 바인딩 필드를 직접 붙인다(`task, head_sha, base_sha, reviewer_model, implementer_model, sameFamily`).
- blocking → 재작업(사유 = blocking 목록). 검토 worktree는 끝나면 제거.

## 10a. 지시서 수정 턴 (CEO)
작업자 `blocked` → CEO 수정 턴: 입력 원 PlanTask·report.md·diff stat. 출력 `{ revised_task | null, questions }` 정확히 하나.
- 자동 적용 조건(v3): **`brief`와 `title`만 바뀌었을 때**. 나머지(`owns`, `acceptance` 전체, `depends_on`, `grade`, `model`, `review`)가 하나라도 다르면 카드 `revise:<taskId>`(수정 전후 차이 표시). 적용 전 전체 계획 `validate()` 재실행, 적용 시 generation +1.
- 적용 시 task `revision+1`, 이 작업에 의존하는 후행 작업 무효화(§11).
- task당 최대 2회, 초과 → `blocked`.
- 작업 id·project·role 변경은 거부(`지시서 수정으로 프로젝트·역할은 바꿀 수 없어요`).
- 수정 턴이 질문을 내면: 작업 질문(task_questions, 표시 `사장 질문`)으로 저장하고 task `question`. 모두 답하면 `revising`으로 돌아가 답을 붙여 수정 턴을 다시 실행한다(질문 라운드는 수정 횟수에 세지 않고 최대 3라운드).

## 11. 재작업·의존·무효화
- 실패(`failed`, `runaway`, 검사 실패, 검토 blocking, 결과 반려) 시 `attempts < maxAttempts`면 재작업: 2번째는 같은 모델, 3번째는 ladder 한 단계 위. 도달 → `blocked`("N번 실패", N = 실제 횟수).
- **작업별 base**: 같은 프로젝트 의존이 없으면 요청 base(승인 시점 프로젝트 HEAD), 하나면 그 `head_sha`, 여럿이면 hq가 worktree에서 의존 head들을 `--no-ff` 병합한 커밋(충돌 → `blocked`). owns·diff·검토는 모두 이 `base_sha` 기준.
- 다른 프로젝트 의존·collect 의존: 봉인된 보고서 **내용**(20KB 상한, 넘으면 앞부분+잘림 표시)과 sha256, 선행 head SHA를 프롬프트에 넣어 전달(작업자는 `$HQ_HOME`을 읽을 수 없음).
- **무효화**: 선행 작업의 산출물(코드 `head_sha` 또는 collect 보고서 해시)이 바뀌면 전이적으로 의존하는 모든 작업의 generation +1, 살아 있는 시도 종료 확인, `pending`, 작업 복제본 폐기(미러 ref는 보관), attempts 0(시도 번호 n은 계속 증가), 이전 질문·세션·base·검증·검토 무효. 수락 카드가 열려 있으면 superseded.

## 12. 수락·통합·병합
- 모든 작업이 `passed` 또는 `cancelled`(최소 1개 passed) → 프로젝트별 **통합**: 통합 worktree를 대상 브랜치의 현재 SHA에서 만들고 통과 작업의 **기록된 head SHA**를 계획 순서로 `--no-ff` 병합 → setup → 모든 작업의 non-manual check + 비밀값 검사. 결과 `integration_sha`. 충돌·검사 실패 → 요청 `blocked` + 카드 `integration:<req>:<project>`(다시 통합 / 요청 중단). 통합에는 기존 실패 면제가 없다: 작업 검증에서 기존 실패였던 검사가 통합본에서도 실패하면 `기존 실패 검사 <id>(<command>)가 통합본에서도 실패해요 · …`로 통합 실패.
- 수락 카드 `accept:<req>` (옵션 `수락`·`반려`), subject = 정렬된 `(taskId, generation, head_sha, report sha256, checks 결과 해시, verdict 해시)`. **수락은 작업 결과에 대한 판단**이고, 통합 SHA는 병합 카드가 묶는다(재통합돼도 수락은 유지, 병합 카드가 새 통합 SHA와 "대상 브랜치에 새로 생긴 커밋 N개"를 보여 준다). 통합 검사는 실제로 포함한 passed 작업의 기준만 실행한다.
- 반려는 `POST /api/requests/:id/reject {reason(필수), subjectHash, tasks?}` 로만(카드의 `반려` 결정은 거부 409). 계획 카드 `반려` → 요청 `rejected`.
- 통합 충돌·검사 실패 카드 선택지: `다시 통합` · `해당 작업 재작업`(새 대상 위에서, 무효화 규칙) · `요청 중단`. 다중 의존 base 충돌도 같은 카드.
- 모든 작업이 skip·취소되면 요청 `cancelled`("남은 작업 없음"). 본문: 작업별 요약·변경 파일 수·검사·검토·보호 경로 변경·기존 실패·취소된 작업. collect만 있는 요청은 수락으로 `merged`와 같은 완료 상태 `accepted`에서 끝난다(병합 없음 → `merged`로 표시하지 않고 `accepted` 종결).
- 반려: 사유 + 선택적 작업 key 목록(없으면 통과 작업 전부) → 해당 작업 재작업, 후행 무효화.
- 수락 → 프로젝트별 병합 카드 `merge:<req>:<project>` (옵션 `병합`·`보류`), subject = `(target, target_sha, integration_sha)`.
- 병합 실행: 저장소 뮤텍스 → 사용자 checkout이 `target` 브랜치·`target_sha`·깨끗함인지 확인 → `git merge --ff-only <integration_sha>` 한 번. 다르면 병합하지 않고 통합부터 다시(새 카드, 본문 첫 줄 사유). 사용자 checkout이 detached HEAD면 카드 대신 사유 표시.
- 모든 프로젝트 병합 → `merged`, 작업 worktree·브랜치 정리(worktree는 `--force` 제거 — 검증된 SHA가 이미 병합됨, 브랜치 `-d`). 대상 프로젝트가 hq 자신이면 "hq 재시작 필요" 알림.
- 카드 만료: plan 7일(만료 → 요청 `expired`), accept·merge·revise·integration·blocked는 만료 없음(해시 고정). 보류된 병합은 `POST /api/requests/:id/merge`로 다시 제시.

## 13. 한도·동시성·폭주
- quota: stream의 `rate_limit_event.rate_limit_info`(`status`, `resetsAt` epoch초, `unifiedWindows.{창}.{utilization,resetsAt}`)를 창별 행으로 저장. `resets_at`이 지난 창은 알 수 없음으로 본다.
- 모드: `hold` = 최상위 `rate_limit_info.status == "rejected"`(창은 `rateLimitType`) 또는 어떤 창이든 ≥ holdAt → 모든 시작 중지(CEO 턴·팀 포함), 그 창의 resetsAt까지. **`overageStatus`는 신호가 아니다**(정상 이벤트에도 `"rejected"`가 들어 있음을 실측). resetsAt 없는 `rejected`·429 → 15분·30분·60분 지수 대기(타이머, 불변식 c). `save` = ≥ saveAt. 관측 없음 = save와 같다.
- 로그인 실패(result `is_error` + `"Not logged in"`) → 전역 hold + 결정 카드 1건 "Claude 로그인 필요"(작업별 unverifiable로 흩어지지 않게).
- 동시성(모든 모델 실행이 같은 예산): normal = 작업·검토 `maxWorkers` + CEO 1. save·관측 없음 = **전체 1개, CEO 턴이 우선**(판단이 작업자보다 먼저 한도를 쓴다).
- 검토 시도도 연속 limited 3 → blocked. 시간 예산: 시도당 `attemptWallMinutes[grade]`, 작업 누적(resume 포함) 3배 상한.
- 판정 우선순위: hq가 폭주로 죽였으면 `runaway`(과거 한도 이벤트가 덮지 않음).
- CEO 턴도 stream-json으로 실행해 관측을 얻는다. 팀 스케줄러도 hold를 따른다. 기존 `limit.blockedUntil`은 quota 관리자로 통합.
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
- `POST /api/ui-code`(Bearer) → `http://127.0.0.1:<port>/ui/#code=<32바이트 랜덤, 60초, 1회>`.
- SSE는 `?t=` 쿼리 대신 `fetch` 스트리밍 + `Authorization` 헤더로 받는다(v3: 장기 토큰을 URL에 싣지 않음). 코드는 fragment라 서버 로그·Referer에 남지 않는다.
- 페이지 JS가 `POST /ui-api/session {code}`로 교환(원자적 1회 소비) → 세션 토큰(32바이트, 유휴 12시간·최대 7일)을 `sessionStorage`에 두고 `Authorization: Bearer`로 호출. **쿠키 없음**(포트 간 쿠키 공유 문제 제거, CSRF 불필요). 데몬 재시작 시 세션 폐기.
- `/ui-api/*`: 세션 토큰 확인 → `/api/*` 라우터로 위임(Bearer를 데몬 토큰으로 교체). 쿼리 문자열 토큰은 어떤 경로에서도 받지 않는다.
- 모든 `/ui*` 응답: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. 작업자 산출물은 textContent로만 렌더링(마크다운은 원시 HTML 불허 렌더러, 링크는 http(s)만 + `rel=noopener noreferrer`).

## 17. 화면용 데이터 (src/types.ts가 권위)
Snapshot: `workers`, `headline`, `quota`, `decisions: DecisionItem[]`, `RequestView.tasks`. `needsYou = decisions.length`.
`DecisionItem.options`는 **서버에 그대로 보낼 값**이다: 승인형 카드는 카드 옵션 문자열(`승인`·`반려`, `수락`·`반려`, `병합`·`보류`, `다시 통합`·`요청 중단`), 질문은 선택지 문자열, blocked는 `retry`·`skip`·`stop`. blocked 표시 이름은 클라이언트가 고정 매핑한다: retry → `한 번 더`, skip → `이 작업 건너뛰기`, stop → `요청 중단`. (retry는 **같은 모델**로 한 번 더 — 사람이 누른 재시도는 인프라 문제일 수 있어 모델을 올리지 않는다. 사다리 상향은 자동 재작업에서만)
DecisionItem 순서: system(예: `system:login` — Claude 로그인 필요, requestId는 빈 문자열) → plan → ceo_question → worker_question → revise → blocked → integration → accept → merge (각 종류 안에서는 오래된 순). 알림은 `decision id + revision`으로 중복 방지.

### 결정 카드 설명 (필수)
모든 DecisionItem은 `situation`(무슨 일인지 쉬운 말 1~2문장), `cause`(+`causeConfirmed`), `recommendation`(선택지 하나와 이유), `optionHelp`(선택지마다 고르면 무엇이 일어나는지: 비용·되돌릴 수 있는지)를 채운다.
- `blocked`·`integration`: CEO **진단 턴**(읽기 전용, 도구 Read/Glob/Grep, 스키마 `{situation, cause, causeConfirmed, recommendation:{option, reason}}`, 입력: 작업 spec·시도별 판정 사유·checks 실패 항목·verdict blocking·report 요약)이 쓴다. 확인한 근거(검사 로그·판정)가 있는 원인만 `causeConfirmed: true`. 진단 턴 전·실패 시에는 hq의 사실 문장으로 채우고 추천은 null.
- 그 밖의 종류는 hq가 사실로 만든다. 예) accept: "작업 2개가 검사·검토를 통과했어요 · 결과를 확인하고 수락해 주세요", 추천은 두지 않는다(회장 판단). merge: 대상 브랜치·SHA·변경 파일 수.
- `optionHelp` 고정 문구: retry "같은 작업을 같은 모델로 한 번 더 해요 · 사용량이 들어요", skip "이 작업과 여기에 의존하는 작업을 빼고 계속해요 · 나중에 새 요청으로 다시 할 수 있어요", stop "요청 전체를 멈춰요 · 만든 브랜치는 남겨 둬요", 수락 "통합본을 병합 대기로 넘겨요 · 병합은 따로 승인해요", 반려 "사유를 붙여 다시 작업시켜요", 병합 "대상 브랜치에 fast-forward로 반영해요", 보류 "지금은 병합하지 않고 둬요 · 나중에 다시 제시할 수 있어요".

## 18. 상황 문장 (headline)
우선순위: 결정 → 장애(blocked·unverifiable·통합 실패) → 실행 중 → 한도 보류·대기 → 유휴.
- `회장님 결정 N건: <첫 항목>`
- `<작업>이 막혔어요: <사유 한 줄>`
- `<작업> <구현|검토|검증> 중 · <모델> · 다음: <단계>` (+ `외 N명`)
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
- CEO 창: 탭 `내 차례 N` / `새 요청` / `사용량`. 내 차례: 결정 카드(§17 순서) — 제목(프로젝트 · 작업), 상황, 원인(확인됨/추정), **추천 문단(강조)**, 선택지 버튼과 각 선택지 설명, `원문 보기`(웹). 새 요청: 입력·프로젝트 선택·최근 결과. 사용량: 창별 사용률·리셋·모드. 아래 `사무실 열기`(웹)·`닫기`.
- 작업자 창: 제목·모델·상태(`! 확인 필요` 등). blocked면 "사장에게 보고했어요 · 결정은 사장 카드에서 해요" + `사장 카드 열기` 버튼. 최근 활동 5줄. `사무실 열기`·`닫기`.

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

## 21. 검토·실사용 판정 기록 (v2 → v3)
입력: Codex 재검토(N01~N10, A01~A05), Claude 재검토(N1~N4, A1~A13), 회사 AI의 개인 하네스 가이드, 첫 실사용 시험(요청 req-2086b7b3).
| 지적 | 판정 | 반영 |
| --- | --- | --- |
| 공유 .git 경유 탈출: hook·fsmonitor·gitfile·replace (X-N01, C-N1, 두 검토자 재현) | 채택 | §6.1 작업자 전용 복제본 + hq 미러, 작업자 저장소에서 hq git 실행 금지 |
| ~/.claude 쓰기로 사용자 세션 오염 (C-N2) | 채택(2순위안) | §6.2 런타임 하위 폴더만 쓰기. CLAUDE_CONFIG_DIR+토큰은 다음 단계 검토 |
| 기준선 면제로 거짓 통과 (X-N02, C-N4, 실사용에서 발생) | 채택 | §9 면제 폐지, acceptance kind new/regression |
| 조상 폴더 메타데이터 거부로 검사 전부 EPERM (실사용) | 채택 | §6.2 file-read-metadata 허용 |
| 검토자 tests_run 부분 일치로 오판 (실사용), 종료 코드 규칙 (C-A4) | 채택(정확 일치로) | §10.2 |
| 시도 번호 unique 충돌·resume 경로 (C-N3) | 채택 | §7.1 순번 분리, resume 프롬프트에 새 경로·토큰 |
| 봉인 보고서 접근·무효화·세대 (X-N03) | 채택 | §11, §7.7 generation |
| 자동 수정이 계획을 바꿈 (X-N04, C-A12) | 채택 | §10a brief·title만 자동 |
| 불변식이 정상 대기를 오류로 (X-N05, C-A10) | 채택 | §5 대기 이유 (e)(f), 틱 잠금 안 조정기 |
| 통합 변경 시 수락 (X-N06 재수락 / C-A1 병합 카드가 통합을 묶음) | C-A1 채택 | §12 수락=작업 결과, 병합 카드=통합 SHA |
| pgrep 부재를 미실행으로 (X-N07), 잠금 흉내 | 채택 | §7.3 blocked, §7.8 O_EXCL |
| 승인 소비와 전이 분리, 오래된 반려 (X-N08) | 채택 | §12 반려 API 전용·subjectHash, 결정은 runner 한 트랜잭션(spec) |
| status·index 조작, 실패 테스트와 pass 모순 (X-N09) | 채택 | §6.1 미러 worktree, §10 2a |
| 한도·슬롯·검토 limited·overageStatus (X-N10, C-A2, C-A3) | 채택 | §13 |
| SSE 토큰 URL (X-A01) | 채택 | §16 fetch 스트리밍 |
| dirty patch 유실 (X-A02) | 채택 | §7.6 복제본 보존 |
| 로그 절단과 검토 증거 (X-A03) | 채택 | 판정 시 Bash 실행 기록을 DB에 먼저 저장(spec) |
| 비밀 읽기 거부 목록·open/osascript (C-A6, 미확인 항목) | 채택 | §6.2 |
| L0 검토 none + 보호 경로 (C-A5) | 채택 | §3 자동 상향 |
| check 단일 명령 (회사 가이드) | 채택 | §3 |
| 형식 실수 자동 재시도 1회 (회사 가이드) | 채택 | §8.4 |
| 사람 재시도는 모델 유지 (회사 가이드) | 채택 | §17 |
| 판단이 작업자보다 먼저 한도를 씀 (회사 가이드) | 채택 | §13 save 모드 CEO 우선 |
| 약관 확인 (회사 가이드 5.5) | 기각(이번 범위 밖) | 회장 지시: 완성도 우선 |

### v3 구현 중 판정 (실행 엔진 보고)
| 항목 | 판정 |
| --- | --- |
| `~/Library/Keychains` 읽기 거부 시 구독 인증 실패 | 거부 목록에서 제외(§6.2), 한계로 문서화 |
| 미러 ref에 `~` 불가 | `refs/hq/<req>/<key>/a<n>` |
| 형식 실수 자동 재시도 조건(done.json 없을 때) | "result 줄 있음 + hq가 죽이지 않음"으로 해석 |
| 다중 의존 base 충돌 | 통합 카드가 아니라 blocked 카드(진단 턴이 원인·추천) |
| 기준선 환경 실패를 "기존 실패"로 분류해 검사 없이 통과 (dogfood: 의존성 없는 복제본에서 `tsc` exit 127, 인자 없는 `node --test` 시간 초과) | 환경 실패는 작업 전 blocked, 기존 실패도 후보에서 실행(§9) |
| 작업자 복제본이 프로젝트의 로컬 `user.email`을 물려받지 못해 전역 신원으로 커밋 | 복제 직후 프로젝트 저장소의 user.name/email을 복제본 로컬 설정에 기록(§6.1) |

## 22. 구현 검토 판정 (v3 구현 → v4, 2026-09-30)
외부 구현 검토 2건(`research/25-*`, 둘 다 NO SIGN, 대부분 재현 확인)에 대한 판정. 아래가 이 계약의 새 기준이다.

| 지적 | 판정 | 규칙 |
| --- | --- | --- |
| LaunchServices로 샌드박스 밖 프로세스를 띄워 토큰 읽기 (치명) | 채택 | §6.2: `mach-lookup`은 허용 목록(실측 최소 집합)만. 탈출 시도는 격리 시험의 필수 항목 |
| 거부 목록 밖 비밀 읽기 (`~/.codex` 등) | 채택 | §6.2: 홈 아래 내용 읽기는 기본 거부 + 허용 목록(자기 경로, `~/.claude` 읽기, Keychains, 툴체인). 메타데이터 읽기는 유지 |
| `~/.claude/projects` 전체 쓰기 → 사용자 세션 메모리 오염 | 채택 | 작업자 cwd에 해당하는 폴더와 CLI가 꼭 쓰는 하위 경로만 쓰기 허용 |
| 사용자 캐시 쓰기 → 샌드박스 밖 실행 오염 | 채택 | 시도마다 캐시 폴더 분리(`npm_config_cache`·`XDG_CACHE_HOME`), 사용자 캐시는 쓰기 금지 |
| 샌드박스 안에서 남의 프로세스에 시그널 | 채택 | 자기 자신·자식에게만 시그널 허용 |
| setup이 추적 파일을 바꿔 검사 대상 ≠ 병합 대상 (치명) | 채택 | §9: setup 뒤·검사마다 추적 파일 내용이 검사 대상 커밋과 같아야 한다(내용 비교). 다르면 환경 실패 |
| 통합 단계의 기존 실패 면제 | 채택 | §12: 통합본에서 실패한 기존 실패 검사는 통합 실패 카드로. 후보의 126/127·시간 초과는 기존 실패로 보지 않는다 |
| 수동 기준이 판정 없이 통과 | 채택 | §10: 수동 기준(명시·기존 실패)이 있으면 검토 필수. 검토자는 그 항목에 pass/fail만 가능, `manual`이면 판정 무효 |
| 여러 줄·`& wait`로 실패 가리기 | 채택 | 계획 check와 tests_run에 같은 원문 규칙(줄바꿈·`;`·`|`·`&&`·`||`·단독 `&`·백틱·`$(`·`exit`·끝의 `true`/`:` 금지) |
| 재사용된 pid에 시그널 / 신원 확인 불가 시 kill | 채택 | §7: 신원(pid+시작 시각)이 확인된 자기 프로세스 그룹에만 시그널. 확인 불가면 시그널하지 않고 증거만 회수 |
| 취소 뒤 준비 중이던 작업자 시작, 빠른 종료 놓침 | 채택 | 모든 비동기 경계 뒤·spawn 직전 generation·요청 상태 재확인. 종료 관찰은 spawn 시점부터 |
| 팀이 회장 토큰으로 결정 가능 | 채택 | 팀은 실행마다 범위 토큰(자기 팀 카드 생성·조회, 한도 조회만). 토큰 폴더·`$HQ_HOME` 읽기 금지 프로필로 실행 |
| 재시작 뒤 팀 중복 실행 | 채택 | 팀 실행도 pid·시작 시각·종료 표식을 영속하고 재시작 때 이어받는다. 확인 불가면 새로 시작하지 않는다 |
| 수정안이 프로젝트·역할을 바꿈, 수정 턴 질문에 답할 수 없음 | 채택 | 수정으로 id·project·role 변경 금지. 수정 턴 질문은 질문 상태로 저장하고 답하면 수정 턴 재실행 |
| 수락 전 diff가 빈 화면 | 채택 | 증거 API는 hq 미러의 고정 SHA로 읽고, 읽기 실패와 빈 변경을 구분 |
| CLI가 `src/main.ts` 문자열만으로 kill, 포트만 다른 명령이 실제 데몬 종료, 부분 설정·삭제 위험 | 채택 | 잠금 파일에 pid·port·root·home·시작 시각 기록, 모두 일치할 때만 시그널. 설정 변수는 전부 지정하거나 전부 기본. 삭제는 설치 표식이 있는 대상만 |
| 작업자 전용 macOS 사용자로 분리 | 보류 | 관리자 권한과 별도 로그인이 필요해 1인 설치 경험을 해친다. v4 프로필 + 공격 시험으로 대신하고, 남은 위험은 SETUP에 명시 |
