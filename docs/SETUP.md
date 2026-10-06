# 설치·운영 안내

hq(agent-headquarters)를 내 맥에 설치하고, 첫 요청을 보내고, 문제가 생기면 코드를 읽지 않고 고치는 방법입니다.

## 1. 준비물
| 항목 | 최소 | 확인 방법 |
| --- | --- | --- |
| macOS | 14 이상 | `sw_vers -productVersion` |
| Node | 26 이상 (TypeScript를 빌드 없이 실행) | `node --version` |
| Codex CLI | 0.159.2에서 검증, ChatGPT 로그인 | `codex --version`, `codex login status` |
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

작업 폴더는 요청 전체가 병합 또는 취소되고 관련 프로세스가 모두 종료된 뒤 자동 정리합니다. `$HQ_HOME/work/<요청>`의 작업 복제본, `worktrees/<요청>`의 검증용 워크트리와 Git 등록, 빈 상위 폴더가 대상이며 매분 누락을 재확인합니다. 개별 작업이 통과했더라도 요청 전체가 진행 중이면 후속 작업과 재검토를 위해 보존합니다. 실패·차단된 요청의 복구용 작업물과 실제 프로젝트 저장소도 보존합니다.

실행·검수 기록은 요청 종결 후 30일간 보관합니다. 병합·취소된 요청에만 속하는 Codex 임시 환경도 같은 시점에 삭제합니다. 공유 팀장 환경, 출처를 확인할 수 없는 폴더, DB 백업은 일괄 삭제하지 않습니다. 프로세스의 종료 여부를 확인할 수 없으면 정리를 보류하고 다음 점검에서 재시도합니다.

게임팀에 최종 로컬 전달까지 위임한 프로젝트는 운영 설정 `game.autoDeliver:<프로젝트 id>=true`를 기록합니다(기본 비활성). 이때 모든 작업·통합·별도 감독 검수가 같은 결과에 대해 통과해야 수락과 로컬 fast-forward 병합을 자동 처리합니다. 팀이 꺼져 있거나 검수 대상이 바뀌면 자동 처리하지 않으며, 기존 병합의 브랜치·HEAD·미커밋 변경 검사는 유지합니다. 결과는 등록된 프로젝트 폴더에 전달하고 알립니다. 사용자 플레이 평가를 대신 통과시키거나 Git 원격 게시·상점 출시를 수행하지 않습니다.

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
| `maxTurns` | `200` | Codex 도구 실행 시작 수의 상한(기존 키 유지). 실행기 감시 틱에서 초과 시 종료 |
| `checkTimeoutMinutes` | `15` | 수용 기준 재실행 시간 한도(분) |
| `models` | `{haiku:"gpt-6-luna", sonnet:"gpt-6.1-sol", opus:"gpt-6-astra"}` | 기존 등급 키 → `codex exec --model` 값 |
| `ladder` | `["haiku","sonnet","opus"]` | 재작업 때 올라가는 모델 순서 (`models`의 키) |
| `maxAttempts` | `3` | 작업당 최대 시도 |
| `quota` | `{saveAt:0.85, holdAt:0.95}` | 구독 사용률 기준: saveAt 이상이면 동시 1개로 절약, holdAt 이상이면 모든 시작 보류 (0 < saveAt ≤ holdAt ≤ 1). v1의 `reviewOnlyAt`은 없어졌습니다 |
| `protectedPaths` | 테스트·`package.json`·잠금 파일·`.github/**`·`tsconfig*.json`·`**/*.config.*` 등 | 이 경로가 바뀌면 검토자와 결과 카드에 항상 표시 |
| `sandbox.extraWritable` | `[]` | 작업자 샌드박스에서 추가로 쓸 수 있는 폴더 (패키지 캐시 등) |
| `workerDisallowedTools` | 기존 값 유지 | 구형 설정 호환용. Codex에는 Claude 도구 규칙을 전달하지 않으며 OS 격리·Git 설정·완료 검증으로 제한 |
| `notify` | `true` | macOS 알림 |
| `codexBin` | `codex` | Codex CLI 경로 (환경 변수 `HQ_CODEX_BIN`이 우선) |

모르는 키가 있으면 데몬이 시작을 거부하고 `hq doctor`가 `설정` 항목에서 그 오류 문장을 그대로 보여 줍니다.

### 작업자 샌드박스 (무엇을 만질 수 있나)
작업자·검토자와 `setup`·검증 명령은 모두 macOS 샌드박스(`sandbox-exec`, 규칙 v4) 안에서 돌아갑니다. 규칙은 `src/exec/sandbox.ts` 한 곳에서 만들어지고, 아래 목록은 그 파일의 `HOME_READABLE`·`MACH_SERVICES`와 같습니다(`test/unit/sandbox.test.ts`가 이 문서가 두 목록을 빠짐없이 적는지 확인합니다). `hq doctor`는 가짜 홈으로 실제 샌드박스를 만들어 홈 비밀 읽기 거부·허용 폴더 쓰기·그 밖 쓰기 거부·바깥 프로세스 신호 거부를 시험합니다.
- **읽기**: 홈 폴더(`~`)는 기본적으로 **내용을 읽을 수 없습니다**(`~/Documents`, 셸 rc 파일, `~/.config`의 다른 도구 설정, `~/.codex`, 브라우저 프로필, `~/Library/Application Support` 등). 다음만 읽을 수 있습니다.
  - `~/Library/Keychains`: 필수. 구독 로그인 토큰이 로그인 키체인에 있습니다(항목 자체는 securityd의 접근 제어를 받음).
  - `~/.local/bin`, `~/.local/share/claude`: `claude` 실행 파일과 그 버전 폴더.
  - `~/.gitconfig`, `~/.config/git`: git 사용자 설정과 전역 ignore.
  - `~/.npm`: npm 캐시(읽기만, 쓰기는 실행별 캐시로 감).
  - 자기 작업 폴더와 `out/`, hq 미러(읽기만), `sandbox.extraWritable`, 절대 경로로 지정한 `codexBin`의 폴더, 자기 Codex 저장소 `$HQ_HOME/codex/<작업 경로 해시>/`.
  - `~/.claude`의 나머지(다른 프로젝트 기록, 설정, 메모리)와 `~/.claude.json`은 읽을 수 없습니다. `$HQ_HOME`과 등록된 프로젝트 원본 폴더도 읽을 수 없습니다(작업자는 hq 미러에서 만든 자기 clone만 씁니다).
- **쓰기**: 자기 clone(작업 폴더), 자기 제출 폴더(`out/`: 보고서와 완료 파일만), 임시 폴더(`/private/tmp`와 이 사용자의 임시 폴더 `/var/folders/<x>/<y>/T`. 옆의 `C/` 캐시 폴더는 제외), `/dev`, `sandbox.extraWritable`, 자기 Codex 저장소. Codex 작업에서 개인 `~/.codex`와 `~/.claude`는 읽기·쓰기가 모두 차단됩니다. collect 작업은 clone 쓰기도 차단합니다. `~/.claude`의 다른 곳, `~/.claude.json`, 설정·`CLAUDE.md`·skills·agents·commands·plugins·hooks는 쓸 수 없습니다.
- **어떤 설정으로도 열리지 않는 곳**: `~/.config/hq`(API 토큰), `$HQ_HOME`의 DB·`runs`·`logs`·`work`, `~/.ssh`·`~/.aws`·`~/.config/gh`·`~/.netrc`·`~/.docker/config.json`, 등록된 프로젝트의 `.env*` 파일.
- **실행별 캐시**: `npm_config_cache`·`XDG_CACHE_HOME`·`PIP_CACHE_DIR`은 실행마다 새로 만든 임시 폴더를 가리키고, 작업자 프로세스 그룹이 끝나면 지웁니다. 샌드박스 안에서 만든 캐시를 나중에 샌드박스 밖 프로그램이 읽는 일을 막기 위해서입니다.
- **신호**: 같은 샌드박스 안의 프로세스에만 신호를 보낼 수 있습니다(hq, 사용자 셸, 다른 작업자에게는 못 보냄).
- **macOS 서비스(mach-lookup)**: 기본 거부이고 다음 두 가지만 허용합니다: `com.apple.SecurityServer`(키체인에서 로그인 토큰 읽기), `com.apple.system.opendirectoryd.libinfo`(사용자 이름 조회: `whoami`·`id` 등). LaunchServices·launchd 같은 서비스는 막혀 있어 샌드박스 밖 앱을 띄우지 못하고, `open`·`osascript`·`launchctl` 실행과 Apple 이벤트도 막혀 있습니다.
- **네트워크**: 열려 있지만 hq 데몬 포트(`127.0.0.1:7777`)에는 접속할 수 없습니다. 작업자가 스스로 승인하는 일을 막기 위해서입니다.
- **환경 변수**: `PATH`, `HOME`, `LANG` 같은 기본값만 넘기고 API 키·토큰·`SSH_AUTH_SOCK`은 지웁니다. git push는 설정으로 막혀 있습니다.
- **커밋**: 작업자는 hq 미러를 빌려 쓰는 자기 clone에서 커밋하고, 미러에는 쓸 수 없습니다. hq는 브랜치 이름을 믿지 않고 시도가 끝날 때 기록한 **커밋 SHA**만 가져와(개체 검사 포함) 검증·통합·병합합니다.
- **알려진 한계** (v4에서도 남는 것):
  - **키체인 항목**: 로그인 토큰 때문에 키체인 폴더와 securityd가 열려 있습니다. 항목마다의 접근 제어는 그대로지만, 접근 제어 없이 저장된 항목은 작업자도 요청할 수 있습니다.
  - **`~/.gitconfig` 내용**: 읽을 수 있으므로 이 파일에 토큰이나 비밀이 든 URL을 적어 두지 마세요.
  - **Codex 인증**: CLI 인증을 위해 개인 `auth.json`만 작업별 저장소에 0600으로 복사합니다(폴더 0700). 개인 세션·설정·플러그인은 복사하지 않습니다. 작업 프로세스는 자기 인증 사본을 읽을 수 있으므로 OpenAI 인증 자체를 모델 명령에서 숨기는 경계는 아닙니다. 이 데이터 폴더를 공유하거나 저장소에 커밋하지 마세요.
  - **공유 임시 폴더**: `/private/tmp`와 사용자 임시 폴더는 다른 작업자와 사용자 프로그램도 같이 씁니다. 비밀을 임시 폴더에 두지 마세요.
  - **`setsid` 탈출**: 작업자가 `setsid`로 새 프로세스 그룹을 만들면 hq의 그룹 종료(시간 초과·취소)에 걸리지 않고 남을 수 있습니다. 그 프로세스도 샌드박스 규칙은 그대로 받습니다.
- **반복 팀**: 팀 명령도 같은 v4 규칙 조각(신호·mach 허용 목록·홈 읽기 기본 거부·`~/.claude` 쓰기 제한·실행 차단)으로 만든 프로필 안에서 돕니다. 차이는 팀 폴더(`cwd`) 읽기·쓰기, 설정한 추가 경로(`sandbox.readable`·`writable`·`mach`), 열려 있는 hq 포트(범위 토큰으로만 접속)이고, 마지막 규칙으로 hq 저장소 쓰기를 막습니다. 자세한 내용은 아래 "반복 팀"에 있습니다.

Codex 실행에는 `com.apple.trustd.agent`를 추가 허용합니다(TLS 인증서 검증). 작업자·검토자는 HQ의 외부 Seatbelt 안에서 실행하므로 Codex의 내부 샌드박스 우회 플래그를 사용합니다. 이를 HQ 밖에서 단독 실행하는 예제로 쓰지 마세요. 사장·수정·진단 턴은 Codex의 `read-only`와 `approval_policy="never"`를 사용합니다.

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
    - 데몬 토큰 폴더(`~/.config/hq`), `$HQ_HOME`, `~/.ssh`·`~/.aws`·`~/.config/gh`·`~/.netrc`·`~/.docker/config.json`은 어떤 설정으로도 열리지 않고, hq 저장소는 어떤 설정으로도 쓸 수 없습니다(프로필의 마지막 규칙).
    - **팀 폴더 제한**: 팀 `cwd`가 hq 저장소나 `$HQ_HOME`과 같거나, 그 위(조상)나 안에 있으면 그 팀은 실행하지 않고 말풍선에 `실행할 수 없어요: 팀 폴더가 hq 저장소나 hq 데이터와 겹쳐요`를 띄웁니다. 팀이 자기 격리 설정(`config/teams.json`)이나 데몬 코드를 고치지 못하게 하기 위해서입니다. 예시 파일의 `smoke` 팀(`~/code/hq-smoke`)은 예시 전용이고 꺼져 있습니다.
    - 네트워크는 열려 있습니다(웹 API, 그리고 범위 토큰으로 hq에 연결). npm·pip·XDG 캐시는 실행마다 새 임시 폴더를 쓰고 실행이 끝나면 지웁니다.
  - **경로 더 허용하기**: 팀이 홈의 다른 경로를 써야 하면 팀 항목에 `"sandbox": {"readable": ["~/경로"], "writable": ["~/경로"]}`를 넣습니다(`~` 가능, 상대 경로는 `cwd` 기준, `writable`은 읽기도 허용). 모두 공통 허용 목록이 아니라 그 팀에만 적용됩니다. 수익자동화 파이프라인(`hq_team.py`: 리서치·대본·승인 묶음)은 추가 경로 없이 돕니다(측정: `.venv` 가져오기, `hq_team.py`, Codex JSON 응답·실시간 웹 검색, 파이썬 https, 파이프라인 자체 테스트 19개, `yt-dlp` 조회, `ffmpeg-full` drawtext). 참고로 측정된 예외:
    - **Higgsfield CLI**(유료 단계, 지금은 팀이 아니라 사용자가 직접 실행): 설정 폴더 쓰기와 함께, HTTPS 인증서 확인에 macOS `trustd` 서비스가 필요합니다. 없으면 `request failed (no response received)`로 실패합니다. 팀이 Higgsfield를 불러야 한다면 아래처럼 허용합니다(측정: `higgsfield account status` 성공).
      ```json
      "sandbox": { "writable": ["~/.config/higgsfield"], "mach": ["com.apple.trustd.agent"] }
      ```
  - **mach 서비스 더하기**: `"sandbox": {"mach": [...]}`에는 hq가 정한 허용 목록(`src/exec/sandbox.ts`의 `TEAM_MACH_ALLOWED`)에 있는 이름만 넣을 수 있습니다. 지금 목록은 `com.apple.trustd.agent`(인증서 확인) 하나뿐입니다. 다른 이름을 넣으면 실행하지 않고 `실행할 수 없어요: 허용되지 않은 mach 서비스 <이름>`으로 끝납니다. LaunchServices·launchd 같은 서비스는 샌드박스 밖 프로그램을 띄우는 통로라서 목록에 넣지 않습니다.
  - **샌드박스 끄기**: `"sandbox": "none"`이면 그 팀은 샌드박스 없이 돕니다(범위 토큰·환경 변수 정리는 그대로). 명시적인 예외이므로 `hq doctor`가 `[경고] 팀 <이름>: 샌드박스 없이 실행돼요 (config/teams.json sandbox: "none")`로 계속 알립니다.
  - **민감한 경로 경고**: `readable`·`writable`에 홈 폴더 자체, `~/Library`, `~/.config` 전체, `~/Library/LaunchAgents`(그 안 포함), 셸 rc 파일(`~/.zshrc`·`~/.bashrc`·`~/.zprofile`·`~/.profile`), `~/.claude` 전체, `~/.codex`(그 안 포함), 또는 이들을 품는 상위 폴더(예: `/`)를 넣으면 실행은 되지만 `hq doctor`가 `[경고] 팀 <이름>: 샌드박스 설정이 민감한 경로를 열어요 (<경로>)`로 알립니다. 꼭 필요한 하위 폴더나 파일로 좁혀 주세요.
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
| Codex CLI | 실패: 없음 | `npm install -g @openai/codex`, 다른 경로면 `codexBin` 설정 |
| Codex 로그인 | 실패: 로그인 안 됨 | `codex login` |
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
- `HQ_LIVE=1 node --test test/unit/codex-live.test.ts`: 실제 Codex 호출·명령 실행·JSON 응답·세션 재개를 검증합니다. ChatGPT 로그인과 사용량이 필요합니다. 수익자동화 파이프라인의 Codex 연결·실시간 웹 검색 시험은 별도 `HQ_LIVE_PIPELINE=1`일 때만 실행합니다.
- `HQ_LIVE_FLOW=1 node --test --test-timeout=360000 test/unit/codex-flow-live.test.ts`: 격리된 임시 저장소에서 실제 Codex 사장 계획 → 구현 → 독립 검토 → 수락 → fast-forward 병합을 검증합니다. 승인도 이 시험 요청에만 적용하며 운영 데몬·프로젝트는 건드리지 않습니다.
- `hq doctor`가 이 맥에서 `[실패]` 없음


### Codex로 전환

```sh
npm install -g @openai/codex
codex login
codex login status
./bin/hq doctor
./bin/hq restart
```

기본 실행 경로는 모두 Codex입니다: 사장 계획, 작업자, 검토자, 지시서 수정, 막힘 진단, 내장 smoke 팀. 별도 OpenAI API 키를 요구하지 않고 ChatGPT 로그인을 사용합니다. CLI가 키체인 전용으로 인증을 저장했다면 `codex -c cli_auth_credentials_store='"file"' login`으로 파일 인증을 만들거나 별도 `CODEX_HOME`에 로그인하세요. 새 구독이 반영되지 않으면 `codex login` 후 `codex login status`를 다시 확인합니다. HQ는 CLI의 구독 권한을 따르며 자체적으로 플랜을 바꾸지 않습니다.

- `config/hq.json`의 기존 `claudeBin`은 더 이상 사용하지 않습니다. `codexBin` 또는 `HQ_CODEX_BIN`을 사용하세요. 예전 모델 값 `haiku`/`sonnet`/`opus`와 `claude-*`는 같은 작업 등급의 기본 GPT 모델로 바꿔 읽습니다. 파일 자체를 덮어쓰지는 않습니다.
- 등급 키는 기존 계획·작업·승인 해시를 보존하기 위해 유지합니다. 실제 모델은 위 `models` 표대로 호출되며 원하는 Codex 지원 모델로 설정할 수 있습니다.
- 개인 `CODEX_HOME`(기본 `~/.codex`)에서 인증 파일만 읽고, 작업·팀별 저장소에 복사합니다. 사용자 대화·config·hooks·MCP 설정을 복사하지 않습니다. 계정 로그인 파일이 바뀌면 다음 실행에 반영하고, 각 저장소에서 갱신된 토큰은 유지합니다.
- Codex 세션은 DB에 `codex:<thread_id>`로 기록합니다. 재개 시 원래 작업의 Codex 저장소를 유지하므로 collect의 작업 폴더가 바뀌어도 대화를 이어갑니다. 기존 Claude 세션 ID를 Codex에 전달하지 않습니다. 재개 프롬프트에는 원래 지시·완료 조건·누적 질문 답변과 현재 작업 경로를 다시 전달합니다.
- 개인 인증 파일이 그대로여도 작업용 인증 사본이 없어지면 다음 실행 때 복원합니다. 개인 인증 파일이 삭제되면 다음 실행 준비 때 작업용 인증 사본도 삭제합니다. 이미 실행 중인 프로세스의 인증까지 취소하는 동작은 아닙니다.
- Codex `--json`의 실제 `command_execution` 종료 코드로 검토 증거를 대조합니다. 종료 코드가 없거나 실행이 완료되지 않으면 성공으로 추정하지 않습니다. 구형 Claude 스트림은 과거 증거를 읽기 위해 계속 해석합니다.
- 처음 Codex 데몬을 시작할 때 이전 Claude의 한도·로그인 보류만 초기화합니다. 요청·작업·승인·검증 이력은 유지하며, 이후 재시작에서는 Codex 한도를 초기화하지 않습니다.
- Codex가 구독 사용률·리셋 시각을 내보내지 않으면 이를 추정하지 않고 미관측으로 둡니다. 명시적 사용 한도 오류에는 기존 15/30/60분 대기를 적용합니다. 구독 실행에 API 달러 비용을 지어내지 않습니다.
- 등록된 외부 팀 명령은 임의의 프로그램입니다. 수익자동화 파이프라인(`side-pipeline`)의 리서치·대본 호출도 Codex로 전환했습니다. 새로운 외부 명령을 등록할 때는 그 프로그램의 LLM 연결을 별도로 확인합니다. 팀에는 자신의 `CODEX_HOME`이 전달됩니다.

참고: [Codex 비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode), [GPT 모델 안내](https://developers.openai.com/api/docs/guides/latest-model).

### 게임 전담팀 (프로젝트별 선택 기능)

`node scripts/setup-game.ts /게임/저장소/경로`로 별도 Git 프로젝트를 만들고 `workflow: "game"`으로 등록합니다. 기존 프로젝트와 외부 수익자동화 팀에는 이 규칙을 적용하지 않습니다. 설치는 제작 요청을 시작하지 않습니다. HQ 재시작 후 피카츄 → 새 요청 → 게임개발팀을 선택하고 목표를 입력합니다. 참고 화면은 게임 저장소 `references/`에 보관하고 배포물에는 포함하지 않습니다.

- 팀장이 실제 조사 → 기획 → 게임플레이·아트·레벨 → QA → 통합·제출 순서의 작업 의존 관계를 정합니다. 모든 직군과 독립 검토가 있어야 계획이 시작됩니다. 조사 없는 기획, 기획 전 제작, 다른 프로젝트 수정, 외부 결제·배포 작업은 계획 검사에서 거부합니다.
- 이 모드는 사용자가 기획·기술 선택을 위임한 프로젝트입니다. 검증된 계획의 내부 승인과 작업자의 세부 질문은 팀장이 처리합니다. 질문·재작업은 작업당 최대 3회, 요청 전체 실행 시도는 100회, 최종 감독 반려는 3회로 제한합니다. 소진되면 실패 이유를 알리며 완성으로 표시하지 않습니다. 구독 한도·로그인 문제는 기존 HQ 보류 절차를 따릅니다.
- 팀장의 해결 불가 판단은 피카츄(Astra)가 증거와 위임 범위를 재검토한 뒤 처리합니다. 내부 결함은 현재 작업의 지시서·파일 소유를 실제 수정하여 재배정할 수 있습니다. 기존 완료 기준과 검사 명령·의존 관계·독립 검토는 변경하지 않으며, 병렬 소유 충돌·프로젝트 밖 경로·오래된 판단은 거부합니다. 실패를 단순히 사용자 질문으로 중계하지 않습니다.
- 피카츄 확인을 거친 결제·외부 공개·로그인·위임 밖 파괴적 변경·실질적 목표 변경·필수 사용자 정보만 사용자 결정 카드로 올립니다. 해결 못한 기술 문제는 원인을 상태에 표시하고 해당 작업만 보류하며 독립 작업은 계속합니다. 같은 보류에 유료 판단을 반복하지 않습니다. 일반 프로젝트의 승인 흐름은 유지합니다.
- research 직군에만 실시간 웹 검색, art 직군에만 Codex 내장 이미지 생성을 추가합니다. 별도 API 키로 자동 전환하지 않습니다. 생성물은 작업 저장소로 옮겨 커밋하고, 이미지 원본·프롬프트·출처·프레임 정리 내용을 기록합니다. 이미지 도구 성공은 게임 아트 품질 보장이 아니며 QA와 감독이 실제 사용 결과를 확인합니다.
- 팀장이 `release/game-release.json`을 제출해도 바로 수락 카드를 만들지 않습니다. HQ가 실행물·3초 이상의 플레이 영상·스크린샷·조사·기획·에셋 출처 파일의 경로와 SHA-256을 확인하고, boot/movement/combat/progression/save-load/ending 검사를 별도 실행합니다. 피카츄는 새 Codex 세션에 실제 스크린샷을 입력받고 코드·검사·콘텐츠를 읽어 독립 판정합니다. 모델의 통과 주장만 있고 도구를 실행한 근거가 없으면 반려합니다. 판정은 통합 SHA와 작업 세대에 묶이며 변경되면 다시 검사합니다.
- 통과 시 사용자에게 플레이 평가용 출시 후보의 폴더·실행 명령·알려진 문제·검수 기록을 제공합니다. 수락과 원본 프로젝트 병합은 사용자가 결정합니다. 상용 성공·재미·무결함을 자동 보증하거나 스토어에 게시하지 않습니다.
- `hq` 메뉴와 팀 상세 화면의 **팀 켜기/끄기**는 즉시 저장되며 데몬 재시작 후에도 유지됩니다. 끄기는 현재 실행을 강제 종료하지 않고 다음 실행/배정을 멈춥니다. 긴급 작업 중단은 해당 요청 취소를 사용합니다. 게임팀은 요청이 있을 때만 일하며 정기적으로 새 게임을 만들지 않습니다.
- API: `POST /api/teams/:id/enabled`에 `{"enabled":false}`. 게임팀 id는 `game:<projectId>`입니다. master 인증이 필요하며 외부 팀 토큰은 조작할 수 없습니다.

검증: `node --test test/unit/game.test.ts test/unit/scheduler.test.ts`. 실제 이미지 생성·이미지 입력·게임팀 계획과 그래픽 실행은 구독/로컬 환경을 사용하는 별도 검증이며 전체 상용 게임 제작 검증과 구분합니다.

게임 그래픽 프로필은 Godot 화면 캡처를 위해 `com.apple.hiservices-xpcservice`, `com.apple.windowserver.active`, `com.apple.windowserver`, `com.apple.CARenderServer`, `com.apple.MTLCompilerService`만 추가합니다. 일반 프로젝트에는 적용하지 않습니다. LaunchServices, open/osascript/launchctl 금지와 HQ 토큰·개인 인증 읽기 금지는 유지합니다. 게임 작업·검사에는 임시 HOME을 사용해 Godot 사용자 저장 데이터도 분리합니다. `HQ_LIVE_GAME_RENDER=1 node --test test/unit/game-render-live.test.ts`로 실제 움직이는 장면의 PNG 캡처·4초 영상·비밀 파일 읽기 거부를 시험합니다(잠깐 테스트 창이 열립니다).

Codex 사용률 이벤트가 아직 관측되지 않은 경우에도 독립 작업·검토는 최대 `min(2, maxWorkers)`개를 병렬 실행합니다. 사용률을 0%로 간주하지는 않습니다. CEO 판단은 우선 처리하고, 실제 한도 오류·로그인 실패·한도 backoff가 발생하면 신규 실행을 보류합니다.
