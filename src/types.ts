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
  /** queued | thinking | asking | planned | approved | rejected | failed */
  status: string
  note: string | null
  turns: number
  costUsd: number
  questions: { id: string; question: string; options: string[]; default: string; reason: string; answer: string | null }[]
  plan: { summary: string; assumptions: string[]; tasks: { id: string; title: string; project: string; role: string; grade: string; model: string }[] } | null
  updatedAt: string
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
}

export interface HqEvent {
  id?: number
  at: string
  kind: 'team' | 'claude' | 'approval' | 'limit' | 'request'
  teamId?: string
  text: string
  data?: unknown
}
