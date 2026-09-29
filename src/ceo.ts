// One CEO judgment turn: headless `claude -p` with read-only tools and a JSON schema.
// The CEO never writes files or starts work; hq stores its questions or plan.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Project { id: string; name: string; path: string }
export interface CeoQuestion { question: string; options: string[]; default: string; reason: string }
export interface Acceptance { id: string; text: string; check: string }
export interface PlanTask {
  id: string; title: string; project: string; role: 'collect' | 'implement' | 'verify'
  grade: 'L0' | 'L1' | 'L2' | 'L3'; model: 'haiku' | 'sonnet' | 'opus' | 'none'
  owns: string[]; acceptance: Acceptance[]; brief: string; depends_on: string[]; external: boolean
}
export interface CeoPlan { summary: string; assumptions: string[]; tasks: PlanTask[] }
export interface CeoOutput { questions: CeoQuestion[]; plan: CeoPlan | null }
export interface CeoTurn { ok: boolean; output: CeoOutput | null; sessionId: string; error: string | null; limited: boolean; costUsd: number | null }

const str = { type: 'string' }
const strArr = { type: 'array', items: str }
export const CEO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['questions', 'plan'],
  properties: {
    questions: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false,
      required: ['question', 'options', 'default', 'reason'],
      properties: { question: str, options: { type: 'array', minItems: 1, maxItems: 8, items: str }, default: str, reason: str } } },
    plan: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['summary', 'assumptions', 'tasks'],
      properties: { summary: str, assumptions: strArr, tasks: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
        required: ['id', 'title', 'project', 'role', 'grade', 'model', 'owns', 'acceptance', 'brief', 'depends_on', 'external'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' }, title: str, project: str,
          role: { enum: ['collect', 'implement', 'verify'] }, grade: { enum: ['L0', 'L1', 'L2', 'L3'] },
          model: { enum: ['haiku', 'sonnet', 'opus', 'none'] }, owns: strArr,
          acceptance: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'object', additionalProperties: false,
            required: ['id', 'text', 'check'], properties: { id: str, text: str, check: str } } },
          brief: str, depends_on: strArr, external: { type: 'boolean' } } } } } }] },
  },
}

const LIMIT_RE = /usage limit|rate limit|limit reached|5-hour limit|weekly limit/i

/** Checks what the schema cannot: exactly one of questions/plan, known projects, ownership overlap, dependency ids. */
export function validate(o: CeoOutput, projects: Project[]): string | null {
  const hasQ = o.questions.length > 0, hasP = o.plan !== null
  if (hasQ === hasP) return '질문과 계획 중 정확히 하나만 채워야 합니다'
  for (const q of o.questions) if (!q.options.includes(q.default)) return `질문 "${q.question}"의 기본값이 선택지에 없습니다`
  if (!o.plan) return null
  const ids = new Set(o.plan.tasks.map((t) => t.id))
  if (ids.size !== o.plan.tasks.length) return '작업 id가 중복됩니다'
  for (const t of o.plan.tasks) {
    if (!projects.some((p) => p.id === t.project)) return `작업 ${t.id}의 프로젝트 "${t.project}"가 등록되지 않았습니다`
    for (const d of t.depends_on) if (!ids.has(d)) return `작업 ${t.id}가 없는 작업 ${d}에 의존합니다`
    if (t.role !== 'verify' && t.owns.length === 0) return `작업 ${t.id}에 owns가 없습니다`
  }
  // Writers that can run in parallel (no dependency path) must not share an owned path.
  const reach = (a: string, b: string, seen = new Set<string>()): boolean => {
    if (a === b) return true
    if (seen.has(a)) return false
    seen.add(a)
    return o.plan!.tasks.find((t) => t.id === a)!.depends_on.some((d) => reach(d, b, seen))
  }
  const writers = o.plan.tasks.filter((t) => t.role === 'implement')
  for (let i = 0; i < writers.length; i++) for (let j = i + 1; j < writers.length; j++) {
    const a = writers[i], b = writers[j]
    if (a.project !== b.project || reach(a.id, b.id) || reach(b.id, a.id)) continue
    const shared = a.owns.find((x) => b.owns.includes(x))
    if (shared) return `병렬 작업 ${a.id}와 ${b.id}가 같은 경로 ${shared}를 소유합니다`
  }
  return null
}

export interface TurnInput { request: string; answers: { question: string; answer: string }[]; correction: string | null; project: Project; projects: Project[]; resumeSessionId: string | null; hqRoot: string }

export function runCeoTurn(input: TurnInput): Promise<CeoTurn> {
  const rules = readFileSync(resolve(input.hqRoot, 'skills/ceo.md'), 'utf8')
  const sessionId = input.resumeSessionId ?? randomUUID()
  const prompt = [
    rules,
    '## 등록된 프로젝트',
    ...input.projects.map((p) => `- ${p.id}: ${p.name} (${p.path})`),
    `기본 대상 프로젝트: ${input.project.id}`,
    '## 회장의 요청',
    input.request,
    ...(input.answers.length ? ['## 회장이 답한 질문', ...input.answers.map((a) => `- ${a.question} → ${a.answer}`)] : []),
    ...(input.correction ? ['## 이전 출력이 거부된 이유 (고쳐서 다시 내라)', input.correction] : []),
  ].join('\n')
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(CEO_SCHEMA),
    '--tools', 'Read,Glob,Grep', '--disallowedTools', 'Read(**/.env*)',
    '--setting-sources', '', '--strict-mcp-config', '--max-turns', '30',
    ...input.projects.filter((p) => p.id !== input.project.id).flatMap((p) => ['--add-dir', p.path]),
    ...(input.resumeSessionId ? ['--resume', sessionId] : ['--session-id', sessionId])]
  const env = { ...process.env }
  delete env.CLAUDECODE
  return new Promise((done) => {
    const child = spawn('claude', args, { cwd: input.project.path, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => child.kill('SIGINT'), 15 * 60_000)
    child.stdout.on('data', (b: Buffer) => { if (out.length < 2_000_000) out += b })
    child.stderr.on('data', (b: Buffer) => { if (err.length < 20_000) err += b })
    child.stdin.end(prompt)
    child.on('close', () => {
      clearTimeout(timer)
      let r: Record<string, unknown> | null = null
      try { r = JSON.parse(out) } catch { /* fallthrough */ }
      const text = r ? String(r.result ?? '') : (err || out).slice(0, 500)
      const limited = LIMIT_RE.test(text)
      const so = r?.structured_output as CeoOutput | undefined
      const cost = typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null
      if (!r || r.is_error || !so) return done({ ok: false, output: null, sessionId, error: text || '출력 없음', limited, costUsd: cost })
      done({ ok: true, output: so, sessionId: typeof r.session_id === 'string' ? r.session_id : sessionId, error: null, limited: false, costUsd: cost })
    })
  })
}
