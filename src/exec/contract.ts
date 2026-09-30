// Completion judgement for a work attempt (docs/design/execution.md §6).
// judgeWork() is pure; collectGitFacts() gathers the git inputs it needs.
import { matchesGlob } from 'node:path'
import { changedFiles, revParse, statusPorcelain } from './git.ts'

export interface WorkerQuestion { question: string; options: string[]; default: string }
export interface DoneJson {
  attempt_token: string
  outcome: 'succeeded' | 'failed' | 'blocked' | 'question'
  head_sha: string
  files_modified: string[]
  summary: string
  questions?: WorkerQuestion[]
}

export type WorkOutcome = 'succeeded' | 'failed' | 'question' | 'limited' | 'runaway' | 'unverifiable'

export interface GitFacts { head: string | null; changed: string[]; status: string }

export interface WorkFacts {
  role: 'implement' | 'collect'
  /** Stream/stderr hit a usage-limit signal (see limitSignal). */
  limited: boolean
  /** hq killed the process group for exceeding wall time or repeating errors. */
  runaway: boolean
  /** Raw done.json text, or null when missing. */
  doneRaw: string | null
  token: string
  owns: string[]
  /** report.md text, or null when missing (implement only; collect checks it in verifying). */
  report: string | null
  /** implement only. */
  git: GitFacts | null
}

export interface Judgement { outcome: WorkOutcome; reasons: string[]; done: DoneJson | null }

const LIMIT_RE = /usage limit|rate limit|limit reached|5-hour limit|weekly limit/i
const SHA_RE = /^[0-9a-f]{40}$/

/** True when the attempt stopped because of the subscription limit rather than a real failure. */
export function limitSignal(resultLine: Record<string, unknown> | null, stderr: string, rejectedSeen: boolean): boolean {
  if (rejectedSeen) return true
  if (resultLine?.is_error === true && LIMIT_RE.test(String(resultLine.result ?? ''))) return true
  // Without a result line the process died early; stderr then tells us whether it was the limit.
  return !resultLine && LIMIT_RE.test(stderr)
}

export function parseDone(raw: string | null, token: string): { done: DoneJson | null; problem: string | null } {
  if (raw === null) return { done: null, problem: 'done.json 없음' }
  let d: Partial<DoneJson>
  try { d = JSON.parse(raw) } catch { return { done: null, problem: 'done.json 파싱 실패' } }
  if (!d || typeof d !== 'object') return { done: null, problem: 'done.json이 객체가 아님' }
  if (d.attempt_token !== token) return { done: null, problem: 'done.json attempt_token 불일치' }
  if (!['succeeded', 'failed', 'blocked', 'question'].includes(String(d.outcome))) return { done: null, problem: `done.json outcome 값이 잘못됨: ${String(d.outcome)}` }
  const done: DoneJson = {
    attempt_token: d.attempt_token, outcome: d.outcome!, head_sha: typeof d.head_sha === 'string' ? d.head_sha.trim() : '',
    files_modified: Array.isArray(d.files_modified) ? d.files_modified.map(String) : [],
    summary: typeof d.summary === 'string' ? d.summary : '',
    questions: Array.isArray(d.questions) ? d.questions.filter((q) => q && typeof q.question === 'string')
      .map((q) => ({ question: String(q.question), options: Array.isArray(q.options) ? q.options.map(String) : [], default: String(q.default ?? '') })) : [],
  }
  return { done, problem: null }
}

/** owns entries are globs; a plain path also covers everything below it. */
export function ownsMatch(file: string, owns: string[]): boolean {
  return owns.some((o) => {
    const p = o.replace(/^\.\//, '')
    if (!/[*?[{]/.test(p)) { const dir = p.replace(/\/+$/, ''); return file === dir || file.startsWith(dir + '/') }
    return matchesGlob(file, p)
  })
}

/** Returns a problem string, or null when report.md has a `## 요약` section of ≥ 200 characters. */
export function reportProblem(report: string | null): string | null {
  if (report === null) return 'report.md 없음'
  const m = /^##\s*요약\s*$/m.exec(report)
  if (!m) return 'report.md에 `## 요약` 절이 없음'
  const rest = report.slice(m.index + m[0].length)
  const next = /^##\s/m.exec(rest)
  const body = (next ? rest.slice(0, next.index) : rest).replace(/\s+/g, ' ').trim()
  const n = [...body].length
  return n >= 200 ? null : `report.md 요약이 ${n}자 (200자 이상 필요)`
}

export function judgeWork(f: WorkFacts): Judgement {
  if (f.limited) return { outcome: 'limited', reasons: ['사용 한도'], done: null }
  if (f.runaway) return { outcome: 'runaway', reasons: ['폭주 감시로 중단됨'], done: null }
  const { done, problem } = parseDone(f.doneRaw, f.token)
  if (!done) return { outcome: 'unverifiable', reasons: [problem!], done: null }
  if (done.outcome === 'question') {
    if (!done.questions?.length) return { outcome: 'failed', reasons: ['outcome question인데 questions 없음'], done }
    return { outcome: 'question', reasons: [], done }
  }
  if (done.outcome === 'failed' || done.outcome === 'blocked') return { outcome: 'failed', reasons: [`작업자 보고 ${done.outcome}: ${done.summary || '(요약 없음)'}`], done }
  if (f.role === 'collect') return { outcome: 'succeeded', reasons: [], done }

  const reasons: string[] = []
  const g = f.git
  if (!g) return { outcome: 'failed', reasons: ['worktree 상태를 확인할 수 없음'], done }
  if (!SHA_RE.test(done.head_sha)) reasons.push(`head_sha 형식이 잘못됨: ${done.head_sha || '(없음)'}`)
  else if (g.head !== done.head_sha) reasons.push(`head_sha(${done.head_sha.slice(0, 10)})가 worktree HEAD(${(g.head ?? '없음').slice(0, 10)})와 다름 — done.json 이후 HEAD가 바뀌었거나 잘못 적음`)
  const claimed = new Set(done.files_modified.map((x) => x.replace(/^\.\//, '')))
  const actual = new Set(g.changed)
  const missing = [...actual].filter((x) => !claimed.has(x)), extra = [...claimed].filter((x) => !actual.has(x))
  if (missing.length) reasons.push(`files_modified에 빠진 변경 파일: ${missing.slice(0, 10).join(', ')}`)
  if (extra.length) reasons.push(`files_modified에 있지만 변경되지 않은 파일: ${extra.slice(0, 10).join(', ')}`)
  if (actual.size === 0) reasons.push('base 이후 변경된 파일이 없음')
  const outside = g.changed.filter((x) => !ownsMatch(x, f.owns))
  if (outside.length) reasons.push(`owns 밖 변경: ${outside.slice(0, 10).join(', ')}`)
  if (g.status) reasons.push(`작업 트리가 깨끗하지 않음: ${g.status.split('\n').slice(0, 5).join('; ')}`)
  const rp = reportProblem(f.report)
  if (rp) reasons.push(rp)
  return { outcome: reasons.length ? 'failed' : 'succeeded', reasons, done }
}

export async function collectGitFacts(worktree: string, base: string): Promise<GitFacts | null> {
  try {
    const head = await revParse(worktree)
    if (!head) return null
    return { head, changed: await changedFiles(worktree, base, head), status: await statusPorcelain(worktree) }
  } catch { return null }
}
