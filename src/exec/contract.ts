// Completion judgement for a work attempt (execution.md §8). judgeWork() is pure; the helpers gather its inputs.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'
import { mirrorChanged, mirrorHasMerges, mirrorIsAncestor } from './repos.ts'

export interface WorkerQuestion { question: string; options: string[]; default: string }
export interface DoneJson {
  attempt_token: string
  outcome: 'succeeded' | 'failed' | 'blocked' | 'question'
  head_sha: string
  files_modified: string[]
  summary: string
  questions: WorkerQuestion[]
}

export type WorkOutcome = 'succeeded' | 'failed' | 'brief_blocked' | 'question' | 'limited' | 'transient' | 'runaway' | 'unverifiable'

export interface GitFacts {
  /** implement: the fetched `hq-work` tip in the mirror; collect: HEAD of the read-only worktree. */
  head: string | null
  /** `git diff --name-only --no-renames base HEAD` (a rename lists both paths). */
  changed: string[]
  /** collect only; implement results are fetched commits, so uncommitted edits simply are not part of them (§6.1). */
  status: string
  baseIsAncestor: boolean
  hasMerges: boolean
}

export interface WorkFacts {
  role: 'implement' | 'collect'
  token: string
  owns: string[]
  protectedPaths: string[]
  base: string
  /** hq killed the attempt (wall time / repeated errors). */
  runaway: boolean
  /** Final stream `result` line, if any. */
  result: Record<string, unknown> | null
  stderr: string
  /** A rate_limit_event with status "rejected" appeared in the stream. */
  rejectedSeen: boolean
  /** out/done.json read safely (null = missing, symlink, not a file, or oversized). */
  doneRaw: string | null
  /** Exact file-read failure; kept separate from JSON/schema failures. */
  doneReadProblem?: string | null
  report: string | null
  /** implement: worktree facts; collect: facts of the read-only cwd (tree must be unchanged). */
  git: GitFacts | null
}

export interface Judgement { outcome: WorkOutcome; reasons: string[]; done: DoneJson | null; protectedChanges: string[]; login?: boolean }

// A full base..HEAD file list can exceed 64 KiB for game assets and playtest evidence.
export const DONE_MAX = 1024 * 1024
export const REPORT_MAX = 1024 * 1024
const LIMIT_RE = /usage limit|rate limit|limit reached|5-hour limit|weekly limit/i
const SHA_RE = /^[0-9a-f]{40}$/

/** Reads a worker-submitted file only if it is a regular file (no symlink) within the size cap. §1 */
export function readOut(outDir: string, name: string, max: number): string | null {
  return readOutResult(outDir, name, max).text
}

export function readOutResult(outDir: string, name: string, max: number): { text: string | null; problem: string | null } {
  const p = join(outDir, name)
  const fail = (reason: string) => ({ text: null, problem: `out/${name}: ${reason}` })
  try {
    const st = lstatSync(p)
    if (!st.isFile() || st.isSymbolicLink()) return fail('일반 파일이 아님 (심볼릭 링크 금지)')
    if (st.size > max) return fail(`크기 제한 초과 (${st.size} bytes > ${max} bytes)`)
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = fstatSync(fd), size = opened.size
      if (!opened.isFile()) return fail('일반 파일이 아님')
      if (size > max) return fail(`크기 제한 초과 (${size} bytes > ${max} bytes)`)
      const buf = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const count = readSync(fd, buf, offset, size - offset, offset)
        if (!count) return fail('읽는 도중 파일이 변경됨')
        offset += count
      }
      if (fstatSync(fd).size !== size) return fail('읽는 도중 파일이 변경됨')
      return { text: buf.toString('utf8'), problem: null }
    } finally { closeSync(fd) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return fail(code === 'ENOENT' ? '파일 없음' : `읽기 실패 (${code ?? 'unknown'})`)
  }
}

/** §8.1: structured signals only; stderr is consulted only when no result line exists. */
export function isLimited(result: Record<string, unknown> | null, stderr: string, rejectedSeen: boolean): boolean {
  if (rejectedSeen) return true
  if (result) return result.is_error === true && Number(result.api_error_status) === 429
  return LIMIT_RE.test(stderr)
}

export function isTransient(result: Record<string, unknown> | null): boolean {
  if (!result || result.is_error !== true) return false
  const s = Number(result.api_error_status)
  return s === 529 || (s >= 500 && s < 600)
}

export function parseDone(raw: string | null, token: string): { done: DoneJson | null; problem: string | null } {
  if (raw === null) return { done: null, problem: 'out/done.json 없음(또는 일반 파일이 아니거나 너무 큼)' }
  let d: Partial<DoneJson>
  try { d = JSON.parse(raw) } catch { return { done: null, problem: 'done.json 파싱 실패' } }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { done: null, problem: 'done.json이 객체가 아님' }
  if (d.attempt_token !== token) return { done: null, problem: 'done.json attempt_token 불일치' }
  if (!['succeeded', 'failed', 'blocked', 'question'].includes(String(d.outcome))) return { done: null, problem: `done.json outcome 값이 잘못됨: ${String(d.outcome)}` }
  return {
    problem: null,
    done: {
      attempt_token: d.attempt_token, outcome: d.outcome!, head_sha: typeof d.head_sha === 'string' ? d.head_sha.trim() : '',
      files_modified: Array.isArray(d.files_modified) ? d.files_modified.map(String) : [],
      summary: typeof d.summary === 'string' ? d.summary : '',
      questions: Array.isArray(d.questions) ? d.questions.filter((q) => q && typeof q === 'object' && typeof q.question === 'string' && q.question.trim())
        .map((q) => ({ question: String(q.question), options: Array.isArray(q.options) ? q.options.map(String) : [], default: String(q.default ?? '') })) : [],
    },
  }
}

export const normPath = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '')

/** owns entries are globs; a plain path covers descendants. Bare ** means all repo files, including dotfiles. */
export function ownsMatch(file: string, owns: string[]): boolean {
  if (!file || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) return false
  return owns.some((o) => {
    const p = normPath(o)
    // Node's glob default excludes leading dots. A whole-repository grant must also cover .gitignore.
    // Secret scanning and protected-path review remain separate mandatory checks.
    if (p === '**') return true
    if (!/[*?[{]/.test(p)) return file === p || file.startsWith(p + '/')
    return matchesGlob(file, p)
  })
}

export function protectedChanges(files: string[], globs: string[]): string[] {
  return files.filter((f) => globs.some((g) => matchesGlob(f, g) || f === normPath(g)))
}

/** Returns a problem string, or null when report.md has a `## 요약` section of at least 200 characters. */
export function reportProblem(report: string | null): string | null {
  if (report === null) return 'out/report.md 없음'
  const m = /^##\s*요약\s*$/m.exec(report)
  if (!m) return 'report.md에 `## 요약` 절이 없음'
  const rest = report.slice(m.index + m[0].length)
  const next = /^##\s/m.exec(rest)
  const body = (next ? rest.slice(0, next.index) : rest).replace(/\s+/g, ' ').trim()
  const n = [...body].length
  return n >= 200 ? null : `report.md 요약이 ${n}자 (200자 이상 필요)`
}

/** "Not logged in" stops every start until the chairman re-checks (§13); it is not a task failure. */
export function isNotLoggedIn(result: Record<string, unknown> | null, stderr = ''): boolean {
  const text = `${result?.is_error === true ? String(result.result ?? '') : ''}\n${result ? '' : stderr}`
  return /Not logged in|authentication|unauthorized|\b401\b|refresh.token/i.test(text)
}

export function judgeWork(f: WorkFacts): Judgement {
  const j = (outcome: WorkOutcome, reasons: string[], done: DoneJson | null = null, prot: string[] = []): Judgement => ({ outcome, reasons, done, protectedChanges: prot })
  // hq's own kill wins over any earlier limit event in the same stream (§13).
  if (f.runaway) return j('runaway', ['폭주 감시로 중단됨'])
  if (isNotLoggedIn(f.result, f.stderr)) return { ...j('limited', ['Codex 로그인 필요']), login: true }
  if (isLimited(f.result, f.stderr, f.rejectedSeen)) return j('limited', ['사용 한도'])
  if (isTransient(f.result)) return j('transient', [`일시 오류 (API ${String(f.result!.api_error_status)})`])
  if (f.result?.subtype === 'error_max_turns') return j('failed', ['턴 상한 도달'])
  const { done, problem } = parseDone(f.doneRaw, f.token)
  if (!done) return j('unverifiable', [f.doneRaw === null && f.doneReadProblem ? f.doneReadProblem : problem!])
  if (done.outcome === 'question') return done.questions.length ? j('question', [], done) : j('failed', ['outcome question인데 questions 없음'], done)
  if (done.outcome === 'blocked') return j('brief_blocked', [`작업자 보고 blocked: ${done.summary || '(요약 없음)'}`], done)
  if (done.outcome === 'failed') return j('failed', [`작업자 보고 failed: ${done.summary || '(요약 없음)'}`], done)

  const reasons: string[] = []
  const g = f.git
  if (!g || !g.head) return j('failed', [f.role === 'implement' ? '작업 결과(hq-work 브랜치)를 가져올 수 없음' : '작업 폴더 상태를 확인할 수 없음'], done)
  if (f.role === 'collect') {
    if (g.status || g.head !== f.base) reasons.push('읽기 전용 작업인데 작업 폴더가 바뀜')
    const rp = reportProblem(f.report)
    if (rp) reasons.push(rp)
    return j(reasons.length ? 'failed' : 'succeeded', reasons, done)
  }
  if (!SHA_RE.test(done.head_sha)) reasons.push(`head_sha 형식이 잘못됨: ${done.head_sha || '(없음)'}`)
  else if (g.head !== done.head_sha) reasons.push(`head_sha(${done.head_sha.slice(0, 10)})가 worktree HEAD(${g.head.slice(0, 10)})와 다름`)
  const claimed = new Set(done.files_modified.map(normPath))
  const actual = new Set(g.changed)
  const missing = [...actual].filter((x) => !claimed.has(x)), extra = [...claimed].filter((x) => !actual.has(x))
  if (missing.length) reasons.push(`files_modified에 빠진 변경 파일: ${missing.slice(0, 10).join(', ')}`)
  if (extra.length) reasons.push(`files_modified에 있지만 변경되지 않은 파일: ${extra.slice(0, 10).join(', ')}`)
  if (!actual.size) reasons.push('base 이후 변경된 파일이 없음')
  const outside = g.changed.filter((x) => !ownsMatch(x, f.owns))
  if (outside.length) reasons.push(`owns 밖 변경: ${outside.slice(0, 10).join(', ')}`)
  if (!g.baseIsAncestor) reasons.push('HEAD가 base의 자손이 아님')
  if (g.hasMerges) reasons.push('base 이후 merge 커밋이 있음')
  const rp = reportProblem(f.report)
  if (rp) reasons.push(rp)
  return j(reasons.length ? 'failed' : 'succeeded', reasons, done, protectedChanges(g.changed, f.protectedPaths))
}

/** Git facts of a fetched work result, computed in the mirror only (§6.1, §8.8). */
export async function mirrorFacts(mirror: string, base: string, head: string | null): Promise<GitFacts | null> {
  if (!head) return { head: null, changed: [], status: '', baseIsAncestor: false, hasMerges: false }
  try {
    const baseIsAncestor = await mirrorIsAncestor(mirror, base, head)
    return { head, changed: await mirrorChanged(mirror, base, head), status: '', baseIsAncestor, hasMerges: baseIsAncestor ? await mirrorHasMerges(mirror, base, head) : true }
  } catch { return null }
}
