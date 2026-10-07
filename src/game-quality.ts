import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { GAME_DEPARTMENTS } from './game.ts'

// Bump when the approval contract changes; an older release seal must not bypass it.
export const GAME_QUALITY_VERSION = 2
export const GAME_QUALITY_AXES = ['brief', 'controls-combat', 'world', 'art', 'presentation', 'delivery'] as const
export const GAME_QUALITY_RULES = `품질 책임: 작업자의 자체 검사 → 게임팀장 1차 품질 검수 → 피카츄 독립 2차 검수 → 사용자 플레이 순서다. 팀장과 피카츄가 맡은 제작 품질 판단을 사용자에게 넘기지 않는다. 사용자 플레이는 제작 결함을 처음 찾는 QA 절차가 아니다.
품질 기준은 사용자의 원래 요청과 레퍼런스다. 팀이 편의상 축소한 기획이나 이전 통과 판정이 이를 대체하지 않는다. 수용 기준별 기능 검사와 별도로 다음 항목을 실제 결과에서 평가한다:
- brief: 원래 요청·레퍼런스와의 구체적 차이. 수상작 이름을 적은 조사 보고서만으로 비교 완료라고 하지 않는다.
- controls-combat: 이동·점프·착지·공격·피격·회피의 반응, 애니메이션 연결, 타격 피드백과 적 공격 가독성. 정지 화면만으로 조작감을 확인했다고 하지 않는다.
- 사망이 있는 게임은 플레이어·일반 적·보스의 사망 시작→연출 종료→화면 정리/재시작까지 시간순으로 확인한다. 죽은 스프라이트·공격 이펙트·피격/충돌 판정이 무기한 남거나 재진입/저장 복원에서 중복되면 반려한다. 체력 0이나 death 애니메이션 이름만으로 통과하지 않는다.
- world: 장르에 맞는 탐험·능력 해금·되돌아갈 이유·경로 연결. 메트로베니아 요청이면 수직 공간, 분기·루프·숏컷과 능력 획득 전후의 실제 경로를 확인한다. 좌우 복도나 장식 계단만으로 충족하지 않는다.
- art: 캐릭터·적·지형의 식별, 일관된 아트·애니메이션, 배경과 플레이 공간의 분리. 임시 선 지형, 누락 에셋, 배경에 묻힌 캐릭터를 완성으로 인정하지 않는다.
- presentation: 타이틀·게임 HUD·메뉴·맵·엔딩의 일관성, 사용자 언어, 조작 안내, 디버그 표시/임시 UI 잔존 여부.
- 사용자가 전체 개편을 요구했다면 지형 보수만으로 완료하지 않는다. 타이틀부터 도입·HUD·지도·메뉴·캐릭터/적·보스·사망·엔딩까지 현재 화면을 새로 검수한다. 텍스트 나열과 임시 도형, 이전 부분 작업의 passed 기록은 요청한 시각적 완성도의 근거가 아니다. 전후 화면·동작을 직접 대조한다.
- delivery: 패키지에서 시작부터 엔딩까지 실제 진행·사망·저장 복원·오디오 기술 검증·출처. 연출용 순간이동/상태 주입 영상은 일반 플레이 증거와 구분한다.
각 항목은 pass/fail/unverified, 실제 관측, 증거 파일을 별도로 기록한다. 확인하지 못한 필수 품질 항목은 unverified로 반려한다. 알려진 문제에 적었다는 이유로 제작 결함을 면제하지 않는다. 청취 입력이 없는 주관적 음악 취향에 대한 기존 플레이 평가 예외만 유지한다. 반려하면 담당 직군과 구체적인 수정 지시를 남긴다. 완성 구간의 품질이 미달이면 같은 결함을 가진 콘텐츠를 대량 확장하지 않는다.`

export const GAME_QUALITY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pass', 'reason', 'criteria', 'repairs'],
  properties: {
    pass: { type: 'boolean' }, reason: { type: 'string' },
    criteria: { type: 'array', minItems: 6, maxItems: 6, items: {
      type: 'object', additionalProperties: false, required: ['id', 'result', 'observation', 'evidence'], properties: {
        id: { type: 'string', enum: GAME_QUALITY_AXES }, result: { type: 'string', enum: ['pass', 'fail', 'unverified'] },
        observation: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    } },
    repairs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['department', 'instruction'], properties: {
      department: { type: 'string', enum: GAME_DEPARTMENTS }, instruction: { type: 'string' },
    } } },
  },
}

/** Structural/evidence checks only. The two reviewers still judge the actual quality. */
export function gameQualityProblem(value: unknown, root: string, videoFrames: string[]): string | null {
  const v = value as any
  if (!v || typeof v.reason !== 'string' || !v.reason.trim() || !Array.isArray(v.criteria)
    || v.criteria.length !== GAME_QUALITY_AXES.length || new Set(v.criteria.map((c: any) => c?.id)).size !== GAME_QUALITY_AXES.length) return '품질 항목별 판정이 빠졌거나 중복됐습니다'
  const validFile = (p: unknown) => {
    if (typeof p !== 'string' || !p.trim()) return false
    try {
      if (videoFrames.includes(p)) return lstatSync(p).isFile() && !lstatSync(p).isSymbolicLink() && lstatSync(p).size > 0
      if (isAbsolute(p) || p.split(/[\\/]/).includes('..')) return false
      const f = resolve(root, p), rel = relative(realpathSync(root), realpathSync(f))
      return !rel.startsWith('..') && !isAbsolute(rel) && lstatSync(f).isFile() && !lstatSync(f).isSymbolicLink() && lstatSync(f).size > 0
    } catch { return false }
  }
  for (const id of GAME_QUALITY_AXES) {
    const c = v.criteria.find((c: any) => c?.id === id)
    if (!c || typeof c.observation !== 'string' || !c.observation.trim() || !Array.isArray(c.evidence)
      || !c.evidence.length || !c.evidence.every(validFile)) return `${id}: 실제 관측 또는 존재하는 증거 파일이 없습니다`
    if (c.result !== 'pass') return `${id}: ${c.result} — ${c.observation}`
    if (['controls-combat', 'world', 'art'].includes(id) && !c.evidence.some((p: string) => videoFrames.includes(p))) return `${id}: HQ가 실제 영상에서 추출한 프레임을 대조하지 않았습니다`
  }
  if (v.pass !== true) return v.reason
  if (!Array.isArray(v.repairs) || v.repairs.length) return '수정할 결함이 남아 있는 품질 판정은 승인할 수 없습니다'
  return null
}
