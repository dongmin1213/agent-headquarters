# 실행 엔진 구현 지시서 v2

작성: 오케스트레이터. 대상: 실행 엔진 작업자. 상위 계약: `execution.md` v2(이하 §). 이 문서는 **판단**(모듈 경계·인터페이스·동작 규칙·전이·테스트 케이스)만 담는다. 코드는 작업자가 쓴다. 지시와 코드 현실이 다르거나 모호하면 스스로 설계하지 말고 멈추고 무엇이 어떻게 다른지 보고한다.

## A. 기존 WIP(`stream/exec` 0d24e7c)의 처리
유지하고 고칠 모듈: `fsx.ts`, `git.ts`, `contract.ts`, `quota.ts`, `worker.ts`, `checks.ts`, `review.ts`, `prompt.ts`, `store.ts` 추가분, `runner.ts`(아래 판정대로 수정).

WIP에서 작업자가 스스로 정한 15개 결정에 대한 판정:
| # | WIP 결정 | 판정 |
| --- | --- | --- |
| 1 | blocked 작업은 카드 없이 `/decide`로만 결정, needsYou 계산 | 유지. 단 needsYou는 v2의 `decisions` 목록 길이(§17) |
| 2 | verify 작업을 DB 행으로, 자동 passed, 그 check를 대상 검사에 포함 | **폐기**. v2는 verify 역할 자체가 없다(§3). 구현 작업의 `review` 필드 사용 |
| 3 | collect는 base의 detached worktree, done.json 직접 쓰기 | 유지(§6: out 폴더에만 Write, rename 불필요) |
| 4 | attempts 증가 후 limited 등에서 감소 | 동작이 같으면 허용. 규칙은 §C "시도 카운트" |
| 5·6 | 작업자 질문·invalid 횟수를 kv에 저장 | **변경**. 질문은 `task_questions` 테이블(§4), invalid 횟수·연속 limited는 tasks 컬럼 |
| 7 | 한도 신호 없는 limited 시 kv blockedUntil +1h | **변경**. quota 테이블이 유일한 원천(§13). 구조화 신호 없는 한도 판정은 하지 않는다(§8.1) |
| 8 | 한도 관측 전 동시 1 | 유지(§13) |
| 9 | 시작 실패 3회 연속 → blocked | 유지 |
| 10 | 다중 의존: 다른 의존을 조상으로 가진 head에서 분기, 없으면 blocked | **변경**. §11: hq가 의존 head들을 병합한 base 커밋을 만든다 |
| 11 | process.json에 lstart, ±2초 대체 | 유지 + §7 pgrep 고아 탐지 추가 |
| 12 | accept/merge 카드 7일 만료·재발급 | **변경**. 해시 고정 카드는 만료 없음(§12). plan만 7일 |
| 13 | 병합 kv 상태, 충돌 시 reset --keep, 크래시 abort, 보류 24h 후 재발급 | **폐기**. §12 통합 worktree + `--ff-only` 한 번. merges 테이블. 보류는 재발급 안 함(API로 재제시) |
| 14 | 취소 시 worktree 제거, 브랜치 유지 | 유지 |
| 15 | 도구 목록을 argv 항목별로 | 유지 |

## B. 모듈 경계
| 파일 | 책임 | 공개 인터페이스(이름·입출력) |
| --- | --- | --- |
| `exec/sandbox.ts` (새) | Seatbelt 프로필 생성·래핑 | `sandboxProfile(o: {worktree, out, repoGitDir, hqHome, tokenDir, hqPort, extraWritable, claudeDir}): string`; `wrap(argv: string[], profilePath: string): string[]` → `['sandbox-exec','-f',profile, ...argv]`; `childEnv(extra): NodeJS.ProcessEnv` (§6 허용 목록만) |
| `exec/git.ts` | + 저장소 뮤텍스 `withRepo(repo, fn)`; `mergeHeads(worktree, shas, message)`; `commitsBetween(base, head)`; `hasMergeCommits`; `worktreeDirtySnapshot(wt) → patch text` | |
| `exec/contract.ts` | §8 판정 전체 (brief_blocked, transient, max_turns, 보호 경로 목록, 조상·merge 커밋 검사, out 파일 안전 읽기) | `judgeWork(facts): Judgement` (순수), `readOut(outDir, name, max): string \| null` (lstat/O_NOFOLLOW) |
| `exec/checks.ts` | §9 (샌드박스 실행, 검사 전후 불변, 기준선, 전 커밋 비밀 검사, 파일명 거부 목록) | `runChecks(o): ChecksFile`, `baseline(o): Record<checkId, boolean>` |
| `exec/review.ts` | §10 VERDICT 스키마, `checkVerdict(raw, {acceptanceIds, codeChanged, bashRuns})` | `bashRuns`는 stream에서 뽑은 `{command, exitCode}[]` |
| `exec/stream.ts` (worker.ts에서 분리) | StreamTail, 활동 변환(마스킹·제어문자 제거), Bash 실행 기록 추출 | `extractBashRuns(streamPath): {command, exitCode}[]` |
| `exec/worker.ts` | argv(역할별 §6), launch(샌드박스·env·detached), 프로세스 확인·그룹 kill, 고아 탐지 | `findOrphan(sessionId): Promise<number \| null>` |
| `exec/integration.ts` (새) | §12 통합 worktree 생성·병합·검사 | `integrate(o): {kind:'ok', sha, checks} \| {kind:'conflict', files} \| {kind:'failed', checks}` |
| `exec/merge.ts` (새) | §12 사용자 checkout에 `--ff-only` | `applyMerge(o): {kind:'merged', sha} \| {kind:'stale', why} \| {kind:'detached'}` |
| `exec/runner.ts` | 틱·상태 전이의 유일한 주체 | 아래 §C·§D |
| `exec/reconcile.ts` (새) | 시작 시 복구(§7 포함) + 1분 주기 불변식 검사(§5) | `recover(d)`, `reconcile(d): Violation[]` |
| `exec/decisions.ts` (새) | DecisionItem 목록·headline·WorkerView·TaskView·QuotaView | `decisionItems(store)`, `buildHeadline(...)`, `workerViews(...)`, `taskView(...)` |
| `exec/revise.ts` (새) | §10a CEO 수정 턴 실행·자동 적용 판정 | `runReviseTurn(input)`, `canAutoApply(orig, rev)` |

`RunnerDeps = { store, bus, cfg, projects, hqRoot, hqPort, notify, now: () => number }`.

## C. 전이표 (runner)
틱(2초, 겹침 금지) 순서:
1. 살아 있는 시도 추적
2. 검증 진행
3. 통합 진행
4. 배정
5. 요청 완료 판정
6. 수정 턴 1건
7. 변경 이벤트 발행

reconcile은 1분마다 실행한다.

작업 시도 판정(§8) → 전이:
| 판정 | attempt | task | 요청·부작용 |
| --- | --- | --- | --- |
| succeeded(implement) | succeeded | head_sha 기록, verifying | 그룹 kill |
| succeeded(collect) | succeeded | 보고서 봉인 → passed | 후행 무효화 없음 |
| brief_blocked | brief_blocked | revising | 수정 턴 큐 |
| question | question | question (task_questions 삽입, revision 태그) | 알림(결정 id+revision) |
| limited | limited | held, limited_streak+1 (3 → blocked) | resume_session = 이 세션 |
| transient | transient | pending (연속 2 → failed 처리) | |
| failed · runaway · max_turns | 해당 | rework(사유) | |
| unverifiable | unverifiable | blocked | 요청 blocked |
| start_failed | start_failed | pending (연속 3 → blocked) | |

검토 판정(§10) → pass: `passed`(+후행 배정 가능) / blocking: `rework` / invalid: 1회차면 `reviewing`(재검토), 2회차면 `blocked` / limited: `reviewing` / runaway: invalid와 같다.

`rework(task, reason)`
- `attempts ≥ maxAttempts` → `blocked`("N번 실패").
- 그 외 → `rework`. 모델: 다음 시도가 3번째 이상이면 `ladderUp`.
- 사유 원문은 note에 둔다(2000자).
- 이 작업이 전에 `passed`였다면(반려) 후행 무효화(§11).

**시도 카운트**
- 새 work 시도를 시작할 때 +1.
- 세지 않는 경우: resume 시작, 직전이 `limited | transient | start_failed | brief_blocked`였던 재시작.

**배정**
- 용량 = `(hold ? 0 : save·미관측 ? 1 : maxWorkers) − 살아 있는 작업·검토 수`. CEO 턴은 별도 1자리.
- 후보 순서: 요청 created_at → 계획 순. `reviewing`이면서 살아 있는 검토가 없는 작업이 먼저, 그 다음 `pending | rework | held`(held는 hold가 풀렸을 때)이면서 의존 모두 passed이고 요청이 `executing`인 작업.
- 시작 전 준비
  - worktree 준비 → 필요하면 setup(샌드박스, 시도 아님, 실패 → blocked + 사유)
  - 기준선 확보(§9)
  - 더러운 worktree 정리(§7.6)

## D. runner 공개 메서드 (모두 한 트랜잭션 + 상태·revision 검사, 틀리면 409 사유 반환)
| 메서드 | 규칙 |
| --- | --- |
| `createTasks(reqId)` | 프로젝트 git 확인, 요청 base 기록, task 행 생성(review_model = task.review.model ?? 등급 기본), 요청 `executing`. 실패 시 사유 반환 |
| `answerTask(taskId, questionId, answer, revision)` | 질문이 그 task·현재 revision 소유이고 미답일 때만. 모두 답하면 task `pending`(resume) |
| `decideTask(taskId, decision, revision)` | `blocked`일 때만. retry: 최상위 모델, attempts = maxAttempts−1, rework. skip: 이 작업과 전이적 후행을 cancelled. stop: cancelRequest. 남은 blocked 작업이 없으면 요청 executing |
| `rejectResult(reqId, reason, keys?)` | `awaiting_acceptance`에서만. accept 카드 superseded. 지정(없으면 통과 전부) 작업 rework + 후행 무효화. 요청 executing |
| `cancelRequest(reqId)` | 살아 있는 시도 그룹 kill, 비종결 작업 cancelled, 요청 카드 전부 superseded, worktree 제거(브랜치 유지), 요청 cancelled |
| `accept(reqId)` | 요청 `accepted`. 코드 작업이 있는 프로젝트마다 merge 카드. collect만 있으면 `accepted` 종결 |
| `merge(reqId, project)` | `applyMerge`. merged → merges 테이블 기록, 모두 끝나면 요청 `merged`와 정리. stale → 통합부터 다시(요청 `executing` 아님: 요청 `accepted` 유지, 통합 재실행 후 새 merge 카드). detached → 카드 대신 요청 note와 알림 |
| `reofferMerge(reqId)` | `accepted`이면서 미병합 프로젝트 → 통합 재확인 후 카드 재발급 |
| `integrationDecided(reqId, project, decision)` | 다시 통합 / 요청 중단 |
| `applyRevision(taskId, revised)` | spec 교체, revision+1, rework(attempts 유지), resume 비움, 후행 무효화 |

**승인 카드 라우팅** (server가 결정 성공 후 호출)
| 접두어 | 결정 | 처리 |
| --- | --- | --- |
| `plan:` | | 엔진 → createTasks |
| `accept:` | 수락 | accept |
| `accept:` | 반려 | rejectResult(사유 없음) |
| `merge:` | 병합 | merge |
| `merge:` | 보류 | 카드만 닫음 |
| `revise:` | 승인 | applyRevision |
| `revise:` | 반려 | blocked |
| `integration:` | | integrationDecided |
| `team:` | | 기존 팀 처리 |

카드 생성은 `putApproval`(같은 id면 이전 행 superseded 후 새 revision).

## E. CEO 쪽
- 스키마 v2(§3)
  - roles `collect|implement`.
  - `review: {brief, model: sonnet|opus|none}` 선택.
  - `external`, `model: none` 제거.
- `validate()` v2(§3): 순환·자기 의존, owns 겹침 규칙, model none 거부.
- 계획 카드 본문: check 원문, setup, 검토 모델.
- CEO 턴을 stream-json으로 실행해 quota를 관측한다. CEO 턴 한도 감지는 구조화 신호만(§8.1).
- CEO 질문 답변: 그 요청 소유 질문일 때만.
- 수정 턴(§10a)은 CEO 턴과 같은 직렬 잠금을 쓴다.

## F. main.ts·server.ts
- DB 이전(§4 VACUUM INTO).
- `HQ_TOKEN_FILE`, `HQ_PORT`.
- 시작 순서: recover → runner → 엔진 → 서버.
- 데몬 단일 인스턴스: `$HQ_HOME/daemon.lock` 내용은 **pid 정수 한 줄**(개행 포함, 다른 내용 없음). 시작 시 그 pid가 살아 있고 명령줄에 `src/main.ts`가 있으면 종료, 아니면 덮어쓴다. 종료 시 자기 pid일 때만 지운다.
- SIGTERM이면 runner.stop만 한다. 작업자 프로세스는 살려 둔다.
- API 전체(§15)
  - 경로 id는 한 번만 decode한다.
  - 증거 파일은 DB에서 시도 dir을 찾아 이름 허용 목록으로만 연다(입력으로 경로를 조합하지 않음).
  - Snapshot에 `decisions`를 넣는다.
- `POST /api/approvals`(팀): `team:<teamId>:` 접두어만 허용. 예약 접두어는 거부.

## G. 테스트 케이스 (작업자가 코드로 작성. 가짜 claude + 임시 git repo + 가짜 시계)
각 항목의 기대 결과를 단언한다. 샌드박스 테스트는 실제 `sandbox-exec`를 사용한다.
1. 샌드박스
   - 토큰 파일 읽기, hq 포트 접속, 허용 밖 쓰기, 다른 worktree 쓰기, `$HQ_HOME/hq.db` 읽기 → 모두 실패.
   - 자기 worktree에서 커밋, 자기 out 쓰기 → 성공.
   - env에 `HQ_TOKEN`이 없다.
2. 판정: done 없음·토큰 불일치·symlink done·과대 파일 → unverifiable. 나머지:
   | 입력 | 기대 |
   | --- | --- |
   | blocked | brief_blocked |
   | failed | failed |
   | question(질문 없음) | failed |
   | question(질문 있음) | question |
   | max_turns | failed |
   | 429 | limited |
   | 529·5xx | transient |
   | "rate limit" 문장이 든 정상 결과 | succeeded |
   | head 불일치 | failed |
   | files 누락·초과 | failed |
   | owns 밖 | failed |
   | rename 옛 경로가 owns 밖 | failed |
   | dirty | failed |
   | merge 커밋 포함 | failed |
   | 요약 199자 | failed |
   | 요약 200자 | succeeded |
   | 보호 경로 변경(owns 안) | succeeded + 목록 기록 |
3. 검사: 통과·실패·타임아웃(자식까지 종료), 검사가 파일을 수정 → 실패, 기준선 실패 check는 판정 제외, 중간 커밋에 넣었다 지운 `sk-ant-` → 비밀 탐지(값 미기록).
4. verdict:
   | 입력 | 기대 |
   | --- | --- |
   | criteria id 누락·추가·중복 | 무효 |
   | tests_run 명령이 stream Bash 기록에 없음 | 무효 |
   | tests_run 종료 코드 불일치 | 무효 |
   | pass + blocking | 무효 |
   | fail + blocking 없음 | 무효 |
   | 정상 pass | pass |
   | 정상 blocking | blocking |
5. 사다리: 매번 검사 실패 → sonnet → sonnet → opus → blocked, 알림 1회.
6. 전체 성공
   - 흐름: 계획 승인 → 작업 → 검사 → 검토 pass → 통합 → accept 카드 → 수락 → merge 카드 → `--ff-only` 병합.
   - 기대: 대상 repo HEAD = integration_sha, worktree 정리, 요청 merged.
7. 다중 의존: A, B → C(같은 프로젝트) → C의 base가 A·B head 병합 커밋이다. C의 owns 검사에 A·B 파일이 섞이지 않는다.
8. 무효화: C가 passed인 뒤 A를 반려로 재작업 → C가 pending이고 attempts 0, 옛 브랜치는 `-v1`로 보관.
9. question: 질문 2개 → 1개 답 → 여전히 question → 옛 revision으로 답하면 409 → 2개째 답 → `--resume <같은 세션>`(가짜가 받은 argv로 확인), 시도 수 불변.
10. brief_blocked → 수정 턴: owns 같음 → 자동 적용·revision 1. owns 넓어짐 → revise 카드. 3번째 blocked → blocked.
11. 한도: `rejected` 이벤트 → held, 새 시작 0, hold 해제 시각 = 가장 늦은 차단 창 resetsAt. 가짜 시계로 이후 → `--resume` 재시작, 시도 수 불변. limited 3연속 → blocked.
12. 폭주: wall 초과 → 그룹 SIGTERM → runaway → rework. 같은 오류 3연속 → runaway.
13. 복구
    - starting 행 + pid 없음 + 같은 세션 id로 떠 있는 가짜 프로세스 → 채택(중복 실행 0).
    - starting 행 + 고아 없음 → start_failed.
    - 죽은 pid + 정상 done → succeeded.
    - thinking 요청 → queued.
    - verifying(checks running) → 재실행.
14. 병합 stale: 카드 뒤 대상에 커밋 추가 → 병합 안 됨, 통합 재실행, 새 카드. dirty·detached도 같다.
15. 통합 충돌: A와 B가 같은 줄을 바꿈(owns 겹침 검사를 피하려고 다른 요청으로 순차 수락된 경우 시뮬레이션) → integration 카드, 요청 blocked.
16. 불변식: 카드 없는 blocked 요청·살아 있는 프로세스 없는 running 작업을 인위로 만들면 reconcile이 위반으로 보고하고 요청 blocked.
17. API
    - 인코딩된 id로 answer·decide.
    - 다른 요청의 questionId로 CEO 답변 → 409.
    - 팀이 `plan:x` 카드 생성 → 400.
    - 증거 파일 허용 목록 밖 → 404.
    - 오래된 revision → 409.
18. headline·decisions: 종류별 순서, needsYou, 문장 규칙(§18) 각 경우.
19. DB 이전: WAL에만 있는 커밋 행이 새 DB에 있다(VACUUM INTO). 두 번째 시작에서는 다시 복사하지 않는다.

실행: `npx tsc --noEmit`, `node --test test/unit/`. 가짜 claude: `test/unit/fixtures/fake-claude.ts`. 프롬프트의 `[[FAKE:...]]` 마커나 argv(`--json-schema` 유무, `--resume`)로 동작을 고른다.

---

## v3 변경 지시 (execution.md v3 §21 반영)
v2 구현(현재 main 통합본) 위에서 아래를 바꾼다. 판단은 여기까지, 구현은 작업자. 다르거나 불가능하면 멈추고 보고.

### V1. 저장소 격리 (§6.1) — `git.ts`, `worker.ts`, `runner.ts`, `integration.ts`, `merge.ts`, `sandbox.ts`
- 새 모듈 `exec/repos.ts`
  - `ensureMirror(project): Promise<mirrorPath>`: 없으면 `git clone --bare --no-local <project> <mirror>`, 있으면 프로젝트에서 `fetch`(모든 브랜치·태그).
  - `hqGit(gitDir, workTree?, args)`: hq의 모든 git 호출 진입점. §6.1의 `-c`·환경 옵션을 항상 붙인다. 기존 `git()` 호출을 전부 이것으로 옮긴다.
  - `newWorkClone(mirror, path, baseSha)`: `git clone --shared --no-checkout <mirror> <path>` → 복제본에서 `checkout -b hq-work <baseSha>`. 이 한 번만 hq가 복제본 안에서 git을 실행한다. 생성 직후라 아직 작업자가 건드리지 않았다.
  - `fetchWork(mirror, clonePath, attemptId, ref)`: 미러에서 `fetch <clone> +refs/heads/hq-work:<ref>`. 반환은 ref의 SHA.
  - `verifyWorktree(mirror, path, sha)`: 미러에서 `worktree add --detach`.
- 작업 시도 종료 후 판정(§8.8)의 git 사실은 모두 **fetch한 미러 ref 기준**으로 계산한다(`files_modified` = `diff --name-only base..<fetched>`, 작업 트리 깨끗함은 복제본에서 git을 돌리지 않고 확인할 수 없으므로 **요구 사항에서 뺀다**: 커밋되지 않은 변경은 fetch되지 않으므로 결과에 포함되지 않을 뿐이다. 대신 report에 "미커밋 변경 없음"을 쓰도록 프롬프트에 둔다).
- 검증(§9)·검토(§10)·통합(§12)은 `verifyWorktree`로 만든 worktree에서. 샌드박스 프로필: 그 worktree 쓰기 허용, 미러는 읽기만.
- 병합: `git -C <project> fetch <mirror> <integration_sha>` 후 `merge --ff-only`(사용자 hook은 그대로).
- 기존 테스트의 git worktree 기반 fixture는 새 구조로 옮긴다. 테스트 추가(샌드박스 실제 실행):
  - 작업자 복제본에서 `.git/hooks/post-merge`, `core.fsmonitor`, `.git` 파일 바꿔치기, `git replace`를 시도한 뒤 hq의 fetch·검증·통합·병합 전체 흐름을 실행한다. 표식 파일이 생기지 않고, replace가 결과에 영향이 없어야 한다.
  - 검사 명령이 `git update-index --assume-unchanged`를 시도하면 실패한다(미러 index 쓰기 거부). 소스 변경은 전후 비교로 잡힌다.

### V2. 샌드박스 프로필 (§6.2)
- 보호 경로는 `file-read-data`·`file-write*`만 거부하고 `file-read-metadata`는 허용한다(조상 폴더 lstat). 실사용 회귀 테스트로 추가: `$HQ_HOME` 아래 검증 worktree에서 `node -e "import('./x.js')"`와 `npm test`가 성공해야 한다.
- 읽기 거부 추가: `~/.ssh ~/.aws ~/.config/gh ~/.netrc ~/.docker/config.json ~/Library/Keychains`, 다른 프로젝트의 `.env*`, 토큰 파일 폴더(`HQ_TOKEN_FILE` 반영).
- `~/.claude`: 쓰기는 런타임 하위 폴더만. 실측으로 최소 집합을 정한다. 방법: 쓰기 거부 상태에서 `claude -p --model haiku` 한 줄 응답을 실행하고, 실패하거나 경고하는 경로만 추가한다. 최종 집합과 근거를 보고한다. `settings*.json`, `CLAUDE.md`, `skills|agents|commands|plugins|hooks/`는 반드시 거부. `~/.claude.json*`은 허용(한계).
- 실행 거부: `/usr/bin/open`, `/usr/bin/osascript`, `/bin/launchctl`, appleevent-send.

### V3. 판정·검증 규칙
- 기준선 면제 삭제(§9). acceptance `kind` 처리: `new`는 반드시 통과. base에서도 통과하면 경고를 기록한다. `regression`이 base에서 실패하면 그 항목을 `manual`로 바꿔 검토자에게 넘기고 "기존 실패"로 표시한다. 캐시 키는 `sha256(setup+check)`.
- CEO 스키마(`ceo.ts`)
  - acceptance에 `kind` 필수.
  - `validate()`가 check의 `&&`, `||`, `|`, `;`, 백틱, `$(`, 줄바꿈을 거부한다(`manual` 제외).
- verdict(§10)
  - tests_run은 **정확 일치**만 인정한다. 공백 정규화 후 같은 명령이어야 하고, 부분 일치는 삭제한다.
  - 종료 코드는 `is_error=false`면 0, `Exit code N` 접두어면 N, 그 외는 알 수 없음으로 보고 무효 처리한다.
  - `|`, `||`, `;`, `true`로 끝나는 명령은 근거로 인정하지 않는다.
  - `pass=true`면 모든 exit_code가 0이어야 한다.
  - 판정 직전에 Bash 실행 기록을 DB(`bash_runs` 테이블 또는 attempt JSON 컬럼)에 저장한다.
- 검토 프롬프트에 "테스트 명령은 하나씩, 이어 붙이지 말고, 실행한 문자열 그대로 tests_run에 적을 것"을 추가한다.
- 형식 실수 자동 재시도 1회(§8.4).
- L0 검토 none + 보호 경로 변경 → review_model sonnet.
- collect L2 이상 → 검토한다.

### V4. 수명·세대·결정 원자성
- 시도 번호 n은 종류별 순번(`max+1`)이다. resume 프롬프트 첫 줄에 "이전 지시의 out 경로와 attempt_token은 폐기됨. 새 경로: …, 새 토큰: …"를 넣는다.
- tasks `generation`(§7.7): 무효화·취소·수정 적용 시 증가시키고, 살아 있는 시도 종료를 확인한다. 모든 판정·전이 SQL은 `where generation = ?` 조건부로 쓴다.
- 고아 없음 + pid 없음 → `blocked`("시작 여부 불명확"). `start_failed` 자동 재시작을 폐지한다.
- 검사·통합 프로세스도 pid를 기록하고, 복구 때 남은 그룹을 종료한다.
- 병합 intent에 기대 결과 SHA를 둔다. 복구 시 `HEAD == integration_sha`면 merged, `HEAD == target_sha`면 카드를 재제시하고, 그 밖은 stale로 처리한다.
- `daemon.lock`은 `O_EXCL` 생성 + stale 판정(§7.8).
- **결정 원자성**: `POST /api/approvals/:id`는 server에서 바로 decide하지 않는다. `runner.decide(id, decision, subjectHash)`가 한 트랜잭션에서 카드 소비와 상태 전이를 함께 처리한다. 같은 결정을 재전송하면 같은 응답을 준다.
- accept 카드의 `반려` 결정은 409("사유와 함께 반려 버튼을 써 주세요")로 거부한다.
- `/reject`에는 `reason`(비어 있으면 400)과 `subjectHash`가 필요하다. plan `반려`는 요청을 `rejected`로 바꾼다.
- blocked 결정의 revision = task별 `block_count`(막힐 때마다 +1). DecisionItem.revision이 이 값이다.
- 수정 턴 자동 적용은 brief·title 변경일 때만 한다. 적용 전에 전체 `validate()`를 실행한다.
- 무효화 대상에 collect 보고서 해시 변경을 포함한다.

### V5. 한도·슬롯 (§13)
- `overageStatus` 무시. rejected 판정은 최상위 `rate_limit_info.status` + `rateLimitType`로 한다. resetsAt 없는 rejected·429 → 15·30·60분 지수 대기(kv 타이머).
- "Not logged in" 결과 → 전역 hold + DecisionItem kind `blocked` 대신 새 종류? → **types 변경 없이** 요청 무관 카드로 approval `system:login`(옵션 `다시 확인`)을 만든다. 결정하면 hold를 풀고 다음 시작에서 재확인한다.
- 슬롯: normal은 `maxWorkers`(작업·검토) + CEO 1. save·관측 없음은 전체 1이고 CEO 턴이 우선한다(배정 전에 CEO 대기 큐 확인).
- 검토 limited 연속 3 → blocked. 작업 누적 시간은 3×wall 상한. hq가 kill했으면 runaway가 우선한다.
- 사람 retry는 **같은 모델**, attempts = maxAttempts−1, rework.

### V6. 기존 요청 호환
DB에 v2 형식으로 남은 task·attempt는 마이그레이션으로 generation 0, block_count 0을 채운다. 진행 중인 v2 요청은 재시작 복구에서 `blocked` + "v3 전환: 다시 시작하려면 한 번 더"로 둔다.

### 테스트 추가 (V1~V5 각각 최소 1개, 실제 sandbox-exec·임시 repo·가짜 claude)
1. 탈출 시도 4종 무효
2. 메타데이터 lstat 성공
3. `~/.claude` 보호 파일 쓰기 거부(가짜 HOME으로)
4. new 기준 미구현 → fail
5. regression 기존 실패 → manual
6. tests_run 부분 일치 → 무효, 파이프 → 무효, exit 1 + pass → 무효
7. check `&&` → validate 오류
8. 형식 실수 → 자동 재시도 1회 → 두 번째는 blocked
9. generation: 무효화 중 늦게 끝난 시도 결과가 반영되지 않음
10. pid 없음·고아 없음 → blocked
11. 승인 결정 재전송 → 같은 응답, 전이 1번
12. accept 반려 결정 → 409
13. overageStatus rejected + status allowed → 정상
14. resetsAt 없는 rejected → 15분 대기
15. Not logged in → system:login 카드
16. save 모드에서 CEO 우선
17. 병합 복구 3가지
