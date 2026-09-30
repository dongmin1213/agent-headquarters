// Shared shapes. The pet reads Snapshot from GET /api/state and Event from GET /api/events.

export type TeamState = 'idle' | 'working' | 'waiting' | 'sleeping' | 'error'

export interface TeamConfig {
  id: string
  name: string
  /** Sprite pack the pet uses for this team (e.g. "digimon", "pokemon"). */
  pack: string
  /** Command run on each tick; its exit code decides the next state (see Scheduler). */
  command: string[]
  cwd: string
  everyMinutes: number
  enabled: boolean
}

export interface RunRecord {
  id: number
  teamId: string
  startedAt: string
  endedAt: string | null
  exitCode: number | null
  summary: string | null
}

export interface Approval {
  id: string
  teamId: string
  title: string
  body: string
  options: string[]
  /** Hash of the exact artifact/arguments being approved; a changed subject needs a new approval. */
  subjectHash: string
  /** ISO time after which the approval can no longer be decided (fails closed). */
  expiresAt: string
  createdAt: string
  decision: string | null
  decidedAt: string | null
}

export interface TeamView {
  id: string
  name: string
  pack: string
  state: TeamState
  bubble: string
  lastRun: RunRecord | null
  nextRunAt: string | null
}

export interface RequestView {
  id: string
  project: string
  text: string
  /** queued | thinking | asking | planned | approved | executing | awaiting_acceptance | accepted | merging | merged | rejected | failed | blocked | cancelled */
  status: string
  note: string | null
  turns: number
  costUsd: number
  questions: { id: string; question: string; options: string[]; default: string; reason: string; answer: string | null }[]
  plan: { summary: string; assumptions: string[]; tasks: { id: string; title: string; project: string; role: string; grade: string; model: string }[] } | null
  /** Execution state per plan task (empty until the plan is approved). */
  tasks: TaskView[]
  updatedAt: string
}

export type TaskStatus = 'pending' | 'running' | 'verifying' | 'reviewing' | 'passed' | 'rework' | 'question' | 'held' | 'blocked' | 'cancelled'
export type AttemptStatus = 'starting' | 'running' | 'succeeded' | 'failed' | 'question' | 'limited' | 'runaway' | 'unverifiable' | 'start_failed'

export interface TaskView {
  /** "<requestId>/<taskKey>" */
  id: string
  key: string
  requestId: string
  project: string
  title: string
  role: string
  grade: string
  model: string
  status: TaskStatus
  attempts: number
  /** Latest attempt id (work or review), for activity/evidence lookups. */
  currentAttemptId: string | null
  /** Last human-readable activity line of the current attempt. */
  lastActivity: string | null
  /** Worker questions waiting for the chairman (status = question). */
  questions: { question: string; options: string[]; default: string }[]
  note: string | null
  headSha: string | null
  updatedAt: string
}

export interface AttemptView {
  id: string
  taskId: string
  kind: 'work' | 'review'
  n: number
  model: string
  status: AttemptStatus
  startedAt: string | null
  endedAt: string | null
  costUsd: number | null
  reason: string | null
}

export interface CheckResult { id: string; command: string; exitCode: number | null; durationMs: number; pass: boolean; outputTail: string }
export interface Verdict {
  pass: boolean
  blocking: { id: string; summary: string; evidence: string }[]
  advisory: { id: string; summary: string }[]
  criteria: { id: string; result: 'pass' | 'fail' | 'manual'; evidence: string }[]
  tests_run: { command: string; exit_code: number; summary: string }[]
  /** Filled by hq, never by the reviewer. */
  task?: string; head_sha?: string; base_sha?: string; reviewer_model?: string; implementer_model?: string; sameFamily?: boolean
}

/** GET /api/requests/:id */
export interface RequestDetail {
  request: RequestView
  tasks: (TaskView & { spec: unknown; branch: string | null; baseSha: string | null; attemptsList: AttemptView[] })[]
}

/** One character on the pet per live attempt. */
export interface WorkerView {
  attemptId: string
  taskId: string
  requestId: string
  title: string
  project: string
  role: string
  /** Model alias used for the character (haiku | sonnet | opus). */
  model: string
  kind: 'work' | 'review' | 'verify'
  state: 'running' | 'verifying' | 'reviewing' | 'held'
  bubble: string
  startedAt: string
}

export interface Headline { text: string; needsYou: number }

export interface QuotaView {
  fiveHour: number | null
  sevenDay: number | null
  fiveHourResetsAt: string | null
  sevenDayResetsAt: string | null
  /** normal | save | review_only | hold */
  mode: string
  observedAt: string | null
}

export interface Snapshot {
  updatedAt: string
  /** Last event id; the pet re-fetches the snapshot when it reconnects instead of replaying missed events. */
  lastEventId: number
  teams: TeamView[]
  approvals: Approval[]
  requests: RequestView[]
  projects: { id: string; name: string }[]
  limit: { blockedUntil: string | null }
  workers: WorkerView[]
  headline: Headline
  quota: QuotaView | null
}

export interface HqEvent {
  id?: number
  at: string
  kind: 'team' | 'claude' | 'approval' | 'limit' | 'request' | 'task' | 'attempt' | 'quota'
  teamId?: string
  text: string
  data?: unknown
}
