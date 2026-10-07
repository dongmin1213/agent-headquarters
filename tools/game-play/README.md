# Godot 실시간 화면·키 검수

작업자와 검토자의 game 샌드박스에서 사용하는 도구다. 일반 main scene을 렌더링하며 에이전트가 스크린샷을 읽고 다음 키 입력을 선택한다. 미리 정한 공략 경로, 게임 상태 조회/수정, fixture, --qa, replay를 사용하지 않는다. 키는 `Input.parse_input_event(InputEventKey)`로 전달한다. OS 키보드나 사람 조작 증거가 아니며 주관적 인간 조작감은 별도 사용자 플레이 평가 대상이다. `save_root` 속성이 있는 게임은 세션의 save 폴더로 저장 위치만 분리한다. Dummy 음향이므로 청취 증거가 아니다.

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

키: A,D,W,S,J,K,L,Z,X,C,E,SPACE,ENTER,ESCAPE,TAB,UP,DOWN,LEFT,RIGHT. 한 번에 최대 8키, 0.05–5초간 누르고 해제한다. 입력 사이에도 게임은 실시간으로 진행하므로 안전한 위치나 게임 자체의 pause 메뉴를 이용한다. 상대 경로 대신 절대 CLI 경로를 쓴다. 게임이 실패하면 engine.log를 확인하고 같은 실패를 반복하지 않는다. 실행 프로세스는 호출 셸 종료 뒤에도 유지되며 15분 후 자동 종료한다. 검수를 마치면 반드시 stop한다.

`inputs.jsonl`에 시각·키·길이가 남고, `frames/`에 약 10fps의 실제 렌더 화면, `frames.jsonl`에 각 화면의 실제 시각이 남는다. `shot-*.png`는 동작 끝의 관측 화면이다. 프레임 시각 간격을 검사해 끊김을 기록한다. 일정 FPS로 만든 영상은 프레임 간격이 실제 시간과 일치하는지 검증하기 전 정상속도 연속 영상이라고 주장하지 않는다. 세션의 코드·자산 해시는 별도로 기록하고 필수 구간별 입력/프레임/관측 타임코드를 보고서에 연결한다. 기존 정상속도 고밀도 영상과 이 대화형 플레이 증거는 목적과 입력 주체를 구분한다.

반환된 화면을 읽지 않고 입력만 실행하거나, 재생 프로세스만 열어 놓고 전체 영상을 보았다고 주장하지 않는다. 정지 화면만으로 움직임 품질을 승인하지 않는다. 동작 구간의 시간순 프레임과 실시간 플레이를 함께 검토하고 미관측 항목은 미확인으로 남긴다. 자동 기술 통과를 제품 승인으로 대체하지 않는다. 잘린 캡처·시동 실패·키가 작동하지 않음은 성공이 아니다.

증거 폴더는 승인까지 보존하고 제출에는 필요한 영상·선택 프레임·로그·해시를 정리한다. 중간 프레임을 전부 변경 파일 목록에 커밋하지 않는다. 이 도구는 게임 상태를 바꾸는 API나 다른 앱 제어 기능을 제공하지 않는다.
