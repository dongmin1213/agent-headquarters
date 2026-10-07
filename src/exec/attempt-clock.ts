import type { Store, AttemptRow } from '../store.ts'

const MAX_OBSERVATION_GAP_MS = 60_000
interface Budget { activeMs: number; unobservedMs: number }

/** Count supervised wall time. Sleep/daemon outages are unobserved, not proof of runaway work. */
export class AttemptClock {
  private last = new Map<string, number>()
  private store: Store
  constructor(store: Store) { this.store = store }
  private read(id: string): Budget | null {
    try {
      const b = JSON.parse(this.store.get(`attempt.clock:${id}`) ?? 'null')
      return b && Number.isFinite(b.activeMs) && b.activeMs >= 0 && Number.isFinite(b.unobservedMs) && b.unobservedMs >= 0 ? b : null
    } catch { return null }
  }
  track(id: string, now: number): void {
    this.last.set(id, now)
    if (!this.read(id)) this.store.set(`attempt.clock:${id}`, JSON.stringify({ activeMs: 0, unobservedMs: 0 }))
  }
  sample(id: string, now: number): number {
    const b = this.read(id) ?? { activeMs: 0, unobservedMs: 0 }
    const gap = Math.max(0, now - (this.last.get(id) ?? now))
    this.last.set(id, now)
    if (gap <= MAX_OBSERVATION_GAP_MS) b.activeMs += gap
    else b.unobservedMs += gap
    this.store.set(`attempt.clock:${id}`, JSON.stringify(b))
    return b.activeMs
  }
  spent(a: AttemptRow): number {
    return this.read(a.id)?.activeMs ?? Math.max(0, Date.parse(a.ended_at!) - Date.parse(a.started_at!))
  }
}
