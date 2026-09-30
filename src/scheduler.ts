// Runs each team's command on its schedule. Exit-code contract for team commands:
//   0  = did work or nothing to do     3  = waiting for chairman approval
//   75 = hit the Claude usage limit (EX_TEMPFAIL)   other = error
// A team reports progress by printing lines starting with "STATUS:" (shown as the pet's bubble).
//
// Least privilege (teams are trusted user code, but they read the web): each run gets a scoped API token (quota +
// its own team cards, never a decision), an environment without secrets, and a Seatbelt profile that hides the
// daemon token and $HQ_HOME. Runs are detached process groups writing to a log file, so a daemon restart adopts a
// live run (pid + `ps` start time) instead of starting a duplicate; the exit code survives as a marker line.
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Bus } from './bus.ts'
import type { Store } from './store.ts'
import type { RunRecord, TeamConfig, TeamState, TeamView } from './types.ts'
import { real, wrap } from './exec/sandbox.ts'
import { killGroup, pidAlive, psLstart, type PsLstart } from './exec/worker.ts'

const LIMIT_BACKOFF_MS = 30 * 60_000
const SPAWN_FAILED = '실행할 수 없어요:'
const TIMED_OUT = '시간 초과'
export const INTERRUPTED = '지난 실행이 중단됐어요 · 다음 실행 때 이어서 해요'
export const UNCONFIRMED = '이전 실행이 아직 도는지 확인할 수 없어요 · 확인 전에는 새로 시작하지 않아요'
const DEFAULT_TIMEOUT_MINUTES = 180
const KEEP_LOGS = 50
const EXIT_MARKER = '__HQ_EXIT__'
// Runs outside the sandbox with stdout = the run's log, so the exit code lands in the log even if the daemon is gone.
// It catches SIGTERM (a caught signal resets to default in the child on exec) so a group SIGTERM still lets it record
// the team's exit code, and it stays the group leader we can confirm until the team itself is gone.
const WRAPPER = `trap : TERM INT HUP; "$@"; echo "${EXIT_MARKER} $?"`
const MARKER_LINE = new RegExp(`^${EXIT_MARKER} (\\d+)$`)

export interface TeamQuota { holdUntil(): string | null; teamLimited(untilIso: string): void }

export interface TeamIsolation {
  /** $HQ_HOME: team logs live under logs/teams/; the team process cannot read or write it. */
  hqHome: string
  /** Folder holding the daemon token; the team process cannot read or write it. */
  tokenDir: string
  /** How often a running team's log is read (default 1000 ms). */
  pollMs?: number
  /** SIGTERM → SIGKILL grace on timeout (default 10 s). */
  killGraceMs?: number
  ps?: PsLstart
}

interface Active {
  team: TeamConfig; runId: number; hash: string; log: string; adopted: boolean
  pid: number | null; lstart: string | null; child: ChildProcess | null; childExit: number | null | undefined
  offset: number; decoder: StringDecoder; partial: string; tail: string[]; marker: number | null
  startedMs: number; timer: NodeJS.Timeout | null; killing: string | null; nextKillCheck: number
  unconfirmed: boolean; done: boolean; resolve: () => void
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const SECRET_ENV = /(_TOKEN|_KEY)$|^(ANTHROPIC|OPENAI)_/i

/** Parent env minus HQ_TOKEN_FILE and secrets (*_TOKEN, *_KEY, ANTHROPIC_*, OPENAI_*), plus the team's own HQ_* values. */
export function teamEnv(extra: Record<string, string>, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(from)) if (k !== 'HQ_TOKEN_FILE' && !SECRET_ENV.test(k)) env[k] = v
  return { ...env, ...extra }
}

/** Seatbelt profile for team commands: everything allowed except the daemon token folder and $HQ_HOME. */
export function teamProfile(hqHome: string, tokenDir: string): string {
  const deny = [...new Set([real(tokenDir), real(hqHome)])].map((p) => `(subpath ${JSON.stringify(p)})`).join(' ')
  return `(version 1)\n(allow default)\n(deny file-read-data file-write* ${deny})\n`
}

const errno = (code: string) => Object.assign(new Error(code), { code }) as NodeJS.ErrnoException

/** The executable spawn would run (checked up front: inside the wrappers a missing command is only an exit code). */
function resolveCommand(cmd: string, cwd: string, path: string | undefined): string {
  const runnable = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile() } catch { return false } }
  if (cmd.includes('/')) {
    const p = resolve(cwd, cmd)
    if (runnable(p)) return p
    throw errno(existsSync(p) ? 'EACCES' : 'ENOENT')
  }
  for (const dir of (path ?? '').split(':')) {
    if (!dir) continue
    const p = resolve(cwd, dir, cmd)
    if (runnable(p)) return p
  }
  throw errno('ENOENT')
}

const safeName = (id: string) => id.replace(/[^\w.-]/g, '_')

export class Scheduler {
  private state = new Map<string, { state: TeamState; bubble: string; running: boolean }>()
  private active = new Map<string, Active>()
  /** sha256(scoped token) → owner. Revoked when the run ends. */
  private tokens = new Map<string, { teamId: string; runId: number }>()
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  /** Settles when every unfinished run found at startup has been adopted, finished, or marked unconfirmed. */
  readonly ready: Promise<void>

  private teams: TeamConfig[]
  private store: Store
  private bus: Bus
  private hqUrl: string
  private iso: Required<TeamIsolation>
  private quota: TeamQuota | null

  /** `quota` connects teams to the shared quota hold (execution.md §13); without it the legacy kv hold is used. */
  constructor(teams: TeamConfig[], store: Store, bus: Bus, hqUrl: string, iso: TeamIsolation, quota: TeamQuota | null = null) {
    this.teams = teams; this.store = store; this.bus = bus; this.hqUrl = hqUrl; this.quota = quota
    this.iso = { pollMs: 1000, killGraceMs: 10_000, ps: psLstart, ...iso }
    const pending: Promise<void>[] = []
    for (const t of teams) {
      const last = store.lastRun(t.id)
      if (last && !last.endedAt) {
        // An unfinished run: its process may still be alive (detached). Never start a second one before knowing.
        this.state.set(t.id, { state: 'working', bubble: '이전 실행을 확인하고 있어요', running: true })
        pending.push(this.recover(t, last))
        continue
      }
      // Restore each enabled team's last outcome so a daemon restart doesn't reset every pet to '대기 중'.
      const o = last && t.enabled ? restoredOutcome(last) : { state: 'idle' as const, bubble: '대기 중' }
      this.state.set(t.id, { ...o, running: false })
    }
    this.ready = Promise.all(pending).then(() => {})
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 30_000)
    void this.ready.then(() => { if (!this.stopped) this.tick() })
  }

  /** Daemon shutdown: stop watching; team processes keep running and the next start adopts them. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const a of this.active.values()) if (a.timer) clearInterval(a.timer)
  }

  /** Team id owning a live scoped token, or null. */
  teamOfToken(token: string): string | null {
    return token ? this.tokens.get(sha(token))?.teamId ?? null : null
  }

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
    if (this.stopped) return
    // A run whose identity could not be confirmed is only watched for its pid disappearing; it is never signalled.
    for (const a of this.active.values()) if (a.unconfirmed && !pidAlive(a.pid!)) this.drain(a)
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
    if (this.stopped || !t || !t.enabled || this.state.get(t.id)!.running) return false
    if (this.blockedUntil()) return false
    void this.runTeam(t)
    return true
  }

  private set(teamId: string, state: TeamState, bubble: string): void {
    const s = this.state.get(teamId)!
    s.state = state; s.bubble = bubble
    this.bus.emit({ kind: 'team', teamId, text: bubble, data: { state } })
  }

  private logDir(t: TeamConfig): string { return join(this.iso.hqHome, 'logs', 'teams', safeName(t.id)) }

  private newActive(t: TeamConfig, run: RunRecord, hash: string, adopted: boolean, pid: number | null, lstart: string | null): Active {
    return { team: t, runId: run.id, hash, log: join(this.logDir(t), `${run.id}.log`), adopted, pid, lstart, child: null, childExit: undefined,
      offset: 0, decoder: new StringDecoder('utf8'), partial: '', tail: [], marker: null, startedMs: Date.parse(run.startedAt), timer: null,
      killing: null, nextKillCheck: 0, unconfirmed: false, done: false, resolve: () => {} }
  }

  private runTeam(t: TeamConfig): Promise<void> {
    const s = this.state.get(t.id)!
    s.running = true
    const runId = this.store.startRun(t.id)
    this.set(t.id, 'working', '작업 시작')
    const token = randomBytes(24).toString('hex')
    const a = this.newActive(t, this.store.lastRun(t.id)!, sha(token), false, null, null)
    this.active.set(t.id, a)
    this.tokens.set(a.hash, { teamId: t.id, runId })
    return new Promise((done) => {
      a.resolve = done
      const [cmd, ...args] = t.command
      const spawnFailed = (err: NodeJS.ErrnoException) => this.finish(a, -1, `${SPAWN_FAILED} ${err.code ?? err.message} (${cmd})`)
      let fd: number | null = null
      try {
        const env = teamEnv({ HQ_URL: this.hqUrl, HQ_TOKEN: token, HQ_TEAM: t.id })
        const exe = resolveCommand(cmd, t.cwd, env.PATH)
        const dir = this.logDir(t)
        mkdirSync(dir, { recursive: true })
        pruneLogs(dir, runId)
        const profile = join(dir, `${runId}.sb`)
        writeFileSync(profile, teamProfile(this.iso.hqHome, this.iso.tokenDir))
        fd = openSync(a.log, 'a')
        // detached: own process group, so it outlives a daemon restart and a timeout can stop the whole tree.
        const child = spawn('/bin/sh', ['-c', WRAPPER, 'hq-team', ...wrap([exe, ...args], profile)], { cwd: t.cwd, env, detached: true, stdio: ['ignore', fd, fd] })
        a.child = child
        child.on('error', spawnFailed)
        child.on('exit', (code) => { a.childExit = code; this.poll(a) })
        if (!child.pid) return
        a.pid = child.pid
        child.unref()
        this.store.setRunProcess(runId, child.pid, null, a.hash)
        void this.iso.ps(child.pid).catch(() => null).then((lstart) => {
          if (!lstart || a.childExit !== undefined) return
          a.lstart = lstart
          this.store.setRunProcess(runId, a.pid!, lstart, a.hash)
        })
        a.timer = setInterval(() => this.poll(a), this.iso.pollMs)
        a.timer.unref()
      } catch (err) {
        spawnFailed(err as NodeJS.ErrnoException)
      } finally {
        if (fd !== null) closeSync(fd)
      }
    })
  }

  /** After a restart: adopt a live run whose identity is confirmed, finish a dead one from its log, or hold off. */
  private async recover(t: TeamConfig, run: RunRecord): Promise<void> {
    const proc = this.store.runProcess(run.id)
    const a = this.newActive(t, run, proc?.tokenHash ?? '', true, proc?.pid ?? null, proc?.lstart ?? null)
    this.active.set(t.id, a)
    if (a.pid === null || !pidAlive(a.pid)) { this.drain(a); return }
    const now = await this.iso.ps(a.pid).catch(() => null)
    if (a.lstart !== null && now !== null && now !== a.lstart) { this.drain(a); return } // pid reused by another process
    if (a.hash) this.tokens.set(a.hash, { teamId: t.id, runId: run.id })
    if (a.lstart === null || now === null) {
      if (!pidAlive(a.pid)) { this.drain(a); return }
      a.unconfirmed = true
      this.set(t.id, 'error', UNCONFIRMED)
      return
    }
    this.readLog(a)
    this.set(t.id, 'working', lastStatus(a.tail) ?? '이전 실행을 이어서 지켜봐요')
    a.timer = setInterval(() => this.poll(a), this.iso.pollMs)
    a.timer.unref()
    this.poll(a)
  }

  /** Is the run's process still the one we started? (Our own unreaped child, or same pid with the same start time.) */
  private async ours(a: Active): Promise<boolean> {
    if (a.pid === null) return false
    if (a.child && a.childExit === undefined) return true
    if (a.child || !a.lstart || !pidAlive(a.pid)) return false
    return (await this.iso.ps(a.pid).catch(() => null)) === a.lstart
  }

  private poll(a: Active): void {
    if (a.done || this.stopped) return
    this.readLog(a)
    const gone = a.child ? a.childExit !== undefined : !pidAlive(a.pid!)
    if (gone) return this.drain(a)
    void this.checkTimeout(a)
  }

  private async checkTimeout(a: Active): Promise<void> {
    const minutes = a.team.timeoutMinutes != null && a.team.timeoutMinutes > 0 ? a.team.timeoutMinutes : DEFAULT_TIMEOUT_MINUTES
    if (a.killing || Date.now() < a.nextKillCheck || Date.now() - a.startedMs < minutes * 60_000) return
    a.killing = `${TIMED_OUT}(${minutes}분)`
    if (!(await this.ours(a))) { a.killing = null; a.nextKillCheck = Date.now() + 60_000; return } // never signal an unconfirmed pid
    if (a.done) return
    this.set(a.team.id, 'working', `${a.killing} · 멈추는 중`)
    killGroup(a.pid!, 'SIGTERM')
    setTimeout(() => { void this.ours(a).then((mine) => { if (mine && !a.done) killGroup(a.pid!, 'SIGKILL') }) }, this.iso.killGraceMs).unref()
  }

  /** The process is gone: read the rest of the log and end the run with its exit marker (or the fallback). */
  private drain(a: Active): void {
    if (a.done) return
    this.readLog(a)
    if (a.partial) { this.line(a, a.partial); a.partial = '' }
    if (a.killing) return this.finish(a, -1, a.killing)
    if (a.marker !== null) return this.finish(a, a.marker, null)
    if (a.adopted) return this.finish(a, -1, INTERRUPTED)
    this.finish(a, a.childExit ?? -1, null)
  }

  private readLog(a: Active): void {
    let fd: number
    try { fd = openSync(a.log, 'r') } catch { return }
    try {
      const buf = Buffer.alloc(64 * 1024)
      while (a.offset < fstatSync(fd).size) {
        const n = readSync(fd, buf, 0, buf.length, a.offset)
        if (n <= 0) break
        a.offset += n
        const lines = (a.partial + a.decoder.write(buf.subarray(0, n))).split('\n')
        a.partial = lines.pop()!
        for (const l of lines) this.line(a, l)
      }
    } finally { closeSync(fd) }
  }

  private line(a: Active, raw: string): void {
    const line = raw.replace(/\r$/, '')
    const m = MARKER_LINE.exec(line)
    if (m) { a.marker = Number(m[1]); return }
    a.tail.push(line); if (a.tail.length > 40) a.tail.shift()
    if (line.startsWith('STATUS:') && !a.done && !a.killing) this.set(a.team.id, 'working', line.slice(7).trim())
  }

  // The run must end exactly once ('error' may be followed by 'exit', or come alone).
  private finish(a: Active, exit: number, failure: string | null): void {
    if (a.done) return
    a.done = true
    if (a.timer) clearInterval(a.timer)
    this.tokens.delete(a.hash)
    if (this.active.get(a.team.id) === a) this.active.delete(a.team.id)
    const t = a.team
    const tail = a.tail
    // Keep the last STATUS line even when it scrolled out of the last 8, so a restart can restore the bubble.
    const kept = tail.slice(-8)
    const status = tail.findLastIndex((l) => l.startsWith('STATUS:'))
    if (status >= 0 && status < tail.length - kept.length) kept.unshift(tail[status])
    const summary = [...kept, ...(failure ? [failure] : [])].join('\n')
    this.store.endRun(a.runId, exit, summary)
    this.state.get(t.id)!.running = false
    if (!failure && exit === 75) {
      const until = new Date(Date.now() + LIMIT_BACKOFF_MS).toISOString()
      if (this.quota) this.quota.teamLimited(until)
      else this.store.set('limit.blockedUntil', until)
      this.bus.emit({ kind: 'limit', teamId: t.id, text: `사용 한도 — ${until}까지 대기` })
    }
    const o = runOutcome(exit, tail, failure)
    this.set(t.id, o.state, o.bubble)
    a.resolve()
  }
}

/** Keeps the newest KEEP_LOGS runs' log/profile files per team. */
function pruneLogs(dir: string, current: number): void {
  try {
    for (const f of readdirSync(dir)) {
      const id = Number(/^(\d+)\.(log|sb)$/.exec(f)?.[1])
      if (id > 0 && id <= current - KEEP_LOGS) rmSync(join(dir, f), { force: true })
    }
  } catch { /* best effort */ }
}

function lastStatus(tail: string[]): string | null {
  for (let i = tail.length - 1; i >= 0; i--) if (tail[i].startsWith('STATUS:')) return tail[i].slice(7).trim()
  return null
}

/** The one exit→state mapping, used when a run ends and when restoring after a restart. */
function runOutcome(exit: number, lines: string[], failure: string | null): { state: TeamState; bubble: string } {
  if (failure === INTERRUPTED) return { state: 'idle', bubble: INTERRUPTED }
  if (failure) return { state: 'error', bubble: failure.slice(0, 140) }
  if (exit === 0) return { state: 'idle', bubble: lastStatus(lines) ?? '완료' }
  if (exit === 3) return { state: 'waiting', bubble: lastStatus(lines) ?? '승인 대기' }
  if (exit === 75) return { state: 'sleeping', bubble: '사용 한도, 쉬는 중' }
  return { state: 'error', bubble: `오류 (종료 코드 ${exit}): ${lines.at(-1) ?? ''}`.slice(0, 140) }
}

/** State to show for a team's last recorded (finished) run after a daemon restart. */
function restoredOutcome(run: RunRecord): { state: TeamState; bubble: string } {
  const lines = run.summary ? run.summary.split('\n') : []
  // finish() appends a failure (spawn failure, timeout, interruption) as the summary's last line; split it back out.
  const last = lines.at(-1) ?? ''
  const failure = run.exitCode === -1 && (last.startsWith(SPAWN_FAILED) || last.startsWith(TIMED_OUT) || last === INTERRUPTED) ? lines.pop()! : null
  return runOutcome(run.exitCode ?? -1, lines, failure)
}
