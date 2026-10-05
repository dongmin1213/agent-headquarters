// Screen data: decision items (§17), headline (§18), worker/task views (§19).
import { join } from 'node:path'
import type { Store, TaskRow, AttemptRow, ApprovalRow } from '../store.ts'
import type { DecisionItem, Headline, TaskView, WorkerView } from '../types.ts'
import type { QuotaState } from './quota.ts'
import { lastActivityOf } from './stream.ts'
import { explainError } from '../humanize.ts'

const ORDER: DecisionItem['kind'][] = ['system', 'plan', 'ceo_question', 'worker_question', 'revise', 'blocked', 'integration', 'accept', 'merge', 'team']
export const BLOCKED_OPTIONS = ['retry', 'skip', 'stop']
/** Extra blocked option while an earlier worker may still run: forget it (no signal), then retry. */
export const RELEASE = 'release'
export const BLOCKED_OPTIONS_LINGERING = ['retry', RELEASE, 'skip', 'stop']

function approvalRequestId(store: Store, a: ApprovalRow): string {
  if (a.subjectId) return a.subjectId
  const [, rest] = a.id.split(/:(.*)/s)
  if (a.kind === 'revise') return store.task(rest)?.request_id ?? ''
  return (rest ?? '').split(':')[0]
}

/** Fixed option texts (execution.md §17). */
export const OPTION_HELP: Record<string, string> = {
  retry: '같은 작업을 같은 모델로 한 번 더 해요 · 사용량이 들어요',
  skip: '이 작업과 여기에 의존하는 작업을 빼고 계속해요 · 나중에 새 요청으로 다시 할 수 있어요',
  stop: '요청 전체를 멈춰요 · 만든 브랜치는 남겨 둬요',
  release: '이전 작업자를 끝난 것으로 보고 새 시도를 허용해요 · 신호는 보내지 않아요',
  수락: '통합본을 병합 대기로 넘겨요 · 병합은 따로 승인해요',
  반려: '사유를 붙여 다시 작업시켜요',
  병합: '대상 브랜치에 fast-forward로 반영해요',
  보류: '지금은 병합하지 않고 둬요 · 나중에 다시 제시할 수 있어요',
}
const PLAN_HELP = { 승인: '계획대로 작업을 시작해요 · 사용량이 들어요', 반려: '계획을 버리고 이 요청을 끝내요' }
const REVISE_HELP = { 승인: '고친 지시서로 이 작업을 다시 해요 · 사용량이 들어요', 반려: '수정안을 버리고 이 작업을 막힘 상태로 둬요 · 다음 결정은 막힘 카드에서 해요' }
const INTEGRATION_HELP = { '다시 통합': '대상 브랜치의 최신 커밋 위에서 합치기와 검사를 다시 해요 · 사용량은 들지 않아요', '해당 작업 재작업': '문제가 된 작업을 대상 브랜치의 최신 커밋 위에서 처음부터 다시 해요 · 사용량이 들어요', '요청 중단': OPTION_HELP.stop }
const ACCEPT_KNOWN = '기존 실패로 인정하고 진행'
function integrationHelp(store: Store, requestId: string, project: string, options: string[]): Record<string, string> {
  if (!options.includes(ACCEPT_KNOWN)) return INTEGRATION_HELP
  let sha = '?'
  try { sha = (JSON.parse(store.get(`integration.known:${requestId}:${project}`) ?? '{}') as { sha?: string }).sha?.slice(0, 10) ?? '?' } catch { /* shown as ? */ }
  return { ...INTEGRATION_HELP, [ACCEPT_KNOWN]: `이 검사들은 작업 전부터 실패했고 검토자가 악화 없음으로 판정했어요 · 통합본(${sha})을 그대로 병합 단계로 넘겨요` }
}
const SYSTEM_HELP = { '다시 확인': '로그인 후 누르면 다음 작업부터 다시 시도해요' }
const LOGIN_RECOMMENDATION = { option: '다시 확인', reason: "터미널에서 codex login으로 로그인한 뒤 '다시 확인'을 눌러 주세요" }
/** Inline confirm for choices that cannot be undone (web and pet ask once more before sending). */
export const CONFIRM_STOP = '정말 중단할까요? · 되돌릴 수 없어요'
export const confirmMerge = (target: string) => `${target}에 병합할까요?`
/** Keeps the raw text next to the card body so "원문 보기" always has it. */
const withRaw = (body: string, raw: string) => (!raw || body.includes(raw) ? body : body ? `${body}\n\n${raw}` : raw)
const teamOptionHelp = (o: string) => o === '보류' ? '지금은 고르지 않아요 · 팀이 나중에 다시 물어요' : o === '반려' ? '팀이 이 항목을 진행하지 않아요' : '이 선택으로 팀이 다음 단계를 진행해요'

export const detailPath = (requestId: string, taskId: string | null) => `/ui/#request=${encodeURIComponent(requestId)}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}`

/** A possibly still running earlier worker of a task (its identity could not be confirmed), or null. */
export interface Lingering { pid: number; lstart: string | null; since: string }
export function lingeringOf(t: Pick<TaskRow, 'lingering'>): Lingering | null {
  if (!t.lingering) return null
  try { const l = JSON.parse(t.lingering) as Lingering; return l && l.pid > 0 ? l : null } catch { return null }
}
export const lingeringWait = (pid: number) => `이전 작업자(pid ${pid})가 끝나기를 기다려요`
export const lingeringKillHint = (pid: number) => `직접 종료하려면: kill -TERM -${pid} (프로세스 그룹)`
/** kv key of the last `ps` look at a lingering pid: `{ lingering, ps, ours }` (written by the runner each poll). */
export const lingeringPsKey = (taskId: string) => `lingering.ps:${taskId}`
export interface LingeringPs { lingering: string; ps: string | null; ours: boolean }
export const LINGERING_PS_UNKNOWN = '확인할 수 없음'
export const LINGERING_NOT_OURS = '작업자 명령으로 보이지 않아 종료 방법은 안내하지 않아요 · 다른 프로그램일 수 있어요'

/** Card lines for a lingering pid: the `ps` line (or 확인할 수 없음) and the kill hint only when it looks like our worker. */
function lingeringDetail(store: Store, t: TaskRow, l: Lingering): string[] {
  let seen: LingeringPs | null = null
  try { const v = JSON.parse(store.get(lingeringPsKey(t.id)) ?? 'null') as LingeringPs | null; if (v && v.lingering === t.lingering) seen = v } catch { /* unknown */ }
  const lines = [`이전 작업자 프로세스 (ps -o pid=,lstart=,command= -p ${l.pid}):`, seen?.ps ? seen.ps.slice(0, 500) : LINGERING_PS_UNKNOWN]
  if (seen?.ps && seen.ours) lines.push(lingeringKillHint(l.pid))
  else if (seen?.ps) lines.push(LINGERING_NOT_OURS)
  return lines
}
/** Statuses in which a task waits for a slot; a gated one waits for its earlier worker instead. */
const QUEUED = new Set(['pending', 'rework', 'held'])

const firstLine = (s: string | null) => (s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 300) ?? ''

type Explain = Pick<DecisionItem, 'situation' | 'cause' | 'causeConfirmed' | 'recommendation' | 'optionHelp'>

function answerHelp(options: string[], def: string): Record<string, string> {
  return Object.fromEntries(options.map((o) => [o, o === def ? '이 답으로 이어서 진행해요 (추천 기본값)' : '이 답으로 이어서 진행해요']))
}

/** A stored CEO diagnosis if there is a valid one for this occurrence, otherwise hq's own fact sentences. */
function diagnosed(raw: string | null, options: string[], fallback: Explain): Explain {
  if (!raw) return fallback
  try {
    const s = JSON.parse(raw) as { ok: boolean; d?: { situation: string; cause: string; causeConfirmed: boolean; recommendation: { option: string; reason: string } } }
    if (!s.ok || !s.d || !options.includes(s.d.recommendation.option)) return fallback
    return { ...fallback, situation: s.d.situation, cause: s.d.cause, causeConfirmed: s.d.causeConfirmed, recommendation: s.d.recommendation }
  } catch { return fallback }
}

/** "수익자동화" → "수익자동화 팀"; a name already ending in 팀 is kept as is. */
export const teamLabel = (name: string): string => (/팀$/.test(name) ? name : `${name} 팀`)

export function decisionItems(store: Store, now = Date.now(), teamNames: Record<string, string> = {}): DecisionItem[] {
  const items: DecisionItem[] = []
  for (const a of store.openApprovals(now)) {
    if (a.kind === 'team') {
      const name = teamNames[a.teamId] ?? a.teamId
      const lead = firstLine(a.body)
      items.push({ kind: 'team', teamId: a.teamId, id: a.id, revision: a.revision, requestId: '', taskId: null, title: `${name} · ${a.title}`, detail: a.body,
        situation: lead ? `${teamLabel(name)}: ${lead}` : `${teamLabel(name)}이 회장님 결정을 기다려요`, cause: null, causeConfirmed: false, recommendation: null,
        optionHelp: Object.fromEntries(a.options.map((o) => [o, teamOptionHelp(o)])), detailPath: null, options: a.options, subjectHash: a.subjectHash, createdAt: a.createdAt })
      continue
    }
    if (!['system', 'plan', 'revise', 'integration', 'accept', 'merge'].includes(a.kind)) continue
    const requestId = approvalRequestId(store, a)
    const taskId = a.kind === 'revise' ? a.id.slice('revise:'.length) : null
    let ex: Explain
    let detail = a.body
    let confirm: Record<string, string> | undefined
    if (a.kind === 'system') {
      ex = { situation: 'Codex CLI에 로그인되어 있지 않아 모든 작업을 멈췄어요', cause: a.body ? explainError(a.body).cause : 'Codex CLI가 로그인되어 있지 않다고 답했어요', causeConfirmed: true,
        recommendation: a.options.includes(LOGIN_RECOMMENDATION.option) ? LOGIN_RECOMMENDATION : null, optionHelp: SYSTEM_HELP }
    } else if (a.kind === 'plan') {
      const plan = store.request(requestId)?.plan
      const n = plan ? (JSON.parse(plan).tasks as unknown[]).length : 0
      ex = { situation: `사장이 작업 ${n}개짜리 계획을 올렸어요 · 실행할 명령과 범위를 확인해 주세요`, cause: null, causeConfirmed: false, recommendation: null, optionHelp: PLAN_HELP }
    } else if (a.kind === 'revise') {
      const t = store.task(taskId!)
      ex = { situation: `작업자가 '${t?.title ?? '작업'}' 작업을 지시서대로 할 수 없다고 멈췄고, 사장이 지시서를 고쳤어요 · 범위나 검사 명령이 바뀌어 승인이 필요해요`,
        cause: firstLine(t?.note ?? null) || null, causeConfirmed: true, recommendation: null, optionHelp: REVISE_HELP }
    } else if (a.kind === 'integration') {
      const project = a.id.split(':')[2]
      const m = store.mergeRow(requestId, project)
      const raw = m?.note ?? a.body
      detail = withRaw(a.body, m?.note ?? '')
      ex = diagnosed(m?.diagnosis ?? null, a.options, { situation: `프로젝트 ${project}의 결과를 대상 브랜치 위에 합치다 문제가 생겼어요`,
        cause: raw ? explainError(raw).cause : null, causeConfirmed: true, recommendation: null, optionHelp: integrationHelp(store, requestId, project, a.options) })
      if (a.options.includes('요청 중단')) confirm = { '요청 중단': CONFIRM_STOP }
    } else if (a.kind === 'accept') {
      const passed = store.tasks(requestId).filter((t) => t.status === 'passed').length
      ex = { situation: `작업 ${passed}개가 검사·검토를 통과했어요 · 결과를 확인하고 수락해 주세요`, cause: null, causeConfirmed: false, recommendation: null,
        optionHelp: { 수락: OPTION_HELP.수락, 반려: OPTION_HELP.반려 } }
    } else {
      const project = a.id.split(':')[2]
      const m = store.mergeRow(requestId, project)
      const files = store.tasks(requestId).filter((t) => t.project === project && t.role === 'implement' && t.status === 'passed').length
      ex = { situation: `${m?.target ?? '대상 브랜치'} (${m?.target_sha?.slice(0, 10) ?? '?'})에 작업 ${files}개의 통합본(${m?.integration_sha?.slice(0, 10) ?? '?'})을 반영할 준비가 됐어요`,
        cause: m?.note ?? null, causeConfirmed: !!m?.note, recommendation: null, optionHelp: { 병합: OPTION_HELP.병합, 보류: OPTION_HELP.보류 } }
      if (a.options.includes('병합')) confirm = { 병합: confirmMerge(m?.target ?? '대상 브랜치') }
    }
    items.push({ kind: a.kind as DecisionItem['kind'], id: a.id, revision: a.revision, requestId: a.kind === 'system' ? '' : requestId, taskId, title: a.title, detail, ...ex,
      ...(confirm ? { confirm } : {}), detailPath: a.kind === 'system' ? null : detailPath(requestId, taskId), options: a.options, subjectHash: a.subjectHash, createdAt: a.createdAt })
  }
  for (const r of store.requestsByStatus(['asking'])) for (const q of store.questions(r.id)) {
    if (q.answer !== null) continue
    items.push({ kind: 'ceo_question', id: q.id, revision: 0, requestId: r.id, taskId: null, title: q.question, detail: q.reason,
      situation: `사장이 계획을 세우기 전에 물어볼 게 있어요: ${q.question}`, cause: q.reason, causeConfirmed: false,
      recommendation: q.options.includes(q.default) ? { option: q.default, reason: '사장이 추천한 기본값이에요' } : null, optionHelp: answerHelp(q.options, q.default),
      detailPath: detailPath(r.id, null), options: q.options, subjectHash: null, createdAt: r.updated_at })
  }
  for (const t of store.tasksByStatus(['question'])) for (const q of store.taskQuestions(t.id)) {
    if (q.answer !== null || q.revision !== t.revision) continue
    // CEO revise-turn questions (attempt id `ceo-revise:…`) are answered through the same task question path.
    const ceo = q.attempt_id?.startsWith('ceo-revise:') ?? false
    items.push({ kind: 'worker_question', ...(ceo ? { label: '사장 질문' } : {}), id: q.id, revision: t.revision, requestId: t.request_id, taskId: t.id, title: `${t.title}: ${q.question}`, detail: `기본값: ${q.default}`,
      situation: ceo ? `사장이 '${t.title}' 지시서를 고치려면 회장님 답이 필요해요: ${q.question}` : `작업자가 '${t.title}' 작업 중에 물어볼 게 있어요: ${q.question}`,
      cause: firstLine(t.note) || null, causeConfirmed: false,
      recommendation: q.options.includes(q.default) ? { option: q.default, reason: ceo ? '사장이 추천한 기본값이에요' : '작업자가 제안한 기본값이에요' } : null, optionHelp: answerHelp(q.options, q.default),
      detailPath: detailPath(t.request_id, t.id), options: q.options, subjectHash: null, createdAt: q.created_at })
  }
  for (const t of store.tasksByStatus(['blocked'])) {
    const ling = lingeringOf(t)
    const options = ling ? BLOCKED_OPTIONS_LINGERING : BLOCKED_OPTIONS
    const ex = diagnosed(t.diagnosis, options, { situation: `작업이 막혔어요: ${t.title} · 어떻게 할지 정해 주세요`, cause: t.note ? explainError(t.note).cause : null, causeConfirmed: true, recommendation: null,
      optionHelp: Object.fromEntries(options.map((o) => [o, OPTION_HELP[o]])) })
    const detail = ling ? [t.note ?? '', ...lingeringDetail(store, t, ling)].filter(Boolean).join('\n') : t.note ?? ''
    items.push({ kind: 'blocked', id: t.id, revision: t.block_count, requestId: t.request_id, taskId: t.id, title: `작업이 막혔어요: ${t.title}`, detail, ...ex, confirm: { stop: CONFIRM_STOP },
      detailPath: detailPath(t.request_id, t.id), options, subjectHash: null, createdAt: t.updated_at })
  }
  return items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.createdAt.localeCompare(b.createdAt))
}

export const MERGE_UNCHANGED = '대상 브랜치가 검사한 뒤로 바뀌지 않았어요'
/**
 * §17 recommendation on merge cards, only where hq can state the fact: the target branch still points at the
 * commit the integration was checked on. `targetSha(project, branch)` reads the user's checkout now (null = unknown).
 */
export function recommendMerges(items: DecisionItem[], store: Store, targetSha: (project: string, branch: string) => string | null): DecisionItem[] {
  return items.map((d) => {
    if (d.kind !== 'merge' || d.recommendation || !d.options.includes('병합')) return d
    const m = store.mergeRow(d.requestId, d.id.split(':')[2] ?? '')
    if (!m?.target || !m.target_sha) return d
    const now = targetSha(m.project, m.target)
    return now && now === m.target_sha ? { ...d, recommendation: { option: '병합', reason: MERGE_UNCHANGED } } : d
  })
}

export function currentAttempt(store: Store, taskId: string): AttemptRow | null { return store.attempts(taskId).at(-1) ?? null }

export const hqDirOf = (a: AttemptRow) => join(a.dir, 'hq')
export const outDirOf = (a: AttemptRow) => join(a.dir, 'out')

/** Bubble of a queued task that may not start while its earlier worker may still run. */
function waitingFor(t: TaskRow): string | null {
  const l = QUEUED.has(t.status) ? lingeringOf(t) : null
  return l ? lingeringWait(l.pid) : null
}

export function taskView(store: Store, t: TaskRow, activity: (a: AttemptRow) => string | null = (a) => lastActivityOf(hqDirOf(a))): TaskView {
  const cur = currentAttempt(store, t.id)
  return {
    id: t.id, key: t.key, requestId: t.request_id, project: t.project, title: t.title, role: t.role, grade: t.grade, model: t.model,
    status: t.status as TaskView['status'], attempts: t.attempts, currentAttemptId: cur?.id ?? null,
    lastActivity: waitingFor(t) ?? (cur ? activity(cur) : null),
    questions: t.status === 'question' ? store.taskQuestions(t.id).filter((q) => q.revision === t.revision && q.answer === null).map((q) => ({ id: q.id, question: q.question, options: q.options, default: q.default })) : [],
    note: t.note, headSha: t.head_sha, revision: t.revision, reviewModel: t.review_model, updatedAt: t.updated_at,
  }
}

export const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

export function workerViews(store: Store, activity: (a: AttemptRow) => string | null = (a) => lastActivityOf(hqDirOf(a)), holdUntil: string | null = null): WorkerView[] {
  const out: WorkerView[] = []
  for (const a of store.liveAttempts()) {
    const t = store.task(a.task_id)
    if (!t) continue
    const review = a.kind === 'review'
    out.push({ attemptId: a.id, taskId: t.id, requestId: t.request_id, title: t.title, project: t.project, role: t.role, model: a.model,
      kind: review ? 'review' : 'work', state: review ? 'reviewing' : 'running', bubble: activity(a) ?? (review ? '검토 준비 중' : '준비 중'), startedAt: a.started_at ?? t.updated_at })
  }
  for (const t of store.tasksByStatus(['verifying', 'held', 'blocked', 'pending', 'rework'])) {
    const waiting = waitingFor(t)
    if ((t.status === 'pending' || t.status === 'rework') && !waiting) continue
    const last = store.attempts(t.id).at(-1)
    const base = { attemptId: last?.id ?? '', taskId: t.id, requestId: t.request_id, title: t.title, project: t.project, role: t.role, startedAt: t.updated_at }
    if (waiting) out.push({ ...base, model: t.model, kind: 'work', state: 'held', bubble: waiting })
    else if (t.status === 'verifying') out.push({ ...base, attemptId: store.attempts(t.id).filter((x) => x.kind === 'work').at(-1)?.id ?? '', model: 'hq', kind: 'verify', state: 'verifying', bubble: '수용 기준 검사 중' })
    else if (t.status === 'held') out.push({ ...base, model: t.model, kind: 'work', state: 'held', bubble: holdUntil ? `한도 보류 · ${hhmm(holdUntil)}까지` : '한도 보류' })
    else out.push({ ...base, model: t.model, kind: last?.kind === 'review' ? 'review' : 'work', state: 'blocked', bubble: '막힘 · 사장에게 보고' })
  }
  return out
}

const WINDOW_NAMES: Record<string, string> = { five_hour: '5시간', seven_day: '7일', seven_day_opus: '7일(opus)', seven_day_sonnet: '7일(sonnet)', team: '팀' }

export interface HeadlineInput {
  decisions: DecisionItem[]
  /** Blocked requests without a decision item (§18 장애). */
  failures: { title: string; reason: string }[]
  workers: WorkerView[]
  ceoThinking: boolean
  /** Tasks ready to start but waiting for a slot or the quota. */
  waiting: number
  quota: QuotaState
  /** Request merged within the last 10 minutes. */
  recentMerged: string | null
  /** For a verify worker: whether an LLM review follows. */
  reviewFollows?: (taskId: string) => boolean
  /** Recurring teams (scheduler views). */
  teams?: { name: string; state: string; bubble: string }[]
}

export function buildHeadline(h: HeadlineInput): Headline {
  const needsYou = h.decisions.length
  if (needsYou) return { text: `회장님 결정 ${needsYou}건: ${h.decisions[0].title}`, needsYou }
  if (h.failures.length) return { text: `막혔어요 · ${h.failures[0].title}: ${h.failures[0].reason.split('\n')[0].slice(0, 80)}`, needsYou }
  const active = h.workers.filter((w) => w.state !== 'held' && w.state !== 'blocked')
  if (active.length) {
    const w = active[0]
    const verb = w.kind === 'review' ? '검토' : w.kind === 'verify' ? '검증' : '구현'
    const next = w.kind === 'work' ? (w.role === 'collect' ? '결과 수락' : '검증') : w.kind === 'verify' ? (h.reviewFollows?.(w.taskId) === false ? '통합' : '검토') : '통합'
    return { text: `${w.title} ${verb} 중 · ${w.model} · 다음: ${next}${active.length > 1 ? ` 외 ${active.length - 1}명` : ''}`, needsYou }
  }
  if (h.ceoThinking) return { text: '사장이 계획 중이에요', needsYou }
  const teams = h.teams ?? []
  const failed = teams.find((t) => t.state === 'error')
  if (failed) return { text: `${teamLabel(failed.name)} 오류: ${failed.bubble.slice(0, 80)}`, needsYou }
  const working = teams.filter((t) => t.state === 'working')
  if (working.length) return { text: `${working[0].name}: ${working[0].bubble}${working.length > 1 ? ` 외 ${working.length - 1}팀` : ''}`, needsYou }
  const held = h.workers.some((w) => w.state === 'held')
  if (h.quota.mode === 'hold' && (h.waiting > 0 || held) && h.quota.until) {
    const pct = Math.round((h.quota.pct ?? 1) * 100)
    return { text: `사용 한도 ${WINDOW_NAMES[h.quota.window ?? ''] ?? h.quota.window ?? ''} ${pct}% — ${hhmm(h.quota.until)}까지 쉬어요`, needsYou }
  }
  if (h.waiting > 0) return { text: h.quota.mode === 'unobserved' ? '한도 관측 전이라 하나씩 실행 중' : `빈 자리 기다리는 중 (${h.waiting}건)`, needsYou }
  if (h.recentMerged) return { text: `병합 완료: ${h.recentMerged}`, needsYou }
  return { text: '지금 하실 일은 없어요', needsYou }
}
