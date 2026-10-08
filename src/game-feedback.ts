// Concrete observed defects become owned acceptance criteria, not untracked advisory prose.
import type { PlanTask } from './ceo.ts'
import type { TaskRow } from './store.ts'

export interface GameFinding {
  id: string
  owner: string
  observation: string
  repair: string
  evidence: { file: string; sha256: string }[]
  sourceHead: string
  /** An already registered independent repair whose result the owner must integrate. */
  prerequisite?: string
}

export function feedbackSpecs(rows: TaskRow[], findings: GameFinding[], gate: string, evidenceDir: string): { specs: PlanTask[]; error: string | null } {
  const specs: PlanTask[] = rows.map(t => JSON.parse(t.spec))
  const fail = (error: string) => ({ specs: [], error })
  if (!findings.length || findings.length > 6 || new Set(findings.map(f => f.id)).size !== findings.length) return fail('품질 결함은 고유 ID로 1~6개씩 등록합니다')
  const targets = new Set([...findings.map(f => f.owner), gate])
  for (const key of targets) {
    const t = rows.find(t => t.key === key)
    if (!t || t.status !== 'pending' || t.worktree || t.head_sha || t.lingering) return fail(`품질 지시는 대기 중인 미실행 작업에만 적용합니다: ${key}`)
    const s = specs.find(s => s.id === key)!
    if (s.review?.model === 'none') return fail(`독립 검토가 필요한 품질 작업입니다: ${key}`)
  }
  if (JSON.parse(rows.find(t => t.key === gate)!.spec).department !== 'qa') return fail('최종 확인 담당은 QA 작업이어야 합니다')
  for (const f of findings) {
    if (!/^[A-Z][A-Z0-9-]{2,24}$/.test(f.id) || !f.observation.trim() || !f.repair.trim() || !/^[a-f0-9]{40}$/.test(f.sourceHead)
      || !f.evidence.length || f.evidence.length > 4 || f.evidence.some(e => !/^[a-zA-Z0-9_-]+\.png$/.test(e.file) || !/^[a-f0-9]{64}$/.test(e.sha256)))
      return fail(`품질 결함의 관측·수정 지시·원본 화면 해시가 잘못됐습니다: ${f.id}`)
    if (f.owner === gate) return fail('제작 담당과 최종 확인 담당을 분리해야 합니다')
    const s = specs.find(s => s.id === f.owner)!
    const id = `QF-${f.id}`
    if (s.acceptance.some(a => a.id === id)) return fail(`이미 등록한 품질 결함입니다: ${f.id}`)
    if (f.prerequisite) {
      if (!specs.some(s => s.id === f.prerequisite)) return fail(`품질 수정 선행 작업이 없습니다: ${f.prerequisite}`)
      s.depends_on = [...new Set([...s.depends_on, f.prerequisite])]
    }
    const instruction = `[${f.id}] 관측 소스 ${f.sourceHead}. ${f.observation}\n수정: ${f.repair}\n수정 전 실제 화면: ${f.evidence.map(e => `${evidenceDir}/${e.file} (sha256 ${e.sha256})`).join(', ')}\n이 화면은 결함 관측 자료이며 최신 통합 화면이라고 오인하지 않는다. 승인된 선행 자산이 이미 해결했다면 재생성하지 말고 실제 게임에 연결해 입증한다. 자기 담당 수정 전후를 같은 상태·표시 크기에서 실제 실행하여 캡처하고 사용 소스·리소스 해시와 재현 입력을 기록한다. 아직 실행되지 않은 다른 직군의 완료까지 담당하지 않는다.`
    s.brief += `\n\n## 반드시 닫아야 할 관측 결함\n${instruction}`
    s.acceptance.push({ id, kind: 'new', check: 'manual', text: `${f.observation} — ${f.repair} 실제 게임의 수정 전후 화면·관측·소스 근거로 해결을 입증한다. 기존 passed나 미리보기만으로 완료할 수 없다.` })
    s.review = { model: s.review?.model ?? 'sonnet', brief: `${s.review?.brief ?? ''}\n${instruction}\n위 결함은 승인 차단 조건이다. 독립 검토자가 실제 수정 화면을 열어 비교하고 해당 criteria에 pass/fail과 구체적 관측·파일 근거를 기록한다. '취향' advisory로 내려 승인하거나 파일 존재/테스트 종료0만으로 통과시키지 않는다.` }
  }
  const q = specs.find(s => s.id === gate)!
  q.depends_on = [...new Set([...q.depends_on, ...findings.map(f => f.owner)])]
  const gateId = `QF-BATCH-${findings[0].id}`
  q.acceptance.push({ id: gateId, kind: 'regression', check: 'manual', text: `관측 결함 ${findings.map(f => f.id).join(', ')}의 수정이 같은 통합 게임에서 유지되는지 실제 화면과 플레이로 재검한다. 각 수정 담당의 통과나 별도 미리보기를 인용하는 것만으로 승인하지 않는다.` })
  q.brief += `\n\n관측 결함 재발 검사: ${findings.map(f => `[${f.id}] ${f.observation} 담당=${f.owner}; ${f.repair}; 원본=${f.evidence.map(e => `${evidenceDir}/${e.file}`).join(',')}`).join('\n')}\n팀장은 기준별 수정·화면 증거를 갖춘 결과를 제출하고 피카츄 독립 검토는 같은 통합 빌드에서 대조한다. 미해결이면 확대/제출을 승인하지 말고 담당·수정·재현 조건을 구체적으로 반환한다.`
  if (specs.some(s => s.acceptance.length > 16)) return fail('추가 품질 기준이 작업당 16개를 넘습니다. 작업을 재설계해야 합니다')
  return { specs, error: null }
}
