# 설치·운영 안내

hq(agent-headquarters)를 내 맥에 설치하고, 첫 요청을 보내고, 문제가 생기면 코드를 읽지 않고 고치는 방법입니다.

## 1. 준비물
| 항목 | 최소 | 확인 방법 |
| --- | --- | --- |
| macOS | 14 이상 | `sw_vers -productVersion` |
| Node | 26 이상 (TypeScript를 빌드 없이 실행) | `node --version` |
| Claude Code CLI | 로그인된 개인 구독 | `claude --version`, `claude auth status` |
| git | Xcode Command Line Tools에 포함 | `git --version` |
| swiftc | Xcode Command Line Tools (펫 빌드) | `xcode-select -p` |

없는 것은 `hq doctor`가 알려 주고, 줄마다 `해결:`에 고치는 명령을 적어 줍니다.

## 2. 한 번에 설치
```bash
git clone <이 저장소> ~/src/agent-headquarters
cd ~/src/agent-headquarters
bin/hq projects add ~/code/my-app          # 관리할 프로젝트 등록 (여러 개 가능)
bin/hq install                             # 진단 → 스프라이트 → 펫 빌드 → 자동 시작 등록 → 응답 확인
```
`hq install`이 하는 일:
1. `hq doctor`를 돌리고 `[실패]`가 하나라도 있으면 멈춥니다(`[경고]`는 진행).
2. 펫 스프라이트가 없으면 `scripts/fetch-packs.sh`로 받습니다. 포켓몬·디지몬 스프라이트는 **제3자 저작물**이라 저장소에 없고, 공개 스프라이트 저장소에서 이 맥에만 내려받습니다. 원하지 않으면 `--no-sprites` (펫은 기본 아이콘).
3. `pet/build.sh`로 `pet/HQPet.app`을 빌드합니다.
4. 이 CLI가 백그라운드로 띄운 데몬이 있으면 멈추고 launchd로 옮깁니다.
5. `~/Library/LaunchAgents`에 `com.agent-headquarters.daemon.plist`, `com.agent-headquarters.pet.plist`를 쓰고 `launchctl bootout` → `bootstrap gui/<uid>` 합니다. 로그인할 때마다 데몬과 펫이 자동으로 뜨고, 데몬이 비정상 종료하면 10초 뒤 다시 뜹니다.
6. 데몬이 10초 안에 `127.0.0.1:7777`에서 응답하는지 확인하고 펫을 띄웁니다.

여러 번 실행해도 안전합니다(설정 파일을 다시 쓰고 다시 등록). `~/.local/bin`이 있고 PATH에 들어 있으면 `hq` 링크를 만들어 어디서나 `hq`로 부를 수 있습니다. 아니면 안내대로 `bin/`을 PATH에 추가하세요.

## 3. 첫 요청 해 보기
1. **CEO에게 요청**: 화면의 CEO(피카츄)를 클릭하고 할 일을 한 줄로 적습니다. 예: "my-app 로그인 화면에 비밀번호 보기 버튼 추가".
2. **질문에 답하기**: CEO가 판단에 필요한 질문(최대 3개)을 하면 말풍선에서 답합니다. 필요 없으면 바로 계획을 냅니다.
3. **계획 승인**: 계획 요약과 작업 목록이 뜨면 [승인]. 승인은 계획 내용에 고정되고 만료 시간이 있어, 승인 뒤 계획이 바뀌면 다시 물어봅니다.
4. **작업자 지켜보기**: 작업마다 캐릭터가 나타나고 말풍선에 마지막 활동(편집 중인 파일, 실행 중인 명령)이 표시됩니다. 터미널에서는 `hq status`, 자세한 화면은 `hq open`.
5. **결과 수락**: 작업자가 끝내면 hq가 수용 기준을 직접 다시 돌리고 다른 작업자가 교차 검토합니다. 통과하면 CEO 창에 결과 카드가 뜹니다 → [수락] 또는 [반려(사유)].
6. **병합 승인**: 수락한 결과는 별도로 [병합] / [보류]를 고릅니다. 병합은 로컬 저장소에만 합니다(push 하지 않음).

사람이 할 일이 있으면 CEO가 뛰고 배지 숫자가 붙으며 macOS 알림이 한 번 옵니다.

## 4. 일상 명령
| 명령 | 설명 |
| --- | --- |
| `hq status [--json]` | 데몬 상태, 상황 문장, 작업자, 결정 대기 건수, 사용 한도 |
| `hq start` / `hq stop` / `hq restart` | 데몬 제어. 설치했으면 launchd로, 아니면 백그라운드 프로세스(`$HQ_HOME/daemon.pid`)로. 이미 떠 있으면 두 번째 실행은 거부 |
| `hq open` | 웹 화면 열기 (60초짜리 일회용 링크) |
| `hq logs [-f] [-n 줄]` | 데몬 로그 (`$HQ_HOME/logs/daemon.log`, 10MB마다 교체, 3개 보관) |
| `hq projects list` / `add <경로> [--id x] [--name y]` / `remove <id>` | 프로젝트 목록 편집. 바꾼 뒤 `hq restart` |
| `hq doctor [--json]` | 진단 (종료 코드 0 정상 · 6 경고 · 5 실패) |
| `hq version`, `hq help` | |

`hq stop`은 launchd 작업을 로드된 채로 두고 데몬만 멈춥니다. 다음 로그인이나 `hq start` 때 다시 뜹니다. 완전히 끄려면 `hq uninstall`.

## 5. 설정
### 프로젝트 목록 `config/projects.json`
```json
[{ "id": "my-app", "name": "내 프로젝트", "path": "~/code/my-app" }]
```
`hq projects add`로 편집하는 것을 권장합니다(경로 확인, id 중복·형식 검사, 원자적 저장). id는 `[a-z0-9-]+`. 실행 단계(worktree)에는 git 저장소가 필요합니다. 파일이 없으면 데몬은 `config/projects.example.json`으로 뜨지만 실제 프로젝트가 없는 상태입니다.

### 실행 설정 `config/hq.json` (모든 키 선택)
| 키 | 기본값 | 뜻 |
| --- | --- | --- |
| `home` | `~/.hq` | 실행 데이터 폴더 (환경 변수 `HQ_HOME`이 우선) |
| `maxWorkers` | `2` | 동시에 도는 작업자 수 |
| `attemptWallMinutes` | `{L0:20, L1:45, L2:90, L3:120}` | 등급별 시도 1회 시간 한도(분) |
| `maxTurns` | `200` | 작업자 1회 최대 턴 |
| `checkTimeoutMinutes` | `15` | 수용 기준 재실행 시간 한도(분) |
| `models` | `{haiku, sonnet, opus}` | 별칭 → `claude --model` 값 |
| `ladder` | `["haiku","sonnet","opus"]` | 재작업 때 올라가는 모델 순서 (`models`의 키) |
| `maxAttempts` | `3` | 작업당 최대 시도 |
| `quota` | `{saveAt:0.85, reviewOnlyAt:0.90, holdAt:0.95}` | 구독 사용률에 따른 절약·검토만·보류 기준 (0 < saveAt ≤ reviewOnlyAt ≤ holdAt ≤ 1) |
| `workerDisallowedTools` | push·remote·.env 접근 금지 | 작업자에게 막는 도구 |
| `notify` | `true` | macOS 알림 |
| `claudeBin` | `claude` | Claude CLI 경로 (환경 변수 `HQ_CLAUDE_BIN`이 우선) |

모르는 키가 있으면 데몬이 시작을 거부하고 `hq doctor`가 `설정` 항목에서 알려 줍니다.

### 환경 변수 (CLI)
`HQ_HOME`, `HQ_PORT`(기본 7777), `HQ_TOKEN_FILE`(기본 `~/.config/hq/token`), `HQ_LAUNCH_AGENTS_DIR`(기본 `~/Library/LaunchAgents`), `HQ_DRY_RUN=1`(launchctl·open·빌드를 실행하지 않고 출력만).

## 6. 문제 해결 (`hq doctor` 항목별)
| 항목 | 상태 | 해결 |
| --- | --- | --- |
| macOS | 실패: 14 미만 | macOS 업데이트 (Swift 6 펫 빌드에 필요) |
| Node | 실패: 26 미만 | `brew install node` 또는 nodejs.org에서 26+ 설치 |
| 설정 | 실패: 알 수 없는 키·잘못된 값 | 메시지에 나온 키를 `config/hq.json`에서 고치기 (위 표 참고) |
| Claude CLI | 실패: 없음 | `npm install -g @anthropic-ai/claude-code`, 다른 경로면 `claudeBin` 설정 |
| Claude 로그인 | 실패: 로그인 안 됨 | `claude` 실행 후 `/login` |
| git / swiftc | 실패 | `xcode-select --install` |
| 프로젝트 목록 | 경고: 파일 없음·비어 있음 | `hq projects add <경로>` |
| 프로젝트 `<id>` | 실패: 경로 없음 | `hq projects remove <id>` 후 올바른 경로로 다시 add |
| 프로젝트 `<id>` | 경고: git 아님 | 그 폴더에서 `git init && git add -A && git commit -m init` |
| 데이터 폴더 | 실패: 쓰기 불가 | `ls -ld $HQ_HOME`로 권한 확인, 또는 `HQ_HOME`을 다른 곳으로 |
| 토큰 파일 | 경고: 없음 | `hq start` (데몬이 처음 뜰 때 만듦) |
| 토큰 파일 | 실패: 0600 아님 | `chmod 600 ~/.config/hq/token` |
| 포트 7777 | 실패: 다른 프로그램 | `lsof -nP -iTCP:7777 -sTCP:LISTEN`로 확인 후 종료, 또는 `HQ_PORT` 변경 |
| 포트 7777 | 실패: 토큰이 다름(401) | 다른 토큰을 쓰는 hq가 떠 있음 → 그 프로세스 종료 후 `hq start` |
| 데몬 | 경고: 실행 중 아님 | `hq start`, 로그인 자동 시작은 `hq install`. 바로 죽으면 `hq logs` |
| 데스크 펫 | 경고: 실행 중 아님 / 빌드 안 됨 | `open pet/HQPet.app` 또는 `hq install` |
| 자동 시작: 데몬·펫 | 경고: 미설치·로드 안 됨 | `hq install` |
| 펫 스프라이트 | 경고: 없음 | `scripts/fetch-packs.sh` 후 `pet/build.sh` (선택 사항) |

그 밖에:
- `hq start`가 "10초 안에 응답하지 않았습니다" → `hq logs`의 마지막 줄을 보세요. 설정 오류나 포트 충돌이 대부분입니다.
- `hq stop`이 "이 CLI가 시작한 프로세스가 아닙니다" → 터미널에서 직접 `node src/main.ts`로 띄운 데몬입니다. 그 터미널에서 Ctrl+C.
- 진단 결과를 누구에게 보여 줄 때는 `hq doctor --json`. 토큰이나 계정 정보는 출력하지 않습니다.

## 7. 제거
```bash
hq uninstall                 # 자동 시작 해제, plist 삭제, 데몬·펫 종료. 데이터는 남김
hq uninstall --purge --yes   # $HQ_HOME(DB·worktree·증거), 토큰, 빌드한 펫까지 삭제
```
저장소 폴더와 `config/`는 지우지 않습니다. 마지막으로 저장소 폴더를 지우면 끝입니다.
