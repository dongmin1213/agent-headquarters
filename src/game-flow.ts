// Cheap flow observations precede any paid supervisor turn. Never infer game quality from task counts.
import { createHash } from 'node:crypto'
import type { PlanTask } from './ceo.ts'
import type { Store, TaskRow } from './store.ts'

export const FLOW_SETTLE_MS = 3 * 60_000
export const FLOW_COOLDOWN_MS = 30 * 60_000
export const FLOW_MAX_TURNS = 6
export const flowSignature = (rows: TaskRow[]): string => createHash('sha256').update(JSON.stringify(rows.map(t =>
  [t.id, t.status, t.generation, t.revision, t.attempts, t.lingering, t.spec]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex')
const spec = (t: TaskRow): PlanTask => JSON.parse(t.spec)

export function ancestors(rows: TaskRow[], key: string): TaskRow[] {
  const seen = new Set<string>()
  const visit = (k: string): void => { for (const d of spec(rows.find(t => t.key === k)!).depends_on) if (!seen.has(d)) { seen.add(d); visit(d) } }
  visit(key)
  return rows.filter(t => seen.has(t.key))
}

/** Only untouched production jobs before a quality gate can be considered for a split. */
export function flowCandidates(store: Store, rows: TaskRow[]): TaskRow[] {
  return rows.filter(t => {
    const s = spec(t)
    return t.status === 'pending' && !t.worktree && !t.head_sha && !t.lingering && !store.attempts(t.id).length
      && s.role === 'implement' && ['art', 'gameplay', 'level'].includes(s.department ?? '') && s.owns.length >= 2
      && ancestors(rows, t.key).some(a => a.status !== 'passed')
      && !ancestors(rows, t.key).some(a => ['research', 'direction', 'qa'].includes(spec(a).department ?? '') && a.status !== 'passed')
  })
}

/** Observe only while spare capacity exists. Sleep/daemon gaps do not count as observed waiting. */
export function flowDue(store: Store, id: string, rows: TaskRow[], now: number, eligible: boolean): boolean {
  const key = `game.flow-watch:${id}`, signature = flowSignature(rows)
  if (!eligible) { store.set(key, null); return false }
  const old = JSON.parse(store.get(key) ?? 'null') as { signature: string; last: number; elapsed: number } | null
  const delta = old?.signature === signature ? now - old.last : 0
  const elapsed = old?.signature === signature && delta >= 0 && delta <= 60_000 ? old.elapsed + delta : 0
  store.set(key, JSON.stringify({ signature, last: now, elapsed }))
  const last = JSON.parse(store.get(`game.flow-last:${id}`) ?? 'null') as { at: number } | null
  return elapsed >= FLOW_SETTLE_MS && !store.get(`game.flow-seen:${id}:${signature}`)
    && Number(store.get(`game.flow-count:${id}`) ?? 0) < FLOW_MAX_TURNS
    && (!last || now - last.at >= FLOW_COOLDOWN_MS)
}

/** Deliberately conservative subset check; arbitrary glob intersection is not a permission proof. */
export function containedOwn(child: string, parents: string[]): boolean {
  if (!child || child.startsWith('/') || child.includes('\\') || child.split('/').some(p => p === '..' || p === '.')) return false
  return parents.some(p => p === '**' || p === child || (p.endsWith('/**') && child.startsWith(p.slice(0, -2))))
}
