// Cross review (execution.md §10): VERDICT schema and hq's verdict validation.
import { unsafeCommand } from '../ceo.ts'
import type { ModelAlias } from '../config.ts'
import type { Verdict } from '../types.ts'

const str = { type: 'string' }
export const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pass', 'blocking', 'advisory', 'criteria', 'tests_run'],
  properties: {
    pass: { type: 'boolean' },
    blocking: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'summary', 'evidence'], properties: { id: str, summary: str, evidence: str } } },
    advisory: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'summary'], properties: { id: str, summary: str } } },
    criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'result', 'evidence'],
      properties: { id: str, result: { enum: ['pass', 'fail', 'manual'] }, evidence: str } } },
    tests_run: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['command', 'exit_code', 'summary'],
      properties: { command: str, exit_code: { type: 'integer' }, summary: str } } },
  },
}

export function ladderUp(ladder: ModelAlias[], m: string): string {
  const i = ladder.indexOf(m as ModelAlias)
  if (i < 0) return ladder[Math.min(1, ladder.length - 1)]
  return ladder[Math.min(i + 1, ladder.length - 1)]
}

export type VerdictCheck = { kind: 'pass'; verdict: Verdict } | { kind: 'blocking'; verdict: Verdict } | { kind: 'invalid'; reason: string; verdict: Verdict | null }

const isArr = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every((x) => x && typeof x === 'object')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Commands whose exit code can hide a failure are not evidence (§10.2). Same rule as plan checks, on the raw string. */
export function unreliableCommand(cmd: string): boolean {
  return unsafeCommand(cmd) !== null
}

/**
 * hq's rules on top of the schema (§10): criteria ids must equal the acceptance ids, every tests_run entry must match
 * a Bash run in the reviewer's stream with the same exit code, and pass/blocking must agree.
 * `judgeIds`: items handed to the reviewer to judge (explicit `manual` criteria and base-failed checks) — each must be
 * answered `pass` or `fail`; `manual` there means nobody judged it.
 */
export function checkVerdict(raw: unknown, o: { acceptanceIds: string[]; codeChanged: boolean; bashRuns: { command: string; exitCode: number | null }[]; judgeIds?: string[] }): VerdictCheck {
  if (!raw || typeof raw !== 'object') return { kind: 'invalid', reason: '검토 결과(structured_output) 없음', verdict: null }
  const v = raw as Record<string, unknown>
  if (typeof v.pass !== 'boolean' || !isArr(v.blocking) || !isArr(v.advisory) || !isArr(v.criteria) || !isArr(v.tests_run))
    return { kind: 'invalid', reason: '검토 결과 형식이 스키마와 다름', verdict: null }
  const verdict: Verdict = {
    pass: v.pass,
    blocking: v.blocking.map((b) => ({ id: String(b.id ?? ''), summary: String(b.summary ?? ''), evidence: String(b.evidence ?? '') })),
    advisory: v.advisory.map((b) => ({ id: String(b.id ?? ''), summary: String(b.summary ?? '') })),
    criteria: v.criteria.map((c) => ({ id: String(c.id ?? ''), result: (['pass', 'fail', 'manual'].includes(String(c.result)) ? c.result : 'fail') as 'pass' | 'fail' | 'manual', evidence: String(c.evidence ?? '') })),
    tests_run: v.tests_run.map((t) => ({ command: String(t.command ?? ''), exit_code: Number(t.exit_code ?? -1), summary: String(t.summary ?? '') })),
  }
  const bad = (reason: string): VerdictCheck => ({ kind: 'invalid', reason, verdict })
  const ids = verdict.criteria.map((c) => c.id)
  const dup = ids.find((x, i) => ids.indexOf(x) !== i)
  if (dup !== undefined) return bad(`criteria id 중복: ${dup}`)
  const missing = o.acceptanceIds.filter((x) => !ids.includes(x)), unknown = ids.filter((x) => !o.acceptanceIds.includes(x))
  if (missing.length) return bad(`criteria에 빠진 수용 기준: ${missing.join(', ')}`)
  if (unknown.length) return bad(`criteria에 모르는 id: ${unknown.join(', ')}`)
  const emptyEvidence = verdict.criteria.filter(c => !c.evidence.trim()).map(c => c.id)
  if (emptyEvidence.length) return bad(`수용 기준 판정 근거가 비어 있음: ${emptyEvidence.join(', ')}`)
  const unjudged = (o.judgeIds ?? []).filter((id) => { const c = verdict.criteria.find((x) => x.id === id); return !c || (c.result !== 'pass' && c.result !== 'fail') })
  if (unjudged.length) return bad(`사람 확인이 필요한 기준을 판정하지 않음(pass 또는 fail이어야 함): ${unjudged.join(', ')}`)
  if (o.codeChanged && !verdict.tests_run.length) return bad('코드 변경이 있는데 tests_run이 비어 있음')
  for (const t of verdict.tests_run) {
    const cmd = t.command.slice(0, 120)
    const tok = unsafeCommand(t.command)
    if (tok) return bad(`tests_run 명령이 이어 붙이기·백그라운드·종료 코드 덮기(${tok})로 실패를 가릴 수 있어 근거가 아님: ${cmd}`)
    const matches = o.bashRuns.filter((r) => norm(r.command) === norm(t.command))
    if (!matches.length) return bad(`tests_run 명령이 실제 실행 기록과 정확히 일치하지 않음: ${cmd}`)
    const run = matches.at(-1)!
    if (run.exitCode === null) return bad(`tests_run 명령의 종료 코드를 알 수 없음(중단·백그라운드 등): ${cmd}`)
    if (run.exitCode !== t.exit_code) return bad(`tests_run 종료 코드 불일치: ${cmd} (보고 ${t.exit_code}, 실제 ${run.exitCode})`)
  }
  if (verdict.pass) {
    if (verdict.tests_run.some((t) => t.exit_code !== 0)) return bad('pass=true인데 종료 코드가 0이 아닌 테스트가 있음')
    if (verdict.blocking.length) return bad('pass=true인데 blocking 있음')
    if (verdict.criteria.some((c) => c.result === 'fail')) return bad('pass=true인데 fail 기준 있음')
    return { kind: 'pass', verdict }
  }
  if (!verdict.blocking.length) return bad('pass=false인데 blocking 사유 없음')
  return { kind: 'blocking', verdict }
}
