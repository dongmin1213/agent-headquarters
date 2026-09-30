// Cross review (docs/design/execution.md §8): schema, reviewer model choice, and verdict validation.
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

/** A different model from the implementer: one step up the ladder, or one down from the top. */
export function reviewerModel(ladder: ModelAlias[], implementer: string): string {
  const i = ladder.indexOf(implementer as ModelAlias)
  if (ladder.length < 2) return ladder[0] ?? implementer
  if (i < 0) return ladder[ladder.length - 1]
  return i + 1 < ladder.length ? ladder[i + 1] : ladder[i - 1]
}

export function ladderUp(ladder: ModelAlias[], m: string): string {
  const i = ladder.indexOf(m as ModelAlias)
  if (i < 0) return ladder[Math.min(1, ladder.length - 1)]
  return ladder[Math.min(i + 1, ladder.length - 1)]
}

export type VerdictCheck = { kind: 'pass'; verdict: Verdict } | { kind: 'blocking'; verdict: Verdict } | { kind: 'invalid'; reason: string; verdict: Verdict | null }

const isArr = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every((x) => x && typeof x === 'object')

/**
 * hq's rule on top of the schema: a pass with blocking items, a failed criterion, or (when code changed) no tests run
 * is not believable, and neither is a fail without any blocking reason.
 */
export function checkVerdict(raw: unknown, codeChanged: boolean): VerdictCheck {
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
  if (verdict.pass) {
    if (verdict.blocking.length) return { kind: 'invalid', reason: 'pass=true인데 blocking 있음', verdict }
    if (verdict.criteria.some((c) => c.result === 'fail')) return { kind: 'invalid', reason: 'pass=true인데 fail 기준 있음', verdict }
    if (codeChanged && verdict.tests_run.length === 0) return { kind: 'invalid', reason: 'pass=true인데 tests_run 비어 있음(코드 변경 있음)', verdict }
    return { kind: 'pass', verdict }
  }
  if (!verdict.blocking.length) return { kind: 'invalid', reason: 'pass=false인데 blocking 사유 없음', verdict }
  return { kind: 'blocking', verdict }
}
