# 실행 엔진 구현 지시서

작성: 오케스트레이터. 대상: 실행 엔진 구현 작업자. 상위 계약: `execution.md`(이하 §). 이 문서는 **판단**(구조·인터페이스·동작 규칙·테스트 케이스)만 담는다. 코드는 작업자가 쓴다. 지시와 코드 현실이 다르거나 모호하면 스스로 설계하지 말고 멈추고 보고한다.

## A. 기존 WIP 모듈: 유지 + 수정 지시
유지: `src/exec/fsx.ts`, `git.ts`, `contract.ts`, `quota.ts`, `worker.ts`, `checks.ts`, `review.ts`, `prompt.ts`, `src/store.ts`의 tasks/attempts/quota 추가분.
수정:
1. `contract.ts`
   - `WorkOutcome`에 `'brief_blocked'` 추가.
   - done.outcome `blocked` → `brief_blocked`(reason = summary). `failed`만 `failed`.
2. `git.ts`
   - `removeWorktree(repo, path, { force })`: `force`일 때만 `--force`와 `rm -rf` 대체를 쓴다.
   - force 없이 실패하면 예외 없이 `false`를 돌려준다. 성공은 `true`.
   - 검토 worktree는 force로, 병합 후 작업 worktree는 force 없이 지운다.
3. `worker.ts`
   - collect 역할의 `Write(<dir>/**)` 규칙이 실제로 동작하는지 먼저 확인한다: 절대 경로 규칙 문법은 `Write(//abs/path/**)`일 수 있다.
   - 확인 방법: 실제 `claude`로 한 번 호출한다. `--model haiku`, 임시 폴더 cwd, 다른 폴더에 파일을 쓰라고 지시한다.
   - 결과(허용/거부)를 보고서에 적고, 동작하는 문법을 쓴다.
4. `prompt.ts`의 작업자 규칙
   - 맨 앞에 규칙 0을 추가한다: "지시서대로만 구현, 설계를 새로 하지 않음. 지시서가 현실과 다르거나 모호하면 outcome blocked + report.md에 어느 지시가 무엇과 어떻게 다른지 증거(파일:줄, 명령 출력)." (execution.md §5 규칙 0과 같은 뜻)
   - 기존 규칙 7은 규칙 0과 중복이므로 제거한다.
5. `store.ts` 추가 컬럼(추가형 마이그레이션)
   - 방법: `pragma table_info`로 존재를 확인한 뒤 `alter table add column`. 이 방식을 helper로 둔다.
   - 대상 컬럼:
     - `tasks.revisions integer not null default 0`
     - `tasks.review_model text`
     - `tasks.resume_session text`
     - `tasks.checks_state text`: null | `running` | `passed` | `failed`
     - `request_questions.task_id text`

## B. 모듈 경계 (새 파일)
| 파일 | 책임 | 공개 인터페이스 |
| --- | --- | --- |
| `src/exec/runner.ts` | 틱마다 상태 전이·배정. 유일한 상태 변경 주체(엔진·API는 runner 메서드를 부른다) | `class Runner { constructor(d: RunnerDeps); start(): void; stop(): void; tick(): Promise<void>; createTasks(requestId): Promise<string\|null>; answerTask(taskId, index, answer): boolean; decideTask(taskId, decision): boolean; rejectResult(requestId, reason): boolean; cancelRequest(requestId): boolean; accept(requestId): void; merge(requestId, project): Promise<void>; reofferMerge(requestId): boolean; applyRevision(taskId, revised): void }` |
| `src/exec/merge.ts` | §11 병합 한 프로젝트 | `mergeProject(o): Promise<MergeResult>`, `mergeSubject(o): Promise<{hash, body, target}>` |
| `src/exec/recovery.ts` | §12 시작 시 복구 | `recover(d: RunnerDeps): Promise<RecoveryReport>` |
| `src/exec/decisions.ts` | 회장 결정 항목 목록·headline·workers·quota 뷰(순수 함수 + store 조회) | `decisionItems(store): DecisionItem[]`, `buildHeadline(items, workers, quota): Headline`, `workerViews(store, cfg): WorkerView[]`, `taskView(store, row): TaskView` |
| `src/exec/revise.ts` | §9a CEO 지시서 수정 턴 실행과 적용 판정 | `runReviseTurn(input): Promise<ReviseTurn>`, `canAutoApply(original: PlanTask, revised: PlanTask): boolean` |

`RunnerDeps = { store, bus, cfg: HqConfig, projects: Project[], hqRoot: string, notify(title, body): void, now?: () => number }`.
모든 시간은 `deps.now()`로 받는다(테스트에서 가짜 시계).

## C. 상태 전이 규칙 (runner)
**틱 순서** (`tick()`은 겹쳐 실행되지 않는다. 진행 중이면 즉시 반환):
1. 살아 있는 시도 추적
2. 검증 진행
3. 배정
4. 요청 완료 판정
5. 지시서 수정 턴 큐 처리(D절)
6. 스냅샷 변경 이벤트 발행

한 틱 간격은 2초다.

**1. 살아 있는 시도** (`status in (starting, running)`)
- 처리
  - `StreamTail.poll`로 활동을 수집한다.
  - `rate_limit_event`는 `quotaFromEvent` → `store.setQuota`에 반영한다.
  - 활동 이벤트 `attempt`는 시도당 2초에 최대 1번 발행한다.
- 폭주
  - 판정 조건: 경과(`started_at`부터) > `attemptWallMinutes[task.grade]`, 또는 `sameErrorCount ≥ 3`.
  - 처리: attempt.reason에 `runaway:<사유>`를 기록 → 프로세스 그룹 SIGTERM → 10초 뒤에도 살아 있으면 SIGKILL.
- 종료 판정: `sameProcessAlive`가 false면 `finalize(attempt)`.

**finalize(work)**: `judgeWork` 결과에 따라 처리한다(시도 카운트는 E절).
| 결과 | attempt.status | task | 요청·기타 |
| --- | --- | --- | --- |
| succeeded (implement) | succeeded | `head_sha` 기록, `verifying`, `checks_state=null` | |
| succeeded (collect) | succeeded | report 요약 검사 통과 → `passed`, 실패 → `rework` | |
| brief_blocked | brief_blocked | `revising`, note = 작업자 요약 | 수정 턴 큐에 넣음 |
| question | question | `question`, `resume_session` = 이 시도 session_id | 알림 1회 |
| limited | limited | `held` | 한도 관측 없으면 `limit.blockedUntil = now+60분` |
| failed / runaway | 해당 값 | `rework(task, 사유)` | |
| unverifiable | unverifiable | `blocked` | 요청 `blocked`, 알림 |
| start_failed | start_failed | `pending` | 연속 3번이면 `blocked` |

**finalize(review)**
- 실행 결과 처리
  - `result.structured_output`에 `checkVerdict(raw, codeChanged)`를 적용한다.
  - `codeChanged`는 base..head 변경 파일이 1개 이상인지다.
  - verdict.json에 hq가 채우는 필드: task, head_sha, base_sha, reviewer_model, implementer_model, sameFamily=true.
  - 검토 worktree는 force로 제거한다.
| 결과 | 처리 |
| --- | --- |
| pass | task `passed` |
| blocking | `rework(task, blocking 목록)` |
| invalid | 같은 head_sha에서 직전 검토도 invalid였으면 task `blocked`, 아니면 task `reviewing`(재검토 대기) |
| limited | task `reviewing` (시도 수 없음) |
| runaway, 결과 없음 | invalid와 같다 |

**2. 검증** (`status = verifying`)
- 조건: `checks_state`가 null. 동시에 하나만 실행한다.
- 실행: `checks_state=running` → `runChecks` → `checks.json`을 해당 work 시도 폴더에 쓴다.
- 통과
  - `checks_state=passed`.
  - L0이고 review_model이 `none`이면 → `passed`.
  - 그 외 → `reviewing`.
- 실패: `checks_state=failed` → `rework(task, 실패 항목)`.
- 실행 중 hq가 재시작되면 `running`을 null로 되돌리고 처음부터 다시 실행한다(D절 복구).

**3. 배정**
- 한도 모드는 `quotaState`로 정한다.
  | 모드 | 배정 |
  | --- | --- |
  | hold | 전부 중지 |
  | review_only | 검토 시작만 |
  | save | 용량 1 |
  | 그 외 | 용량 = `maxWorkers - 살아 있는 시도 수` |
- 후보 순서: 요청 `created_at` 순 → 계획 순.
  1. `reviewing`이면서 살아 있는 검토 시도가 없는 작업 → 검토 시작
  2. `pending | rework | held`이면서 의존이 모두 `passed`, 요청이 `executing` → 작업 시작
- 요청이 `blocked | cancelled`면 그 요청의 새 시작은 없다.
- 작업 시작
  - worktree: `ensureWorktree(repo, home/worktrees/<req>/<key>, hq/<req>/<key>, base)`.
  - base: 첫 시도 때 확정해 `task.base_sha`에 저장한다. 같은 프로젝트의 의존 작업이 있으면 마지막 의존 작업의 `head_sha`, 없으면 승인 시점에 기록한 프로젝트 HEAD.
  - 모델: `task.model`.
  - `resume_session`이 있으면 `--resume <그 세션>`으로 띄운다. 프롬프트는 "회장 답변 목록 + 이어서 진행 + 새 attempt_token의 완료 계약"이다.
  - 시도 id: `<taskId>#a<n>`. n은 그 작업의 work 시도 행 수 + 1.
- 검토 시작
  - worktree: `addDetachedWorktree(repo, home/worktrees/<req>/<key>.review-r<n>, head_sha)`.
  - 모델: `task.review_model`.
  - 시도 id: `<taskId>#r<n>`.

**4. 요청 완료**
- 대상: 요청 `executing`이면서 모든 작업이 `passed` 또는 `cancelled`.
- `passed`가 0개면 요청 `failed`("모든 작업이 취소됨").
- 아니면 요청 `awaiting_acceptance`, 수락 카드를 만든다.
  - 카드: `accept:<req>`, 옵션 `수락`/`반려`, 72시간 만료.
  - subjectHash: 통과한 작업의 `head_sha`를 정렬한 목록의 sha256.
  - 본문: 작업당 한 줄 `[키] 제목 · 변경 N파일 · 검사 k/k · 검토 pass(모델)`.

## D. 결정·외부 입력 (runner 메서드, 모두 한 트랜잭션)
| 메서드 | 규칙 |
| --- | --- |
| `createTasks(req)` (계획 승인 시) | 프로젝트마다 `isRepo`가 아니면 요청 `failed`, 사유 "<id>는 git 저장소가 아님"을 반환(엔진이 표시). 프로젝트 HEAD를 요청 단위로 기록(`kv: base:<req>:<project>`). role `verify` 작업은 행을 만들지 않는다. depends_on 각 대상의 `review_brief`에 지시서와 수용 기준을 덧붙이고, verify.model이 `none`이 아니면 그 모델을 대상의 `review_model`로 둔다. 나머지 작업의 review_model 기본값은 `reviewerModel(ladder, model)`, L0이면서 verify가 없으면 `none`. 요청 `executing`. |
| `answerTask(id, i, ans)` | task가 `question`이고 i가 범위 안일 때만 true. 마지막 work 시도 폴더 `answers.json`에 기록한다. 모두 답하면 task `pending`(resume_session 유지 → 배정에서 resume). |
| `decideTask(id, d)` | task `blocked`일 때만. `retry`: model=ladder 최상위, attempts=maxAttempts-1, `rework`. `skip`: 이 작업과 그 작업에 (전이적으로) 의존하는 작업을 `cancelled`. `stop`: `cancelRequest`. 결정 뒤 요청에 `blocked` 작업이 남지 않으면 요청을 `executing`으로. |
| `rejectResult(req, reason)` | 요청 `awaiting_acceptance`일 때만. accept 카드를 닫는다(`closeApproval`). 통과한 작업 전부 `rework(task, "회장 반려: "+reason)`. 요청 `executing`. |
| `cancelRequest(req)` | 살아 있는 시도에 SIGTERM, 최종이 아닌 작업을 `cancelled`, 요청의 열린 카드(plan/accept/merge/revise)를 닫고 요청 `cancelled`. worktree는 남긴다(검사용). |
| `accept(req)` (accept 카드 `수락`) | 요청 `accepted` → 프로젝트마다 `mergeSubject`로 merge 카드 생성(`merge:<req>:<project>`, 옵션 `병합`/`보류`, 72시간 만료). |
| `merge(req, project)` (카드 `병합`) | 요청 `merging` → `mergeProject`. 결과별 처리는 E절 병합. |
| `reofferMerge(req)` | 요청이 `accepted`이면서 아직 병합되지 않은 프로젝트의 카드를 새 해시로 다시 만든다(보류·충돌 뒤 사용). |
| `applyRevision(id, revised)` | 원 task spec을 교체, `revisions+1`, status `rework`(attempts 유지, resume_session 비움). |

`rework(task, reason)` 규칙
- `task.attempts ≥ maxAttempts` → `blocked`, 요청 `blocked`, note "N번 실패: <사유 한 줄>", 알림.
- 그 외 → `rework`. 다음 모델은 attempts가 1이면 그대로, 2 이상이면 `ladderUp`.
- 사유 원문(수용 기준 실패 id·명령·종료 코드·출력 끝 30줄 / blocking 목록 / 판정 사유 / 반려 사유)을 다음 프롬프트의 재작업 절에 넣도록 task.note에 저장한다(2000자 제한).

**시도 카운트**: 새 work 시도를 시작할 때 `task.attempts += 1`. 단, resume 시작과 직전 시도가 `limited | start_failed | brief_blocked`였던 재시작은 세지 않는다.

**지시서 수정 턴 큐** (tick 5단계, CEO 턴과 같은 직렬 잠금 사용)
- 대상: task가 `revising`이면서 그 task의 미답 질문이 없는 것. 한 틱에 하나만 처리한다.
- `revisions ≥ 2` → `blocked`.
- `runReviseTurn` 결과별 처리
  - `revised_task` + `canAutoApply` → `applyRevision`
  - `revised_task`, 자동 적용 불가 → 카드 `revise:<taskId>`(옵션 `승인`/`반려`, subjectHash = 수정안 JSON sha256)
    - 승인 → `applyRevision`
    - 반려 → `blocked`
  - questions → request_questions에 task_id를 붙여 저장, 알림. 답이 모두 오면 다시 큐 대상.
  - 실패·한도 → task `revising` 유지, 한도면 보류.

`canAutoApply(orig, rev)`: id·project·role이 같고, rev.owns의 모든 항목이 orig.owns에 문자열로 존재하고, acceptance의 check 명령 집합이 같다.

## E. 병합 (merge.ts)
`mergeSubject({repo, heads: {key, branch, head}[]})` → target = 현재 브랜치(`currentBranch`, 없으면 오류: "분리 HEAD 상태라 병합할 수 없음"), targetSha = HEAD. hash = sha256(JSON.stringify([target, targetSha, heads]))
본문 줄:
- `대상 브랜치 <target> @ <sha7>`
- 작업별 `<branch> @ <head7> · N파일`

`mergeProject({repo, recorded: {target, targetSha}, heads, requestId, intentPath})`
1. 사전 확인 (하나라도 다르면 `{ kind: 'stale', why }`를 반환하고 아무것도 바꾸지 않는다)
   - 현재 브랜치 == target
   - HEAD == targetSha
   - `statusPorcelain`이 비어 있음
2. 의도 기록: intentPath에 `{startedAt, target, targetSha, heads}`를 원자적으로 쓴다.
3. 병합: heads 순서(계획 순)대로 `git merge --no-ff -m "hq: <title> (<req>/<key>)" <branch>`.
4. 충돌이 나면
   - 충돌 파일을 수집한다: `diff --name-only --diff-filter=U`.
   - `merge --abort`를 실행한다.
   - 이미 병합된 앞선 작업은 되돌리지 않는다.
   - `{ kind: 'conflict', files, merged: [...] }`를 반환한다.
5. 성공하면
   - intent에 `finishedAt`과 결과 SHA를 쓴다.
   - `{ kind: 'merged', sha }`를 반환한다.

runner.merge의 결과별 처리
| 결과 | 처리 |
| --- | --- |
| stale | 카드를 새 해시로 다시 만들고 본문 첫 줄에 "대상이 바뀌어 다시 확인이 필요해요: <why>", 알림. 요청 `accepted` |
| conflict | 요청 `accepted`, note에 충돌 파일, 카드를 다시 만들고 본문 첫 줄 "병합 충돌로 취소됨: <files>" |
| merged | 그 프로젝트 완료로 kv에 기록 |

모든 프로젝트가 병합되면 요청 `merged`로 바꾸고, 해당 작업들의 worktree와 브랜치를 정리한다.
- worktree: `removeWorktree` force 없이. 실패하면 note에 남긴다.
- 브랜치: `git branch -d`.

`보류`는 카드만 닫는다(요청 `accepted` 유지).

## F. 복구 (recovery.ts, 데몬 시작 시 runner.start 전에 1번)
시도 복구(`starting | running` 시도)
- `process.json`이 없다 → `start_failed`.
- 같은 프로세스가 살아 있다 → 그대로(다음 틱부터 추적).
- 그 외 → `finalize`.

작업·요청 복구
- 작업 `verifying`이면서 `checks_state = running` → `checks_state = null`(재실행).
- 요청 `thinking` → `queued`. 기존 엔진 버그: 재시작하면 영원히 thinking에 머문다.

병합 복구
- 대상: 요청 `merging`, 또는 intent가 있고 finishedAt이 없는 프로젝트.
- 처리: 모든 head가 target의 조상(`isAncestor`)이면 완료로 기록. 아니면 요청 `blocked`, note "병합 도중 중단됨: 수동 확인 필요".
- 한 번도 시작 안 했으면 요청을 `accepted`로 되돌리고 카드를 다시 만든다.

반환 `RecoveryReport = { adopted, finalized, startFailed, resetChecks, resetThinking, merges }`는 이벤트 1건으로 발행한다.

## G. 결정 목록·headline (decisions.ts)
`DecisionItem = { kind: 'plan'|'ceo_question'|'worker_question'|'revise'|'blocked'|'accept'|'merge', id, requestId, title, detail }`
- 순서: plan → ceo_question → worker_question → revise → blocked → accept → merge. 각 종류 안에서는 오래된 순.
- `needsYou`는 전체 개수다.

`buildHeadline(items, workers, quota)`: execution.md §16 문장 규칙.
- 결정이 있으면 `"회장님 결정 N건: <첫 항목 title>"`.
- 결정이 없으면 한도 hold 문장(`사용 한도 <5시간|7일> <n>% — <HH:mm>까지 쉬어요`).
- 그 다음은 살아 있는 작업자 1순위다. 순위는 work → review → verify, 같은 종류면 오래된 순.
  - 문장: `"<모델>가 <제목> <구현|검토|검증> 중 · 다음: <검증|검토|결과 확인>"`
  - 같은 종류가 더 있으면 `" 외 N명"`을 붙인다.
- 아무것도 없으면 `"지금 하실 일은 없어요"`.

`workerViews`
- 살아 있는 시도 → WorkerView (kind work|review, state running|reviewing, bubble = 활동 로그 마지막 줄, 없으면 "시작 중").
- `verifying` 작업 → kind `verify`, model `hq`, state `verifying`, bubble "수용 기준 검사 중".
- `held` 작업 → state `held`, bubble `"한도 보류 — <HH:mm>까지"`.

`taskView`
- currentAttemptId = 마지막 시도 id
- lastActivity = 그 시도 `activity.jsonl`의 마지막 줄 text (`readTail`)
- questions = status가 `question`일 때 마지막 work 시도 done.json의 questions 중 answers.json에서 답하지 않은 것

## H. CEO 쪽 (ceo.ts / engine.ts)
- `validate()`: implement·collect 작업의 model `none`은 거부("구현·수집 작업은 모델이 필요합니다").
- CEO 턴과 지시서 수정 턴은 `cfg.claudeBin`으로 실행하고, 한도 hold 중에는 시작하지 않는다(`quotaState`).
- CEO 턴 stream이 아닌 json 출력에서는 한도 관측이 없으니, 기존 한도 패턴 감지를 유지한다.
- `runReviseTurn`
  - 도구: CEO 턴과 같다(읽기 전용, `.env` 금지, strict 플래그). cwd = 작업 worktree(현재 코드를 보게).
  - 스키마: `{ revised_task: <CEO 스키마의 task 항목> | null, questions: <CEO 스키마의 questions> }`. 둘 중 정확히 하나.
  - 프롬프트: `skills/ceo.md` + "## 지시서 수정 턴" 절 + 원 task JSON + report.md + diff stat + 답변.
  - 절 내용: 작업자가 blocked로 멈춘 이유를 조사하고, 지시서를 현실에 맞게 고치거나 회장에게 물을 것. id·project·role은 바꾸지 말 것. owns를 넓혀야 하면 그 이유를 brief에 적을 것.
- 엔진의 계획 승인 처리: `planDecided('승인')` → `runner.createTasks`. 실패 사유가 오면 요청 `failed`로 표시.
- 승인 카드 라우팅(server의 POST /api/approvals/:id 성공 후)
  - `plan:` → 엔진
  - `accept:` → 수락이면 `runner.accept`, 반려면 `runner.rejectResult(req, '(사유 없음)')`
  - `merge:<req>:<project>` → 병합이면 `runner.merge`, 보류면 닫기만
  - `revise:<taskId>` → 승인이면 적용, 반려면 blocked
  - 그 외 → 기존 팀 처리

## I. API (server.ts routeApi)
execution.md §14 전부 + `POST /api/requests/:id/merge`(reofferMerge).
- 경로 id는 모두 `decodeURIComponent`. 작업 id에는 `/`, 시도 id에는 `/`·`#`가 들어간다.
- 증거 파일: 허용 목록(report.md, checks.json, verdict.json, done.json, stderr.log, answers.json)만, 1MB 제한. 시도 dir 밖 경로는 거부한다(realpath 비교).
- diff
  - 작업 브랜치 base..head를 `git diff --no-color --no-ext-diff`로 뽑는다(2MB에서 자르고 `truncated: true`).
  - 실행 위치: 프로젝트 repo(브랜치는 공유된다).
  - 응답: `{ files: {path, added, removed}[], diff: string, truncated }`. `files`는 `--numstat`에서 얻는다.
- 활동: `GET /api/attempts/:id/activity?after=n` → `{ lines: Activity[], next: number }`(n은 줄 번호, 최대 500줄).
- 잘못된 상태의 결정은 409와 한국어 사유.
- Snapshot
  - `workers`, `headline`, `quota`(`quotaView`)
  - `RequestView.tasks`(taskView)
  - `limit.blockedUntil`: 한도 hold면 그 until

## J. main.ts
- `loadConfig(root)`. 토큰 경로는 `HQ_TOKEN_FILE`이 있으면 그것, 없으면 기존 경로.
- DB는 `cfg.home/hq.db`. 최초 1회 `.data/hq.db`가 있고 새 파일이 없으면 복사한다(`-wal`, `-shm` 포함 checkpoint 후).
- 시작 순서: `recover` → `runner.start` → 엔진 → 서버.
- SIGTERM 처리: runner.stop만 한다. 작업자 프로세스는 살려 둔다(분리 실행).

## K. 테스트 케이스 (작업자가 코드로 작성. 가짜 claude + 임시 git 저장소 + 가짜 시계)
각 항목의 기대 결과를 단언한다.
1. contract
   - 입력: done 없음 / 토큰 불일치 / blocked / failed / question(질문 없음·있음) / succeeded(정상, head 불일치, files 누락·초과, owns 밖, dirty, 요약 199자·200자) / limited / runaway.
   - 기대: 각각 unverifiable / unverifiable / brief_blocked / failed / failed·question / succeeded·failed×6 / limited / runaway.
2. checks
   - 기대: exit 0 → pass, exit 1 → fail, 타임아웃 → exitCode null·그룹 kill(자식 sleep 프로세스까지 종료 확인), 추가 줄의 `sk-ant-` → secrets 1건이며 값 미기록.
3. verdict: pass+blocking·pass+fail 기준·pass+tests 없음(코드 변경 있음) → invalid, fail+blocking 없음 → invalid, 정상 pass/blocking.
4. quota: 0.84 → normal, 0.85 → save, 0.90 → review_only, 0.95 → hold(until=resetsAt), status rejected → hold, resetsAt 지남 → normal, 관측 없음 → normal(observed false).
5. 사다리
   - 가짜 작업자가 매번 검사 실패하는 커밋을 남긴다.
   - 기대: 1회차 sonnet → 2회차 sonnet → 3회차 opus → task blocked, 요청 blocked, 알림 1회.
6. 전체 성공
   - 흐름: 계획 승인 → 작업 → 검사 통과 → 검토(pass) → accept 카드 → 수락 → merge 카드 → 병합.
   - 기대: 임시 repo main에 `--no-ff` 병합 커밋이 생기고, worktree·브랜치가 정리되고, 요청 merged.
7. 검토 blocking → 재작업 → 두 번째 검토 pass.
8. invalid 검토 두 번 → blocked.
9. question
   - 흐름: 작업자 question → 답 2개 중 1개 → 아직 question → 2개째 → 같은 session으로 `--resume` 호출(가짜 claude가 받은 argv로 확인), 시도 수는 늘지 않음.
10. brief_blocked → 수정 턴(가짜 CEO가 owns 같은 revised_task) → 자동 적용 → rework. owns가 넓어진 수정안 → revise 카드 생성.
11. 한도: 가짜 스트림 `rejected` → task held, 새 시작 없음. 가짜 시계로 resetsAt 이후 → 재시작, 시도 수는 늘지 않음.
12. 폭주: 가짜 작업자가 sleep, wall 1분(설정), 가짜 시계 진행 → SIGTERM → runaway → rework.
13. 복구
    - process.json 없음 → start_failed.
    - 살아 있는 pid(가짜 sleep 프로세스) → 채택.
    - 죽은 pid + 정상 done.json → succeeded 판정.
    - thinking 요청 → queued.
    - 병합 intent(모든 head 이미 조상) → 완료 기록.
14. 병합 stale: 카드 생성 뒤 대상 repo에 커밋을 추가하고 병합을 결정 → 병합하지 않고 카드가 새 해시로 다시 열림. dirty 상태도 같음.
15. 병합 충돌 → abort, 요청 accepted, 카드 재생성·본문에 충돌 파일.
16. API
    - 인코딩된 작업 id(`req-x%2FA`)로 answer/decide 동작.
    - 증거 파일 허용 목록 밖 → 404.
    - `../` 경로 → 거부.
    - 잘못된 상태의 decide → 409.
17. headline
    - 결정 3건 → "회장님 결정 3건: …", needsYou 3.
    - 결정 0 + hold → 한도 문장.
    - 작업자 2명 → "…구현 중 · 다음: 검증 외 1명".
    - 모두 없음 → "지금 하실 일은 없어요".
18. `.data/hq.db` → `$HQ_HOME/hq.db` 이전: 한 번만 복사, 기존 요청 보존.

실행: `npx tsc --noEmit`, `node --test test/unit/`. 가짜 claude는 `test/unit/fixtures/fake-claude.ts`(node 실행 파일 shim). 동작은 프롬프트 안의 마커(`[[FAKE:...]]`)나 환경변수로 고른다. 가짜 CEO 수정 턴도 같은 shim이 `--json-schema` 인자를 보고 판단한다.
