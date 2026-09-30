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

/** Extra hold sources besides window rows: the resetsAt-less limit back-off timer and a missing Claude login (§13). */
export interface HoldTimers { backoffUntil?: string | null; loginRequired?: boolean }

/**
 * Mode from the window rows. `rejected` comes from the top-level rate_limit_info.status of the named window
 * (overageStatus is never a signal). A rejection without resetsAt holds nothing here: the back-off timer covers it.
 */
export function quotaState(rows: QuotaRow[], limits: HqConfig['quota'], now: number, timers: HoldTimers = {}): QuotaState {
  if (timers.loginRequired) return { mode: 'hold', until: null, window: 'login', pct: null }
  const live = liveRows(rows, now)
  const blocking = live.filter((r) => r.resets_at && Date.parse(r.resets_at) > now && (r.status === 'rejected' || (r.utilization ?? 0) >= limits.holdAt))
  const holds = blocking.map((r) => ({ until: r.resets_at!, window: r.window, pct: r.utilization }))
  if (timers.backoffUntil && Date.parse(timers.backoffUntil) > now) holds.push({ until: timers.backoffUntil, window: 'limit', pct: null })
  if (holds.length) {
    const last = holds.sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0]
    return { mode: 'hold', until: last.until, window: last.window, pct: last.pct }
  }
  if (!live.length) return { mode: 'unobserved', until: null, window: null, pct: null }
  const top = [...live].sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0]
  return { mode: (top.utilization ?? 0) >= limits.saveAt ? 'save' : 'normal', until: null, window: top.window, pct: top.utilization }
}

/** True for a rejection that names no reset time anywhere (the caller starts the 15/30/60-minute back-off). */
export function rejectedWithoutReset(line: Record<string, unknown>): boolean {
  if (line.type !== 'rate_limit_event') return false
  const info = line.rate_limit_info as Record<string, unknown> | undefined
  if (!info || info.status !== 'rejected') return false
  if (typeof info.resetsAt === 'number') return false
  const w = (info.unifiedWindows ?? {}) as Record<string, Record<string, unknown> | undefined>
  const named = typeof info.rateLimitType === 'string' ? w[info.rateLimitType] : undefined
  return typeof named?.resetsAt !== 'number'
}

export const isAllowedEvent = (line: Record<string, unknown>) => line.type === 'rate_limit_event' && (line.rate_limit_info as Record<string, unknown> | undefined)?.status === 'allowed'

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
