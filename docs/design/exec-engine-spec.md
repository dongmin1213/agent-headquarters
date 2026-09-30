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
- 데몬 단일 인스턴스: `$HQ_HOME/daemon.lock`에 flock. 흉내라도 좋다: 파일에 pid를 적고, 살아 있으면 종료.
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
