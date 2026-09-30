// Cross review (execution.md §10): VERDICT schema and hq's verdict validation.
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

/** A tests_run command matches a Bash run when equal after whitespace normalization, or contained in it (e.g. `cd x && npm test`). */
function findRun(cmd: string, runs: { command: string; exitCode: number }[]): { command: string; exitCode: number } | undefined {
  const c = norm(cmd)
  if (!c) return undefined
  const all = runs.filter((r) => norm(r.command) === c)
  const hit = all.length ? all : runs.filter((r) => norm(r.command).includes(c))
  return hit.at(-1)
}

/**
 * hq's rules on top of the schema (§10): criteria ids must equal the acceptance ids, every tests_run entry must match
 * a Bash run in the reviewer's stream with the same exit code, and pass/blocking must agree.
 */
export function checkVerdict(raw: unknown, o: { acceptanceIds: string[]; codeChanged: boolean; bashRuns: { command: string; exitCode: number }[] }): VerdictCheck {
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
  if (o.codeChanged && !verdict.tests_run.length) return bad('코드 변경이 있는데 tests_run이 비어 있음')
  for (const t of verdict.tests_run) {
    const run = findRun(t.command, o.bashRuns)
    if (!run) return bad(`tests_run 명령이 실제 실행 기록에 없음: ${t.command.slice(0, 120)}`)
    if (run.exitCode !== t.exit_code) return bad(`tests_run 종료 코드 불일치: ${t.command.slice(0, 120)} (보고 ${t.exit_code}, 실제 ${run.exitCode})`)
  }
  if (verdict.pass) {
    if (verdict.blocking.length) return bad('pass=true인데 blocking 있음')
    if (verdict.criteria.some((c) => c.result === 'fail')) return bad('pass=true인데 fail 기준 있음')
    return { kind: 'pass', verdict }
  }
  if (!verdict.blocking.length) return bad('pass=false인데 blocking 사유 없음')
  return { kind: 'blocking', verdict }
}
