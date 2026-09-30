// Subscription quota from stream-json `rate_limit_event` lines, one row per window (execution.md §13).
// The quota table is the only source of truth for holding new starts (workers, reviewers, CEO turns, teams).
import type { HqConfig } from '../config.ts'
import type { QuotaRow, Store } from '../store.ts'
import type { QuotaView } from '../types.ts'

export type QuotaMode = 'normal' | 'save' | 'hold' | 'unobserved'
export interface QuotaState {
  mode: QuotaMode
  /** Hold end (ISO): the latest reset among blocking windows. */
  until: string | null
  /** Window that decided the mode. */
  window: string | null
  pct: number | null
}

const HOLD_FALLBACK_MS = 60 * 60_000
const iso = (sec: unknown) => (typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Window rows carried by one rate_limit_event line (empty if the line is not one). */
export function quotaFromEvent(line: Record<string, unknown>, now: number): QuotaRow[] {
  if (line.type !== 'rate_limit_event') return []
  const info = line.rate_limit_info as Record<string, unknown> | undefined
  if (!info || typeof info !== 'object') return []
  const at = new Date(now).toISOString()
  const named = typeof info.rateLimitType === 'string' ? info.rateLimitType : null
  const status = typeof info.status === 'string' ? info.status : null
  const wins = (info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {}) as Record<string, Record<string, unknown> | undefined>
  const rows: QuotaRow[] = Object.entries(wins).filter(([, w]) => w && typeof w === 'object').map(([name, w]) => ({
    window: name, utilization: num(w!.utilization), resets_at: iso(w!.resetsAt) ?? (name === named ? iso(info.resetsAt) : null),
    status: name === named ? status : null, observed_at: at,
  }))
  const target = named ?? (status === 'rejected' ? 'unknown' : null)
  if (target && !rows.some((r) => r.window === target)) rows.push({ window: target, utilization: null, resets_at: iso(info.resetsAt), status, observed_at: at })
  return rows
}

export function recordRateLimit(store: Store, line: Record<string, unknown>, now: number): boolean {
  const rows = quotaFromEvent(line, now)
  for (const r of rows) store.setQuotaWindow(r)
  return rows.length > 0
}

/** Windows whose reset time has passed say nothing about the present. */
const liveRows = (rows: QuotaRow[], now: number) => rows.filter((r) => !(r.resets_at && Date.parse(r.resets_at) <= now))

export function quotaState(rows: QuotaRow[], limits: HqConfig['quota'], now: number): QuotaState {
  const live = liveRows(rows, now)
  if (!live.length) return { mode: 'unobserved', until: null, window: null, pct: null }
  const blocking = live.map((r) => ({ r, until: r.resets_at ?? new Date(Date.parse(r.observed_at) + HOLD_FALLBACK_MS).toISOString() }))
    .filter(({ r, until }) => (r.status === 'rejected' || (r.utilization ?? 0) >= limits.holdAt) && Date.parse(until) > now)
  if (blocking.length) {
    const last = blocking.sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0]
    return { mode: 'hold', until: last.until, window: last.r.window, pct: last.r.utilization }
  }
  const top = [...live].sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0]
  const mode: QuotaMode = (top.utilization ?? 0) >= limits.saveAt ? 'save' : 'normal'
  return { mode, until: null, window: top.window, pct: top.utilization }
}

export function quotaView(rows: QuotaRow[], s: QuotaState, now: number): QuotaView | null {
  if (!rows.length) return null
  const live = liveRows(rows, now)
  const w = (n: string) => live.find((r) => r.window === n)
  return {
    windows: live.map((r) => ({ name: r.window, utilization: r.utilization, resetsAt: r.resets_at, status: r.status })),
    fiveHour: w('five_hour')?.utilization ?? null, sevenDay: w('seven_day')?.utilization ?? null,
    fiveHourResetsAt: w('five_hour')?.resets_at ?? null, sevenDayResetsAt: w('seven_day')?.resets_at ?? null,
    mode: s.mode, observedAt: rows.map((r) => r.observed_at).sort().at(-1) ?? null,
  }
}
