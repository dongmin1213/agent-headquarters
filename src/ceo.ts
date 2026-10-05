// One CEO judgment turn: `codex exec` in read-only mode and a JSON schema (schema v2, execution.md §3).
// The CEO never writes files or starts work; hq stores its questions or plan.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { CodexEvents, execArgs, prepareCodexHome, strictSchema } from './codex.ts'
import { DEFAULTS } from './config.ts'
import { join, matchesGlob, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { isLimited } from './exec/contract.ts'
import { josa, particle } from './josa.ts'

export interface Project { id: string; name: string; path: string; setup?: string }
export interface CeoQuestion { question: string; options: string[]; default: string; reason: string }
export interface Acceptance { id: string; text: string; check: string; kind: 'new' | 'regression' }
export interface TaskReview { brief: string; model: 'sonnet' | 'opus' | 'none' }
export interface PlanTask {
  id: string; title: string; project: string; role: 'collect' | 'implement'
  grade: 'L0' | 'L1' | 'L2' | 'L3'; model: 'haiku' | 'sonnet' | 'opus'
  owns: string[]; acceptance: Acceptance[]; brief: string; depends_on: string[]
  review?: TaskReview
}
export interface CeoPlan { summary: string; assumptions: string[]; tasks: PlanTask[] }
export interface CeoOutput { questions: CeoQuestion[]; plan: CeoPlan | null }
export interface CeoTurn { ok: boolean; output: CeoOutput | null; sessionId: string; error: string | null; limited: boolean; costUsd: number | null }

const str = { type: 'string' }
const strArr = { type: 'array', items: str }
export const QUESTIONS_SCHEMA = { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false,
  required: ['question', 'options', 'default', 'reason'],
  properties: { question: str, options: { type: 'array', minItems: 1, maxItems: 8, items: str }, default: str, reason: str } } }
export const TASK_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['id', 'title', 'project', 'role', 'grade', 'model', 'owns', 'acceptance', 'brief', 'depends_on'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' }, title: str, project: str,
    role: { enum: ['collect', 'implement'] }, grade: { enum: ['L0', 'L1', 'L2', 'L3'] },
    model: { enum: ['haiku', 'sonnet', 'opus'] }, owns: strArr,
    acceptance: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'object', additionalProperties: false,
      required: ['id', 'text', 'check', 'kind'], properties: { id: str, text: str, check: str, kind: { enum: ['new', 'regression'] } } } },
    brief: str, depends_on: strArr,
    review: { type: 'object', additionalProperties: false, required: ['brief', 'model'], properties: { brief: str, model: { enum: ['sonnet', 'opus', 'none'] } } } } }
export const CEO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['questions', 'plan'],
  properties: {
    questions: QUESTIONS_SCHEMA,
    plan: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['summary', 'assumptions', 'tasks'],
      properties: { summary: str, assumptions: strArr, tasks: { type: 'array', minItems: 1, items: TASK_SCHEMA } } }] },
  },
}

/** Default review model by grade (§3): L0 none, L1 sonnet, L2·L3 opus. */
export const defaultReviewModel = (grade: string) => (grade === 'L0' ? 'none' : grade === 'L1' ? 'sonnet' : 'opus')
/** Review model: implement by grade (or task.review); collect is reviewed only from L2 up (§10). */
export const reviewModelOf = (t: PlanTask) => (t.role === 'collect' && (t.grade === 'L0' || t.grade === 'L1') ? 'none' : t.review?.model ?? defaultReviewModel(t.grade))

/**
 * One command only (§3, §10.2): anything that can chain, background or overrule an exit code hides failures.
 * Applied to the RAW string (before any whitespace normalisation, which would turn a newline into a space).
 * Shared by plan checks and reviewer tests_run. Returns the offending token (Korean label), or null.
 */
export function unsafeCommand(cmd: string): string | null {
  if (/[\n\r]/.test(cmd)) return '줄바꿈'
  for (const tok of ['&&', '||', '`', '$(', ';', '|']) if (cmd.includes(tok)) return tok
  // A lone `&` backgrounds (also `&>`); `2>&1`-style redirections are fine.
  if (/(?<![&<>])&(?!&)/.test(cmd)) return '&'
  if (/(^|[^\w-])exit([^\w-]|$)/.test(cmd)) return 'exit'
  const last = cmd.trim().split(/\s+/).at(-1)
  if (last === 'true' || last === ':') return `끝의 ${last}`
  return null
}

/** Guidance appended to a one-command rejection (quotes do not help: the check is conservative on purpose). */
export const ONE_COMMAND_HINT = '인자에 | ; & 같은 문자가 필요하면 스크립트 파일로 감싸 한 명령으로 실행하게 해 주세요'

/** A plan check is one command or the word `manual` (§3). Returns the offending token, or null. */
export function chainedCheck(check: string): string | null {
  if (check.trim() === 'manual') return null
  return unsafeCommand(check)
}

const norm = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '')
const isGlob = (p: string) => /[*?[{]/.test(p)
const fixedPrefix = (g: string) => { const i = g.search(/[*?[{]/); const head = i < 0 ? g : g.slice(0, i); return head.slice(0, head.lastIndexOf('/') + 1) }
const underOrEqual = (a: string, b: string) => a === b || a.startsWith(b + '/')

/** §3 overlap: prefix paths, matchesGlob either way, or overlapping fixed prefixes of globs. */
export function ownsOverlap(x: string, y: string): boolean {
  const a = norm(x), b = norm(y)
  if (a === b) return true
  if (!isGlob(a) && !isGlob(b)) return underOrEqual(a, b) || underOrEqual(b, a)
  if (matchesGlob(a, b) || matchesGlob(b, a)) return true
  const pa = isGlob(a) ? fixedPrefix(a) : a + '/', pb = isGlob(b) ? fixedPrefix(b) : b + '/'
  return pa.startsWith(pb) || pb.startsWith(pa)
}

/** Checks what the schema cannot (§3). Returns a Korean problem string or null. */
export function validate(o: CeoOutput, projects: Project[]): string | null {
  const hasQ = o.questions.length > 0, hasP = o.plan !== null
  if (hasQ === hasP) return '질문과 계획 중 정확히 하나만 채워야 합니다'
  for (const q of o.questions) if (!q.options.includes(q.default)) return `질문 "${q.question}"의 기본값이 선택지에 없습니다`
  if (!o.plan) return null
  return validateTasks(o.plan.tasks, projects)
}

export function validateTasks(tasks: PlanTask[], projects: Project[]): string | null {
  const ids = new Set(tasks.map((t) => t.id))
  if (ids.size !== tasks.length) return '작업 id가 중복됩니다'
  for (const t of tasks as (PlanTask & { external?: unknown })[]) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(t.id)) return `작업 id "${t.id}"${particle(t.id, '은/는')} 영문·숫자·_-로 1~32자여야 합니다`
    if (!projects.some((p) => p.id === t.project)) return `작업 ${t.id}의 프로젝트 "${t.project}"${particle(t.project, '이/가')} 등록되지 않았습니다`
    if (t.role !== 'collect' && t.role !== 'implement') return `작업 ${t.id}의 역할 "${String(t.role)}"${particle(String(t.role), '은/는')} 지원하지 않습니다 (collect | implement)`
    if (!['haiku', 'sonnet', 'opus'].includes(t.model)) return `작업 ${t.id}의 모델 "${String(t.model)}"${particle(String(t.model), '은/는')} 지원하지 않습니다`
    if (t.external !== undefined) return `작업 ${t.id}: 외부 게시·삭제·결제 작업은 지원하지 않습니다`
    if (t.review && !['sonnet', 'opus', 'none'].includes(t.review.model)) return `작업 ${t.id}의 검토 모델 "${String(t.review.model)}"${particle(String(t.review.model), '은/는')} 지원하지 않습니다`
    if (t.depends_on.includes(t.id)) return `작업 ${josa(t.id, '이/가')} 자기 자신에 의존합니다`
    for (const d of t.depends_on) if (!ids.has(d)) return `작업 ${josa(t.id, '이/가')} 없는 작업 ${d}에 의존합니다`
    if (t.role === 'implement' && t.owns.length === 0) return `작업 ${t.id}에 owns가 없습니다`
    const accIds = t.acceptance.map((a) => a.id)
    if (new Set(accIds).size !== accIds.length) return `작업 ${t.id}의 수용 기준 id가 중복됩니다`
    for (const a of t.acceptance) {
      if (a.kind !== 'new' && a.kind !== 'regression') return `작업 ${t.id}의 수용 기준 ${a.id}에 kind(new | regression)가 없습니다`
      const tok = chainedCheck(a.check)
      if (tok) return `작업 ${t.id}의 수용 기준 ${a.id} check는 명령 하나여야 합니다 (${tok} 사용 금지): ${a.check.slice(0, 80)} · ${ONE_COMMAND_HINT}`
    }
  }
  // Cycle check (Kahn).
  const indeg = new Map(tasks.map((t) => [t.id, t.depends_on.length]))
  const queue = tasks.filter((t) => !t.depends_on.length).map((t) => t.id)
  let seen = 0
  while (queue.length) {
    const id = queue.shift()!; seen++
    for (const t of tasks) if (t.depends_on.includes(id)) { indeg.set(t.id, indeg.get(t.id)! - 1); if (indeg.get(t.id) === 0) queue.push(t.id) }
  }
  if (seen !== tasks.length) return '작업 의존에 순환이 있습니다'
  const reach = (a: string, b: string, seenSet = new Set<string>()): boolean => {
    if (a === b) return true
    if (seenSet.has(a)) return false
    seenSet.add(a)
    return tasks.find((t) => t.id === a)!.depends_on.some((d) => reach(d, b, seenSet))
  }
  const writers = tasks.filter((t) => t.role === 'implement')
  for (let i = 0; i < writers.length; i++) for (let j = i + 1; j < writers.length; j++) {
    const a = writers[i], b = writers[j]
    if (a.project !== b.project || reach(a.id, b.id) || reach(b.id, a.id)) continue
    for (const x of a.owns) for (const y of b.owns) if (ownsOverlap(x, y)) return `병렬 작업 ${josa(a.id, '와/과')} ${b.id}의 소유 경로가 겹칩니다: ${x} / ${y}`
  }
  return null
}

// ----- running a structured (JSON schema) turn over stream-json -----

export interface JsonTurnInput {
  codexBin: string
  runtimeHome?: string
  model?: string
  cwd: string
  prompt: string
  schema: object
  sessionId: string
  resume: boolean
  addDirs: string[]
  /** Every stream line (the caller records rate_limit_event into the quota table). */
  onLine?: (line: Record<string, unknown>) => void
  timeoutMs?: number
}
export interface JsonTurn { ok: boolean; output: unknown; sessionId: string; error: string | null; limited: boolean; costUsd: number | null }

export function runJsonTurn(i: JsonTurnInput): Promise<JsonTurn> {
  const codexHome = prepareCodexHome(i.runtimeHome ?? process.env.HQ_HOME ?? join(homedir(), '.hq'), `coordinator:${i.cwd}`)
  const schemaPath = join(codexHome, `schema-${randomUUID()}.json`)
  writeFileSync(schemaPath, JSON.stringify(strictSchema(i.schema)), { mode: 0o600 })
  const args = execArgs({ model: i.model ?? DEFAULTS.models.sonnet, sessionId: i.sessionId, resume: i.resume, schemaPath })
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
  delete env.OPENAI_API_KEY
  delete env.ANTHROPIC_API_KEY
  const decoder = new CodexEvents()
  return new Promise((done) => {
    const child = spawn(i.codexBin, args, { cwd: i.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let result: Record<string, unknown> | null = null
    let err = '', rejected = false, sid = i.sessionId
    const timer = setTimeout(() => child.kill('SIGINT'), i.timeoutMs ?? 15 * 60_000)
    createInterface({ input: child.stdout! }).on('line', (raw) => {
      let line: Record<string, unknown>
      try { line = JSON.parse(raw) } catch { return }
      if (!line || typeof line !== 'object') return
      for (const event of decoder.consume(line)) {
      line = event
      if (line.type === 'result') result = line
      if (typeof line.session_id === 'string') sid = line.session_id
      if (line.type === 'rate_limit_event' && (line.rate_limit_info as Record<string, unknown> | undefined)?.status === 'rejected') rejected = true
      try { i.onLine?.(line) } catch { /* observer errors never break the turn */ }
      }
    })
    child.stderr!.on('data', (b: Buffer) => { if (err.length < 20_000) err += b })
    child.on('error', (e) => { err += String(e) })
    child.stdin!.on('error', () => {})
    child.stdin!.end(i.prompt)
    child.on('close', (code) => {
      clearTimeout(timer)
      rmSync(schemaPath, { force: true })
      const r = result as Record<string, unknown> | null
      const limited = isLimited(r, err, rejected)
      const cost = typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null
      const so = r?.structured_output
      if (code !== 0 || !r || r.is_error || so === undefined || so === null) return done({ ok: false, output: null, sessionId: sid, error: r ? String(r.result ?? r.subtype ?? '오류') : (err.trim() || '출력 없음').slice(0, 500), limited, costUsd: cost })
      done({ ok: true, output: so, sessionId: sid, error: null, limited: false, costUsd: cost })
    })
  })
}

export interface TurnInput {
  request: string; answers: { question: string; answer: string }[]; correction: string | null; project: Project; projects: Project[]
  resumeSessionId: string | null; hqRoot: string; codexBin: string; runtimeHome?: string; model?: string; onLine?: (line: Record<string, unknown>) => void
}

export async function runCeoTurn(input: TurnInput): Promise<CeoTurn> {
  const rules = readFileSync(resolve(input.hqRoot, 'skills/ceo.md'), 'utf8')
  const sessionId = input.resumeSessionId ?? randomUUID()
  const prompt = [
    rules,
    '## 등록된 프로젝트',
    ...input.projects.map((p) => `- ${p.id}: ${p.name} (${p.path})${p.setup ? ` — setup: \`${p.setup}\`` : ''}`),
    `기본 대상 프로젝트: ${input.project.id}`,
    '## 회장의 요청',
    input.request,
    ...(input.answers.length ? ['## 회장이 답한 질문', ...input.answers.map((a) => `- ${a.question} → ${a.answer}`)] : []),
    ...(input.correction ? ['## 이전 출력이 거부된 이유 (고쳐서 다시 내라)', input.correction] : []),
  ].join('\n')
  const t = await runJsonTurn({ codexBin: input.codexBin, runtimeHome: input.runtimeHome, model: input.model, cwd: input.project.path, prompt, schema: CEO_SCHEMA, sessionId, resume: !!input.resumeSessionId,
    addDirs: input.projects.filter((p) => p.id !== input.project.id).map((p) => p.path), onLine: input.onLine })
  const out = t.output as CeoOutput | null
  if (t.ok && (!out || !Array.isArray(out.questions))) return { ...t, ok: false, output: null, error: '출력 형식 오류' }
  return { ...t, output: out }
}
