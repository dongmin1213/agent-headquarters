# 0002. 스택: Swift 펫 + TypeScript 데몬

- 상태: 채택 (2026-09-29)

## 맥락
맥에서 혼자 쓰는 상시 프로그램이라 가볍고 오래 켜 둘 수 있어야 한다. .NET은 쓰지 않는다.

## 측정 (같은 맥, phys_footprint)
| 후보 | 메모리 |
| --- | --- |
| Swift(AppKit) 펫 | 14–16MB |
| Rust egui 펫 | 148MB |
| Tauri 펫 | 158MB |
| Electron 펫 | 189MB |
| Go 데몬 | 4MB |
| Python 데몬 | 12MB |
| Node(TS) 데몬 | 13MB |

참고: Claude Code 세션 하나가 470MB–1.3GB라서 데몬 간 차이(수 MB)는 전체에서 미미하다.

## 결정
- 펫은 Swift(AppKit): 다른 GUI 후보보다 10배 가볍다.
- 데몬은 TypeScript(Node 내장 TS 실행, `node:sqlite`): 빌드 단계·네이티브 의존성 없이 실행되고, Claude Code의 stream-json 출력 처리와 궁합이 좋다. Go보다 약간 무겁지만 전체 대비 무시할 수준.
