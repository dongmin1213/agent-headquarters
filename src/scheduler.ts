// Runs each team's command on its schedule. Exit-code contract for team commands:
//   0  = did work or nothing to do     3  = waiting for chairman approval
//   75 = hit the Claude usage limit (EX_TEMPFAIL)   other = error
// A team reports progress by printing lines starting with "STATUS:" (shown as the pet's bubble).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Bus } from './bus.ts'
import type { Store } from './store.ts'
import type { TeamConfig, TeamState, TeamView } from './types.ts'

const LIMIT_BACKOFF_MS = 30 * 60_000

export interface TeamQuota { holdUntil(): string | null; teamLimited(untilIso: string): void }

export class Scheduler {
  private state = new Map<string, { state: TeamState; bubble: string; running: boolean }>()
  private timer: NodeJS.Timeout | null = null

  private teams: TeamConfig[]
  private store: Store
  private bus: Bus
  private hqUrl: string
  private token: string
  private quota: TeamQuota | null

  /** `quota` connects teams to the shared quota hold (execution.md §13); without it the legacy kv hold is used. */
  constructor(teams: TeamConfig[], store: Store, bus: Bus, hqUrl: string, token: string, quota: TeamQuota | null = null) {
    this.teams = teams; this.store = store; this.bus = bus; this.hqUrl = hqUrl; this.token = token; this.quota = quota
    for (const t of teams) this.state.set(t.id, { state: 'idle', bubble: '대기 중', running: false })
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 30_000)
    this.tick()
  }

  stop(): void { if (this.timer) clearInterval(this.timer) }

  blockedUntil(): string | null {
    if (this.quota) return this.quota.holdUntil()
    const v = this.store.get('limit.blockedUntil')
    if (v && Date.parse(v) <= Date.now()) { this.store.set('limit.blockedUntil', null); return null }
    return v
  }

  views(): TeamView[] {
    return this.teams.map((t) => {
      const s = this.state.get(t.id)!
      const last = this.store.lastRun(t.id)
      const next = last?.endedAt ? new Date(Date.parse(last.endedAt) + t.everyMinutes * 60_000).toISOString() : null
      return { id: t.id, name: t.name, pack: t.pack, state: s.state, bubble: s.bubble, lastRun: last, nextRunAt: t.enabled ? next : null }
    })
  }

  private tick(): void {
    if (this.blockedUntil()) return
    for (const t of this.teams) {
      if (!t.enabled || this.state.get(t.id)!.running) continue
      const last = this.store.lastRun(t.id)
      const due = !last?.endedAt || Date.now() - Date.parse(last.endedAt) >= t.everyMinutes * 60_000
      if (due) void this.runTeam(t)
    }
  }

  runNow(teamId: string): boolean {
    const t = this.teams.find((x) => x.id === teamId)
    if (!t || this.state.get(t.id)!.running) return false
    if (this.blockedUntil()) return false
    void this.runTeam(t)
    return true
  }

  private set(teamId: string, state: TeamState, bubble: string): void {
    const s = this.state.get(teamId)!
    s.state = state; s.bubble = bubble
    this.bus.emit({ kind: 'team', teamId, text: bubble, data: { state } })
  }

  private runTeam(t: TeamConfig): Promise<void> {
    const s = this.state.get(t.id)!
    s.running = true
    const runId = this.store.startRun(t.id)
    this.set(t.id, 'working', '작업 시작')
    const tail: string[] = []
    return new Promise((resolve) => {
      const [cmd, ...args] = t.command
      const child = spawn(cmd, args, { cwd: t.cwd, env: { ...process.env, HQ_URL: this.hqUrl, HQ_TOKEN: this.token, HQ_TEAM: t.id }, stdio: ['ignore', 'pipe', 'pipe'] })
      const onLine = (line: string) => {
        tail.push(line); if (tail.length > 40) tail.shift()
        if (line.startsWith('STATUS:')) this.set(t.id, 'working', line.slice(7).trim())
      }
      createInterface({ input: child.stdout }).on('line', onLine)
      createInterface({ input: child.stderr }).on('line', onLine)
      child.on('close', (code) => {
        const exit = code ?? -1
        const summary = tail.slice(-8).join('\n')
        this.store.endRun(runId, exit, summary)
        s.running = false
        if (exit === 0) this.set(t.id, 'idle', lastStatus(tail) ?? '완료')
        else if (exit === 3) this.set(t.id, 'waiting', lastStatus(tail) ?? '승인 대기')
        else if (exit === 75) {
          const until = new Date(Date.now() + LIMIT_BACKOFF_MS).toISOString()
          if (this.quota) this.quota.teamLimited(until)
          else this.store.set('limit.blockedUntil', until)
          this.bus.emit({ kind: 'limit', teamId: t.id, text: `사용 한도 — ${until}까지 대기` })
          this.set(t.id, 'sleeping', '사용 한도, 쉬는 중')
        } else this.set(t.id, 'error', `오류 (종료 코드 ${exit}): ${tail.at(-1) ?? ''}`.slice(0, 140))
        resolve()
      })
    })
  }
}

function lastStatus(tail: string[]): string | null {
  for (let i = tail.length - 1; i >= 0; i--) if (tail[i].startsWith('STATUS:')) return tail[i].slice(7).trim()
  return null
}
