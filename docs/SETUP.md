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
| sandbox-exec | macOS 기본 포함 (작업자 격리) | `hq doctor`가 실제로 격리되는지 시험 |

없는 것은 `hq doctor`가 알려 주고, 줄마다 `해결:`에 고치는 명령을 적어 줍니다.

## 2. 한 번에 설치
```bash
git clone <이 저장소> ~/src/agent-headquarters
cd ~/src/agent-headquarters
bin/hq projects add ~/code/my-app --setup "npm ci --prefer-offline"   # 관리할 프로젝트 등록 (여러 개 가능, --setup 선택)
bin/hq install                             # 진단 → 스프라이트 → 펫 빌드 → 자동 시작 등록 → 응답 확인
```
`hq install`이 하는 일:
1. `hq doctor`를 돌리고 `[실패]`가 하나라도 있으면 멈춥니다(`[경고]`는 진행).
2. 펫 스프라이트가 없으면 `scripts/fetch-packs.sh`로 받습니다. 포켓몬·디지몬 스프라이트는 **제3자 저작물**이라 저장소에 없고, 공개 스프라이트 저장소에서 이 맥에만 내려받습니다. 원하지 않으면 `--no-sprites` (펫은 기본 아이콘).
3. `pet/build.sh`로 `pet/HQPet.app`을 빌드합니다.
4. 이 CLI가 백그라운드로 띄운 데몬이 있으면 멈추고 launchd로 옮깁니다.
5. `~/Library/LaunchAgents`에 `com.agent-headquarters.daemon.plist`, `com.agent-headquarters.pet.plist`를 쓰고 `launchctl bootout` → `bootstrap gui/<uid>` 합니다. 로그인할 때마다 데몬과 펫이 자동으로 뜨고, 데몬이 비정상 종료하면 10초 뒤 다시 뜹니다.
6. 데몬이 10초 안에 `127.0.0.1:7777`에서 응답하는지 확인하고 펫을 띄웁니다.

`$HQ_HOME`(기본 `~/.hq`)은 비어 있거나 없는 폴더, 또는 hq가 만든 폴더여야 합니다. 표식 `.hq-install`이 없는데 다른 파일이 들어 있으면 `HQ_HOME(<경로>)에 hq가 만들지 않은 파일이 있어요`로 멈춥니다(나중에 `--purge`가 내 파일을 hq 데이터로 여기지 않도록). 빈 폴더나 새 경로를 `HQ_HOME`으로 지정하세요. 표식이 생기기 전에 쓰던 기본 `~/.hq`는 hq가 만든 항목(`hq.db*`, `repos/`, `work/`, `worktrees/`, `runs/`, `logs/`, `cache/`, `daemon.lock`, `daemon.pid`)만 있으면 그대로 넘겨받습니다.

여러 번 실행해도 안전합니다(설정 파일을 다시 쓰고 다시 등록). `~/.local/bin`이 있고 PATH에 들어 있으면 `hq` 링크를 만들어 어디서나 `hq`로 부를 수 있습니다. 아니면 안내대로 `bin/`을 PATH에 추가하세요.

## 3. 첫 요청 해 보기
1. **CEO에게 요청**: 화면의 CEO(피카츄)를 클릭하고 할 일을 한 줄로 적습니다. 예: "my-app 로그인 화면에 비밀번호 보기 버튼 추가".
2. **질문에 답하기**: CEO가 판단에 필요한 질문(최대 3개)을 하면 말풍선에서 답합니다. 필요 없으면 바로 계획을 냅니다.
3. **계획 승인**: 계획 요약과 작업 목록이 뜨면 [승인]. 승인은 계획 내용에 고정되고 만료 시간이 있어, 승인 뒤 계획이 바뀌면 다시 물어봅니다.
4. **작업자 지켜보기**: 작업마다 캐릭터가 나타나고 말풍선에 마지막 활동(편집 중인 파일, 실행 중인 명령)이 표시됩니다. 터미널에서는 `hq status`, 자세한 화면은 웹 화면(아래 "웹 화면 열기").
5. **결과 수락**: 작업자가 끝내면 hq가 수용 기준을 직접 다시 돌리고 다른 작업자가 교차 검토합니다. 통과하면 CEO 창에 결과 카드가 뜹니다 → [수락] 또는 [반려(사유)].
6. **병합 승인**: 수락한 결과는 별도로 [병합] / [보류]를 고릅니다. 병합은 로컬 저장소에만 합니다(push 하지 않음).

사람이 할 일이 있으면 CEO가 뛰고 배지 숫자가 붙으며 macOS 알림이 한 번 옵니다.

### 웹 화면 열기
- 펫의 "자세히 보기" 또는 터미널의 `hq open`으로 엽니다. 둘 다 데몬에게 **60초짜리 일회용 링크**(`http://127.0.0.1:7777/ui/#code=…`)를 받아 브라우저로 엽니다. 코드는 주소의 `#` 뒤에 있어 서버 로그나 다른 사이트로 새지 않고, 한 번 쓰면 끝입니다.
- 로그인 상태(세션)는 **그 브라우저 탭에만** 있습니다. 쿠키를 쓰지 않으므로 새 탭·새 창·브라우저 재시작이나 데몬 재시작 뒤에는 다시 `hq open`(또는 펫)으로 여세요. 링크를 복사해 두었다가 쓰는 것은 안 됩니다.
- `hq open`은 `http://127.0.0.1:<포트>/`가 아닌 주소는 열지 않습니다.

## 4. 일상 명령
| 명령 | 설명 |
| --- | --- |
| `hq status [--json]` | 데몬 상태, 상황 문장, 작업자, 결정 대기 건수, 사용 한도 |
| `hq start` / `hq stop` / `hq restart` | 데몬 제어. 설치했으면 launchd로, 아니면 백그라운드 프로세스로. 포트가 응답하거나 데몬 잠금(`$HQ_HOME/daemon.lock`)의 pid가 살아 있으면 시작 거부. launchd로 설치한 데몬은 launchctl로만 멈추고, 백그라운드 데몬은 잠금 파일의 신원(pid·포트·저장소·`HQ_HOME`·시작 시각)이 모두 맞고 명령줄이 `<저장소>/src/main.ts`일 때만 종료. 예전 형식(pid 한 줄) 잠금은 확인할 수 없어 종료하지 않음 |
| `hq open` | 웹 화면 열기 (60초짜리 일회용 링크, 세션은 그 탭에만) |
| `hq logs [-f] [-n 줄]` | 데몬 로그 (`$HQ_HOME/logs/daemon.log`, 10MB마다 교체, 3개 보관) |
| `hq projects list` / `add <경로> [--id x] [--name y] [--setup "<명령>"]` / `remove <id>` | 프로젝트 목록 편집. 바꾼 뒤 `hq restart` |
| `hq doctor [--json]` | 진단 (종료 코드 0 정상 · 6 경고 · 5 실패) |
| `hq version`, `hq help` | |

`hq stop`은 launchd 작업을 로드된 채로 두고 데몬만 멈춥니다. 다음 로그인이나 `hq start` 때 다시 뜹니다. 완전히 끄려면 `hq uninstall`.

## 5. 설정
### 프로젝트 목록 `config/projects.json`
```json
[{ "id": "my-app", "name": "내 프로젝트", "path": "~/code/my-app" }]
```
`hq projects add`로 편집하는 것을 권장합니다(경로 확인, id 중복·형식 검사, 원자적 저장). id는 `[a-z0-9-]+`. 실행 단계(worktree)에는 **커밋이 하나 이상 있는 git 저장소**가 필요합니다(`hq doctor`가 실패로 표시).

선택 필드 `setup`: 작업용 worktree를 만든 직후 **샌드박스 안에서** 한 번 실행할 명령입니다. 새 worktree에는 `node_modules` 같은 설치물이 없으므로 의존성 설치에 씁니다.
```bash
hq projects add ~/code/web --setup "npm ci --prefer-offline"
```
```json
[{ "id": "web", "name": "web", "path": "~/code/web", "setup": "npm ci --prefer-offline" }]
```
setup이 만든 추적되지 않는 파일·무시된 파일(검증 worktree 기준)은 검사 기록(`checks.json`의 `setupCreated`: 개수와 앞 20개)에 남고, 검토자 프롬프트(`setup이 만든 파일: …`)와 결과 카드(`setup이 만든 파일 N개`)에 보입니다. `node_modules/`처럼 무시된 폴더 아래 파일은 `node_modules/ (N개)` 한 줄로 묶습니다. 추적 파일 내용 비교에서는 빠지는 파일이라 기록만 하고 실패로 치지 않습니다. 추적 파일을 바꾸는 setup은 환경 오류로 멈춥니다.

`hq projects list`가 등록된 setup을 함께 보여 줍니다. 파일이 없으면 데몬은 `config/projects.example.json`으로 뜨지만 실제 프로젝트가 없는 상태입니다.

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
| `quota` | `{saveAt:0.85, holdAt:0.95}` | 구독 사용률 기준: saveAt 이상이면 동시 1개로 절약, holdAt 이상이면 모든 시작 보류 (0 < saveAt ≤ holdAt ≤ 1). v1의 `reviewOnlyAt`은 없어졌습니다 |
| `protectedPaths` | 테스트·`package.json`·잠금 파일·`.github/**`·`tsconfig*.json`·`**/*.config.*` 등 | 이 경로가 바뀌면 검토자와 결과 카드에 항상 표시 |
| `sandbox.extraWritable` | `["~/.npm", "~/.cache", "~/Library/Caches"]` | 작업자 샌드박스에서 추가로 쓸 수 있는 폴더 (패키지 캐시 등) |
| `workerDisallowedTools` | push·remote·.env 접근 금지 | 작업자에게 막는 도구 (가드레일) |
| `notify` | `true` | macOS 알림 |
| `claudeBin` | `claude` | Claude CLI 경로 (환경 변수 `HQ_CLAUDE_BIN`이 우선) |

모르는 키가 있으면 데몬이 시작을 거부하고 `hq doctor`가 `설정` 항목에서 그 오류 문장을 그대로 보여 줍니다.

### 작업자 샌드박스 (무엇을 만질 수 있나)
작업자·검토자와 `setup`·검증 명령은 모두 macOS 샌드박스(`sandbox-exec`) 안에서 돌아갑니다. `hq doctor`는 실제로 작은 샌드박스를 만들어 "비밀 파일 읽기 거부 · 허용 폴더 쓰기 성공 · 그 밖 쓰기 거부"가 되는지 시험합니다.
- **쓸 수 있는 곳**: 자기 작업 worktree, 자기 제출 폴더(`out/`: 보고서와 완료 파일만), 프로젝트의 `.git`(커밋하려면 필요), `~/.claude`(Claude 자체 설정), 임시 폴더(`/private/tmp`, `/private/var/folders`), `sandbox.extraWritable`에 적은 캐시 폴더.
- **읽지도 쓰지도 못하는 곳**: `~/.config/hq`(API 토큰), `$HQ_HOME` 전체(DB, 다른 작업의 worktree와 증거). 자기 worktree와 자기 `out/`만 예외입니다.
- **그 밖의 파일**은 읽을 수는 있지만 쓸 수 없습니다.
- **네트워크**: hq 데몬 포트(`127.0.0.1:7777`)에는 접속할 수 없습니다. 작업자가 스스로 승인하는 일을 막기 위해서입니다.
- **환경 변수**: `PATH`, `HOME`, `LANG` 같은 기본값만 넘기고 API 키·토큰·`SSH_AUTH_SOCK`은 지웁니다. git push는 설정으로 막혀 있습니다.
- **알려진 한계**: 커밋하려면 공유 `.git`에 써야 하므로, 작업자가 **다른 브랜치의 ref를 바꿀 수는 있습니다**. 그래서 hq는 브랜치 이름을 믿지 않고, 시도가 끝날 때 기록한 **커밋 SHA**로만 검증·통합·병합합니다. 작업자가 다른 브랜치를 건드려도 hq가 병합하는 내용은 바뀌지 않습니다.

### 비밀 파일
비밀값(`.env`, 개인 키, 인증서)을 **커밋해 둔 저장소는 등록을 지원하지 않습니다**. 작업자는 자기 clone에서 git이 추적하는 파일을 모두 읽을 수 있고, 샌드박스는 추적 파일을 가리지 않습니다. `hq doctor`는 등록된 프로젝트에서 `git ls-files`로(읽기만) `.env*`, `*.pem`, `id_rsa*`, `*.p12`, `*.key`에 맞는 추적 파일을 찾아 `비밀 파일 <id>` 경고를 냅니다. 해결: `git rm --cached <파일>`로 추적을 멈추고 `.gitignore`에 넣은 뒤, 이미 커밋된 값은 새 값으로 바꾸세요(이력에 남아 있으므로).

### 환경 변수 (CLI)
`HQ_HOME`, `HQ_PORT`(기본 7777), `HQ_TOKEN_FILE`(기본 `~/.config/hq/token`), `HQ_LAUNCH_AGENTS_DIR`(기본 `~/Library/LaunchAgents`), `HQ_DRY_RUN=1`(launchctl·open·빌드를 실행하지 않고 출력만).

기본 설치가 아닌 다른 설치를 다룰 때는 앞의 네 가지(`HQ_HOME`·`HQ_PORT`·`HQ_TOKEN_FILE`·`HQ_LAUNCH_AGENTS_DIR`)를 **모두** 지정해야 합니다. 일부만 지정하면 기본 설치와 섞이므로 `install`·`uninstall`·`start`·`stop`·`restart`·`projects add/remove`는 아무것도 하지 않고 거부합니다(`status`·`doctor`는 그대로 동작). 다른 설치의 펫은 자기 포트와 토큰으로 연결되고, 캐릭터 위치를 따로 저장합니다.

### 펫 말풍선 글자 크기
`~/.config/hq/pet.json`에 `{"bubbleFontSize": 12}` 형식으로 씁니다. 기본값은 10이고 범위는 8~24입니다. 파일이나 키가 없으면 10을 쓰고, 값이 잘못되었거나 JSON이 깨져 있으면 10을 쓰면서 로그에 `pet.json:` 경고를 남깁니다. 펫을 다시 켜야 반영되며, 파일 경로는 `HQ_PET_CONFIG`로 바꿀 수 있습니다.

### 반복 팀 (`config/teams.json`)
정해진 간격으로 돌아가는 팀(예: 콘텐츠 파이프라인)을 등록합니다. 개인 경로가 들어가므로 git에서 제외되며, 없으면 `config/teams.example.json`을 씁니다.
```json
[{ "id": "revenue", "name": "수익자동화", "pack": "digimon", "command": ["~/code/pipeline/.venv/bin/python", "hq_team.py"], "cwd": "~/code/pipeline", "everyMinutes": 30, "enabled": true }]
```
- 팀 명령은 `STATUS: <문장>` 줄로 진행 상황을 알리고(펫 말풍선), 종료 코드로 상태를 알립니다: `0` 한가·완료, `3` 회장 승인 대기, `75` 사용 한도, 그 밖에는 오류.
- 승인이 필요하면 `HQ_URL`·`HQ_TOKEN`·`HQ_TEAM` 환경 변수로 `POST /api/approvals`에 카드를 올리고(id는 `team:<팀 id>:`로 시작), 다음 실행 때 `GET /api/approvals/<id>`로 결정을 읽습니다.
- 선택 항목 `timeoutMinutes`(기본 180): 한 번 실행의 최대 시간. 넘기면 팀 프로세스 그룹 전체에 SIGTERM, 10초 뒤에도 남아 있으면 SIGKILL을 보내고 `시간 초과(N분)` 오류로 끝냅니다.
- 팀은 회장이 직접 등록한 신뢰된 명령이지만, 웹을 읽는 LLM 파이프라인일 수 있어 필요한 만큼만 권한을 받습니다.
  - **범위 토큰**: `HQ_TOKEN`은 데몬의 토큰이 아니라 실행마다 새로 만드는 토큰이고, 실행이 끝나면 폐기됩니다. 이 토큰으로는 `GET /api/quota`, 자기 팀 카드 올리기(`POST /api/approvals`, id `team:<팀 id>:…`), 자기 팀 카드 읽기(`GET /api/approvals/team:<팀 id>:…`)만 됩니다. 결정(`POST /api/approvals/<id>`)은 자기 카드라도 못 하고, 그 밖의 요청은 모두 403 `팀 토큰으로는 할 수 없는 요청이에요`. 회장 결정은 펫·웹·CLI(데몬 토큰)만 할 수 있습니다.
  - **격리 실행**: 팀 명령은 작업자와 같은 macOS 샌드박스 규칙(`sandbox-exec`, v4) 안에서 돕니다. 규칙은 작업자 프로필과 한 곳(`src/exec/sandbox.ts`)에서 만들어집니다.
    - 같은 샌드박스 밖 프로세스에는 신호를 못 보내고, macOS 서비스(mach-lookup)는 키체인·사용자 정보 두 가지만 쓸 수 있으며, `open`·`osascript`·`launchctl`·Apple 이벤트로 샌드박스 밖 프로그램을 띄우지 못합니다.
    - 홈 폴더(`~`)는 기본적으로 **내용을 읽을 수 없고**, 다음만 읽을 수 있습니다: `~/Library/Keychains`, `~/.local/bin`, `~/.local/share/claude`, `~/.gitconfig`, `~/.config/git`, `~/.npm`(읽기만), 팀 폴더(`cwd`), 자기 `~/.claude/projects/<cwd를 바꾼 이름>/`(팀이 부르는 `claude -p`의 기록).
    - 쓸 수 있는 곳: 팀 폴더(`cwd`), 임시 폴더(`/private/tmp`와 사용자 임시 폴더), 자기 `~/.claude/projects/<cwd>/`(그 안의 `memory/`는 제외). `~/.claude`의 다른 곳·`~/.claude.json`·설정 파일은 쓸 수 없습니다.
    - 데몬 토큰 폴더(`~/.config/hq`), `$HQ_HOME`, `~/.ssh`·`~/.aws`·`~/.config/gh`·`~/.netrc`·`~/.docker/config.json`은 어떤 설정으로도 열리지 않습니다. 팀 폴더를 `$HQ_HOME` 아래에 두지 마세요.
    - 네트워크는 열려 있습니다(웹 API, 그리고 범위 토큰으로 hq에 연결). npm·pip·XDG 캐시는 실행마다 새 임시 폴더를 쓰고 실행이 끝나면 지웁니다.
  - **경로 더 허용하기**: 팀이 홈의 다른 경로를 써야 하면 팀 항목에 `"sandbox": {"readable": ["~/경로"], "writable": ["~/경로"]}`를 넣습니다(`~` 가능, 상대 경로는 `cwd` 기준, `writable`은 읽기도 허용). 모두 공통 허용 목록이 아니라 그 팀에만 적용됩니다. 수익자동화 파이프라인(`hq_team.py`: 리서치·대본·승인 묶음)은 추가 경로 없이 돕니다(측정: `.venv` 가져오기, `hq_team.py`, `claude -p` haiku, 파이썬 https, 파이프라인 자체 테스트 12개, `yt-dlp` 조회, `ffmpeg-full` drawtext). 참고로 측정된 예외:
    - **Higgsfield CLI**(유료 단계, 지금은 팀이 아니라 사용자가 직접 실행): 설정 폴더 쓰기와 함께, HTTPS 인증서 확인에 macOS `trustd` 서비스가 필요합니다. 없으면 `request failed (no response received)`로 실패합니다. 팀이 Higgsfield를 불러야 한다면 아래처럼 허용합니다(측정: `higgsfield account status` 성공).
      ```json
      "sandbox": { "writable": ["~/.config/higgsfield"], "mach": ["com.apple.trustd.agent"] }
      ```
  - **mach 서비스 더하기**: `"sandbox": {"mach": [...]}`에는 hq가 정한 허용 목록(`src/exec/sandbox.ts`의 `TEAM_MACH_ALLOWED`)에 있는 이름만 넣을 수 있습니다. 지금 목록은 `com.apple.trustd.agent`(인증서 확인) 하나뿐입니다. 다른 이름을 넣으면 실행하지 않고 `실행할 수 없어요: 허용되지 않은 mach 서비스 <이름>`으로 끝납니다. LaunchServices·launchd 같은 서비스는 샌드박스 밖 프로그램을 띄우는 통로라서 목록에 넣지 않습니다.
  - **샌드박스 끄기**: `"sandbox": "none"`이면 그 팀은 샌드박스 없이 돕니다(범위 토큰·환경 변수 정리는 그대로). 명시적인 예외이므로 `hq doctor`가 `[경고] 팀 <이름>: 샌드박스 없이 실행돼요 (config/teams.json sandbox: "none")`로 계속 알립니다.
  - **환경 변수**: 부모 환경에서 `HQ_TOKEN_FILE`과 이름이 `_TOKEN`·`_KEY`로 끝나거나 `ANTHROPIC_`·`OPENAI_`로 시작하는 변수는 빼고 넘깁니다(범위 토큰 `HQ_TOKEN`, `HQ_URL`, `HQ_TEAM`은 hq가 넣음). 팀에 필요한 키는 팀 폴더의 비밀 파일(예: `.env`)에서 읽으세요.
- 팀 출력은 `$HQ_HOME/logs/teams/<팀 id>/<실행 번호>.log`에 쌓이고(팀마다 최근 50개), hq는 이 파일에서 `STATUS:` 줄과 종료 코드를 읽습니다. 팀 프로세스는 데몬과 따로 돌기 때문에 hq를 재시작해도 끊기지 않고, 재시작한 hq가 pid와 시작 시각으로 같은 프로세스인지 확인해 이어서 지켜봅니다(새 실행을 겹쳐 시작하지 않음). 이미 끝났다면 로그의 종료 코드로 마무리하고, 종료 코드가 없으면 `지난 실행이 중단됐어요 · 다음 실행 때 이어서 해요`로 둡니다. 같은 프로세스인지 확인할 수 없으면(`ps` 실패) 신호를 보내지 않고 새로 시작하지도 않으며, 회장에게 카드 `<팀>: 이전 실행을 확인할 수 없어요`(pid와 명령 줄 포함)를 올립니다.
  - `끝난 것으로 보고 다시 시작`: 그 실행을 종료 코드 -1로 닫고(프로세스에는 신호를 보내지 않음) 바로 새 실행을 허용합니다. 말풍선은 `확인할 수 없던 이전 실행을 끝난 것으로 봤어요 · 다시 시작해요`.
  - `계속 기다림`: 그대로 기다리고, 24시간 뒤에도 확인이 안 되면 카드를 다시 올립니다. 그 사이 pid가 사라지면 평소처럼 닫히고 카드도 내려갑니다.
  - 이 카드는 hq가 올리는 카드라 결정은 회장(펫·웹·CLI)만 할 수 있고, 팀 토큰으로는 할 수 없습니다.
- hq가 한도 보류 중이면 실행하지 않습니다.

## 6. 문제 해결 (`hq doctor` 항목별)
| 항목 | 상태 | 해결 |
| --- | --- | --- |
| macOS | 실패: 14 미만 | macOS 업데이트 (Swift 6 펫 빌드에 필요) |
| Node | 실패: 26 미만 | `brew install node` 또는 nodejs.org에서 26+ 설치 |
| 설정 | 실패: 알 수 없는 키·잘못된 값 | 메시지에 나온 키를 `config/hq.json`에서 고치기 (위 표 참고) |
| Claude CLI | 실패: 없음 | `npm install -g @anthropic-ai/claude-code`, 다른 경로면 `claudeBin` 설정 |
| Claude 로그인 | 실패: 로그인 안 됨 | `claude` 실행 후 `/login` |
| git / swiftc | 실패 | `xcode-select --install` |
| sandbox-exec / 샌드박스 시험 | 실패 | macOS 샌드박스가 동작하지 않아 작업자를 격리할 수 없음 → macOS 업데이트, 다른 샌드박스(컨테이너·원격 셸) 안에서 hq를 돌리고 있지 않은지 확인 |
| 팀 <이름> | 경고: 샌드박스 없이 실행돼요 | `config/teams.json`에서 그 팀의 `"sandbox": "none"`을 지우기. 더 필요한 경로는 `"sandbox": {"readable": [...], "writable": [...]}`로 허용 (위 "반복 팀") |
| 프로젝트 목록 | 경고: 파일 없음·비어 있음 | `hq projects add <경로>` |
| 프로젝트 `<id>` | 실패: 경로 없음 | `hq projects remove <id>` 후 올바른 경로로 다시 add |
| 프로젝트 `<id>` | 실패: git 아님 / 커밋 없음 | 그 폴더에서 `git init && git add -A && git commit -m init` |
| 작업 트리 `<id>` | 경고: 변경 N건 | 병합은 깨끗한 작업 트리에서만 가능 → 커밋하거나 stash |
| 데이터 폴더 | 실패: 쓰기 불가 | `ls -ld $HQ_HOME`로 권한 확인, 또는 `HQ_HOME`을 다른 곳으로 |
| 토큰 파일 | 경고: 없음 | `hq start` (데몬이 처음 뜰 때 만듦) |
| 토큰 파일 | 실패: 0600 아님 | `chmod 600 ~/.config/hq/token` |
| 포트 7777 | 실패: 다른 프로그램 | `lsof -nP -iTCP:7777 -sTCP:LISTEN`로 확인 후 종료, 또는 `HQ_PORT` 변경 |
| 포트 7777 | 실패: 토큰이 다름(401) | 토큰이 맞지 않음 → `hq restart`로 데몬을 다시 띄우거나 `HQ_TOKEN_FILE`이 가리키는 토큰 파일 확인 |
| 데몬 잠금 | 경고: 오래된 잠금 / pid 재사용 | `hq start`(데몬이 넘겨받음). 안 되면 `rm $HQ_HOME/daemon.lock` |
| 데몬 잠금 | 경고: 예전 형식이에요 | 업그레이드 전 데몬이 아직 pid 한 줄 잠금을 쥐고 있어 `hq stop`·`hq restart`가 신원을 확인하지 못함 → `launchctl kickstart -k gui/<uid>/<데몬 label>`로 한 번 재시작하면 새 형식이 됨 (진단 결과의 `해결:` 줄에 이 설치의 label이 들어간 명령이 나옴) |
| 비밀 파일 `<id>` | 경고: 추적되는 비밀 파일 | 위 "비밀 파일" 참고: `git rm --cached` 후 `.gitignore`, 커밋된 값은 교체 |
| 데몬 | 경고: 실행 중 아님 | `hq start`, 로그인 자동 시작은 `hq install`. 바로 죽으면 `hq logs` |
| 데스크 펫 | 경고: 실행 중 아님 / 빌드 안 됨 | `open pet/HQPet.app` 또는 `hq install` |
| 자동 시작: 데몬·펫 | 경고: 미설치·로드 안 됨 | `hq install` |
| 폴더 접근 권한 (macOS) | 경고: 데스크탑·문서·다운로드 아래 | 자동 시작 데몬이 처음 읽을 때 'node' 접근 허용 창이 뜸 → [허용]. 거부했다면 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더 → node |
| 펫 스프라이트 | 경고: 없음 | `scripts/fetch-packs.sh` 후 `pet/build.sh` (선택 사항) |

그 밖에:
- `hq start`가 "10초 안에 응답하지 않았습니다" → `hq logs`의 마지막 줄을 보세요. 설정 오류나 포트 충돌이 대부분입니다.
- `hq install`이 "데몬이 … 응답하지 않았습니다"로 끝나요 (저장소가 데스크탑·문서·다운로드 아래)
  - 원인: launchd가 띄운 `node`가 처음 그 폴더를 읽을 때 macOS가 'node'의 폴더 접근 허용 창을 띄우고, 허용할 때까지 데몬이 멈춥니다.
  - 해결: 창에서 [허용]을 누른 뒤 `hq install`을 다시 실행하세요.
  - 이미 거부했다면: 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더 → node에서 해당 폴더를 켜세요.
  - 권한 창을 아예 피하려면 저장소를 `~/src` 같은 보호 폴더 밖으로 옮기세요.
- `hq stop`이 "이 CLI가 시작한 프로세스가 아닙니다" → 터미널에서 직접 `node src/main.ts`로 띄운 데몬입니다. 그 터미널에서 Ctrl+C.
- 업그레이드 뒤 `hq stop`·`hq restart`가 "잠금 파일 형식이 예전 것이라 확인할 수 없어요"로 거부 → 업그레이드 전에 뜬 데몬입니다. launchd로 설치했다면 `hq doctor`의 `데몬 잠금` 줄에 나오는 `launchctl kickstart -k gui/<uid>/<데몬 label>`로 한 번 재시작하세요. 백그라운드로 띄운 데몬이면 그 프로세스를 직접 종료한 뒤 `hq start`.
- 진단 결과를 누구에게 보여 줄 때는 `hq doctor --json`. 토큰이나 계정 정보는 출력하지 않습니다.

## 7. 제거
```bash
hq uninstall                 # 자동 시작 해제, plist 삭제, 데몬·펫 종료. 데이터는 남김
hq uninstall --purge --yes   # $HQ_HOME의 hq 데이터(DB·worktree·증거), 토큰, 빌드한 펫까지 삭제
```
`--purge`는 `$HQ_HOME` 안에서 hq가 만든 항목(`hq.db*`, `repos/`, `work/`, `worktrees/`, `runs/`, `logs/`, `cache/`, `daemon.lock`, `daemon.pid`, `.hq-install`)만 지우고, 폴더가 비었을 때만 폴더도 지웁니다. 그 밖의 파일은 남기고 `hq가 만들지 않은 파일은 남겨 뒀어요: …`로 알려 줍니다.
`--purge`는 지우기 전에 모두 확인하고, 하나라도 맞지 않으면 아무것도 지우지 않습니다: `$HQ_HOME`에 `hq install`이 만든 표식 `.hq-install`(이 저장소·포트)이 있어야 하고, 토큰 경로는 일반 파일이어야 하며(폴더·심볼릭 링크 거부), 데몬이 멈춘 것을 확인해야 합니다. 빌드한 펫 앱은 기본 설치에서만 지웁니다(다른 설치와 함께 쓰므로). 표식이 생기기 전에 설치했다면 `hq install`을 한 번 다시 실행하면 표식이 생깁니다.
저장소 폴더와 `config/`는 지우지 않습니다. 마지막으로 저장소 폴더를 지우면 끝입니다.

## 8. 릴리스 전 확인 (개발자)
- `npx tsc --noEmit` 오류 없음
- `npm test` 실패 0
- `HQ_LIVE=1 npm test`: 실제 Claude CLI(haiku 한 번)로 샌드박스 계약을 확인합니다. 로그인된 구독이 필요하고 사용량이 조금 듭니다.
- `hq doctor`가 이 맥에서 `[실패]` 없음
