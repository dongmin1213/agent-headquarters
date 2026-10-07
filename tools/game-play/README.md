# Godot 실시간 화면·키 검수

작업자와 검토자의 game 샌드박스에서 사용하는 도구다. 일반 main scene을 렌더링하며 에이전트가 스크린샷을 읽고 다음 키 입력을 선택한다. 미리 정한 공략 경로, 게임 상태 조회/수정, fixture, --qa, replay를 사용하지 않는다. 키는 `Input.parse_input_event(InputEventKey)`로 전달한다. OS 키보드나 사람 조작 증거가 아니며 주관적 인간 조작감은 별도 사용자 플레이 평가 대상이다. `save_root` 속성이 있는 게임은 세션의 save 폴더로 저장 위치만 분리한다. Dummy 음향이므로 청취 증거가 아니다.

기본 검수 창은 1440×810이다. `start --resolution 1920x1080`으로 다른 표시 크기를 지정할 수 있다. 대화면 검수에서는 실제 캡처 크기와 UI 잘림을 확인하고 작은 화면 증거를 확대해 대체하지 않는다. 해상도는 표시 크기이며 에셋 원본의 세부 묘사를 늘려 주지는 않는다.

아래 `<tool>`은 이 문서와 같은 폴더의 play.py 절대 경로다. `<session>`은 아직 존재하지 않는 `/tmp/hq-play-고유이름`이며 작업자마다 다르게 지정한다. 프로젝트 import가 필요한 경우 먼저 `godot --headless --editor --import --path .`를 실행한다. 체크아웃에 쓸 수 없는 검토자는 자기 임시 복제본에서 import하고 코드·자산의 원본 해시 일치를 남긴다.

```sh
python3 <tool> start --project "$PWD" --session <session>
python3 <tool> step --session <session> --seconds 0.1
# 반환된 screenshot 파일을 이미지 보기 도구로 실제 확인한 뒤 다음 키를 고른다.
python3 <tool> step --session <session> --keys ENTER --seconds 0.1
python3 <tool> step --session <session> --keys D,SPACE --seconds 0.4
python3 <tool> step --session <session> --keys TAB --seconds 0.1
python3 <tool> stop --session <session>
```

전투 중 판단 대기에는 두 CLI 호출 사이에 게임을 켜두지 말고 다음 옵션을 쓴다. 화면에서 현재 pause 여부를 먼저 확인한다.

```sh
# 현재 플레이 중: 이동/공격이 끝나면 실제 ESC 입력으로 메뉴를 연다.
python3 <tool> step --session <session> --keys J --seconds 0.4 --pause-after
# 현재 pause 메뉴: 실제 ESC로 재개 → 선택한 동작 → ESC로 다시 pause.
python3 <tool> step --session <session> --keys D,J --seconds 0.3 --resume-before --pause-after
```

`before_pause`는 메뉴가 가리기 전 동작 화면, `screenshot`은 메뉴 입력 이후 화면이다. `pause_requested`는 ESC를 보냈다는 뜻이며 화면에서 실제 메뉴가 열렸는지 확인해야 한다. 게임 상태를 읽거나 강제로 정지하지 않는다. 입력/해제 사이 물리 프레임을 확보하고 `events.jsonl`과 응답의 `timing_file`이 가리키는 JSON에 적용·해제 시각/물리 프레임/캡처 비용을 기록한다. 메뉴 왕복을 사용하는 **일시정지 보조 에이전트 플레이**이며 사람의 실시간 조작감·연속 무정지 전투 승인 근거로 쓰지 않는다. 사망 종료 후 10초 확인처럼 연속 시간이 필요한 관측에는 중간 pause를 사용하지 않는다.

실제 플레이 저장을 이어갈 때는 기존 정상 세션과 그때 기록한 원본 저장 SHA 목록을 함께 지정한다. 게임 시작 전에 일치하는 파일만 새 세션으로 복사하며 불일치 시 실행을 거부한다.

```sh
python3 <tool> start --project "$PWD" --session <new-session> --restore-session <original-session> --expected-save-hashes <original-hashes.json>
```

해시 파일은 `{ "slot1.json": "원본 SHA256", "slot1.json.bak": "원본 SHA256" }` 형식이다. 과거 정상 플레이 기록에서 확보하며 오염 후 현재 파일로 다시 계산해 맞추면 안 된다. `restore-receipt.json`에 복원 출처/해시가 남는다. fixture 검사는 별도 임시 프로필에서만 실행하고 정상 플레이 세션·저장·백업 경로를 fixture에 전달하지 않는다. 기술 검사 결과와 일반 플레이 증거를 서로 섞지 않는다.

키: A,D,W,S,J,K,L,Z,X,C,E,SPACE,ENTER,ESCAPE,TAB,UP,DOWN,LEFT,RIGHT. 한 번에 최대 8키, 0.05–5초간 누르고 해제한다. 입력 사이에도 게임은 실시간으로 진행하므로 안전한 위치나 게임 자체의 pause 메뉴를 이용한다. 상대 경로 대신 절대 CLI 경로를 쓴다. 게임이 실패하면 engine.log를 확인하고 같은 실패를 반복하지 않는다. 실행 프로세스는 호출 셸 종료 뒤에도 유지되며 15분 후 자동 종료한다. 검수를 마치면 반드시 stop한다.

`inputs.jsonl`에 시각·키·길이가 남고, `frames/`에 약 10fps의 실제 렌더 화면, `frames.jsonl`에 각 화면의 실제 시각이 남는다. `shot-*.png`는 동작 끝의 관측 화면이다. 프레임 시각 간격을 검사해 끊김을 기록한다. 일정 FPS로 만든 영상은 프레임 간격이 실제 시간과 일치하는지 검증하기 전 정상속도 연속 영상이라고 주장하지 않는다. 세션의 코드·자산 해시는 별도로 기록하고 필수 구간별 입력/프레임/관측 타임코드를 보고서에 연결한다. 기존 정상속도 고밀도 영상과 이 대화형 플레이 증거는 목적과 입력 주체를 구분한다.

반환된 화면을 읽지 않고 입력만 실행하거나, 재생 프로세스만 열어 놓고 전체 영상을 보았다고 주장하지 않는다. 정지 화면만으로 움직임 품질을 승인하지 않는다. 동작 구간의 시간순 프레임과 실시간 플레이를 함께 검토하고 미관측 항목은 미확인으로 남긴다. 자동 기술 통과를 제품 승인으로 대체하지 않는다. 잘린 캡처·시동 실패·키가 작동하지 않음은 성공이 아니다.

증거 폴더는 승인까지 보존하고 제출에는 필요한 영상·선택 프레임·로그·해시를 정리한다. 중간 프레임을 전부 변경 파일 목록에 커밋하지 않는다. 이 도구는 게임 상태를 바꾸는 API나 다른 앱 제어 기능을 제공하지 않는다.
