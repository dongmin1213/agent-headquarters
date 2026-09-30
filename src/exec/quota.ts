// Subscription quota tracking from stream-json `rate_limit_event` lines (docs/design/execution.md §10).
import type { HqConfig } from '../config.ts'
import type { QuotaRow } from '../store.ts'
import type { QuotaView } from '../types.ts'

export type QuotaMode = 'normal' | 'save' | 'review_only' | 'hold'
export interface QuotaState {
  mode: QuotaMode
  /** When a hold ends (ISO), if holding. */
  until: string | null
  /** Window that decided the mode (five_hour | seven_day | limit). */
  window: string | null
  /** Utilization (0..1) of that window. */
  pct: number | null
  /** False until the first rate_limit_event was seen. */
  observed: boolean
}

const HOLD_FALLBACK_MS = 60 * 60_000
const iso = (sec: unknown) => (typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Converts one rate_limit_event line into a quota row; null if the line is not one. */
export function quotaFromEvent(line: Record<string, unknown>, prev: QuotaRow | null, now = new Date()): QuotaRow | null {
  if (line.type !== 'rate_limit_event') return null
  const info = line.rate_limit_info as Record<string, unknown> | undefined
  if (!info || typeof info !== 'object') return null
  const w = (info.unifiedWindows ?? {}) as Record<string, Record<string, unknown> | undefined>
  const row: QuotaRow = {
    five_hour: num(w.five_hour?.utilization) ?? prev?.five_hour ?? null,
    seven_day: num(w.seven_day?.utilization) ?? prev?.seven_day ?? null,
    five_hour_resets_at: iso(w.five_hour?.resetsAt) ?? prev?.five_hour_resets_at ?? null,
    seven_day_resets_at: iso(w.seven_day?.resetsAt) ?? prev?.seven_day_resets_at ?? null,
    status: typeof info.status === 'string' ? info.status : null,
    observed_at: now.toISOString(),
  }
  // A rejection names its window; make sure that window's reset time is known even without unifiedWindows.
  if (row.status === 'rejected') {
    const reset = iso(info.resetsAt)
    if (info.rateLimitType === 'seven_day' && reset && !w.seven_day) { row.seven_day_resets_at = reset; row.seven_day = Math.max(row.seven_day ?? 0, 1) }
    else if (reset && !w.five_hour) { row.five_hour_resets_at = reset; row.five_hour = Math.max(row.five_hour ?? 0, 1) }
  }
  return row
}

export function quotaState(q: QuotaRow | null, limits: HqConfig['quota'], blockedUntil: string | null, now = Date.now()): QuotaState {
  if (blockedUntil && Date.parse(blockedUntil) > now) return { mode: 'hold', until: blockedUntil, window: 'limit', pct: null, observed: q !== null }
  if (!q) return { mode: 'normal', until: null, window: null, pct: null, observed: false }
  // A window whose reset time has passed no longer says anything about the present.
  const wins = [['five_hour', q.five_hour, q.five_hour_resets_at], ['seven_day', q.seven_day, q.seven_day_resets_at]] as const
  const live = wins.filter(([, u, r]) => u !== null && !(r && Date.parse(r) <= now)).map(([name, u, r]) => ({ name, u: u as number, r }))
  const top = live.sort((a, b) => b.u - a.u)[0]
  if (!top) return { mode: 'normal', until: null, window: null, pct: null, observed: true }
  const mode: QuotaMode = q.status === 'rejected' || top.u >= limits.holdAt ? 'hold' : top.u >= limits.reviewOnlyAt ? 'review_only' : top.u >= limits.saveAt ? 'save' : 'normal'
  if (mode !== 'hold') return { mode, until: null, window: top.name, pct: top.u, observed: true }
  // Without a known reset time, hold for an hour from the observation and then look again.
  const until = top.r ?? new Date(Date.parse(q.observed_at ?? new Date(now).toISOString()) + HOLD_FALLBACK_MS).toISOString()
  if (Date.parse(until) <= now) return { mode: 'normal', until: null, window: top.name, pct: top.u, observed: true }
  return { mode, until, window: top.name, pct: top.u, observed: true }
}

export function quotaView(q: QuotaRow | null, s: QuotaState): QuotaView | null {
  if (!q && s.mode === 'normal') return null
  return { fiveHour: q?.five_hour ?? null, sevenDay: q?.seven_day ?? null, fiveHourResetsAt: q?.five_hour_resets_at ?? null,
    sevenDayResetsAt: q?.seven_day_resets_at ?? null, mode: s.mode, observedAt: q?.observed_at ?? null }
}
