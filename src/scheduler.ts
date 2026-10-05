// Runs each team's command on its schedule. Exit-code contract for team commands:
//   0  = did work or nothing to do     3  = waiting for chairman approval
//   75 = hit the Codex usage limit (EX_TEMPFAIL)   other = error
// A team reports progress by printing lines starting with "STATUS:" (shown as the pet's bubble).
//
// Least privilege (teams are trusted user code, but they read the web): each run gets a scoped API token (quota +
// its own team cards, never a decision), an environment without secrets, a per-run package cache, and the v4 Seatbelt
// rules shared with workers (teamProfile). Runs are detached process groups writing to a log file, so a daemon restart
// adopts a live run (pid + `ps` start time) instead of starting a duplicate; the exit code survives as a marker line.
// A live pid whose identity cannot be confirmed is never signalled; the chairman gets a card to release it (N3).
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { prepareCodexHome } from './codex.ts'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Bus } from './bus.ts'
import type { Store } from './store.ts'
import type { RunRecord, TeamConfig, TeamState, TeamView } from './types.ts'
import {
  cacheEnv, claudeOwnFilters, claudeWriteRules, homeReadFilters, homeSecretFilters, launchRules, machRules, makeCacheDir, real,
  signalRules, subpathOf, TEAM_MACH_ALLOWED, tempRoots, wrap,
} from './exec/sandbox.ts'
import { killGroup, pidAlive, psLstart, removeCacheDir, type PsLstart } from './exec/worker.ts'

const LIMIT_BACKOFF_MS = 30 * 60_000
/** The hq repository this daemon runs from (teams may never work inside it: it holds their own sandbox config and the daemon code). */
export const HQ_ROOT = resolve(import.meta.dirname, '..')
export const TEAM_CWD_OVERLAP = '실행할 수 없어요: 팀 폴더가 hq 저장소나 hq 데이터와 겹쳐요'
const SPAWN_FAILED = '실행할 수 없어요:'
const TIMED_OUT = '시간 초과'
export const INTERRUPTED = '지난 실행이 중단됐어요 · 다음 실행 때 이어서 해요'
export const UNCONFIRMED = '이전 실행이 아직 도는지 확인할 수 없어요 · 확인 전에는 새로 시작하지 않아요'
/** Options of the hq-owned card for an unconfirmed run (N3). */
export const RELEASE = '끝난 것으로 보고 다시 시작'
export const KEEP_WAITING = '계속 기다림'
/** Summary line / bubble after the chairman released an unconfirmed run. */
export const RELEASED = '확인할 수 없던 이전 실행을 끝난 것으로 봤어요 · 다시 시작해요'
const REPOST_MS = 24 * 60 * 60_000
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
  /** The hq repository (default HQ_ROOT): a team cwd equal to, above or inside it (or $HQ_HOME) is refused. */
  hqRoot?: string
  /** $HQ_HOME: team logs live under logs/teams/; the team process cannot read or write it. */
  hqHome: string
  /** Folder holding the daemon token; the team process cannot read or write it. */
  tokenDir: string
  /** How often a running team's log is read (default 1000 ms). */
  pollMs?: number
  /** SIGTERM → SIGKILL grace on timeout (default 10 s). */
  killGraceMs?: number
  ps?: PsLstart
  /** Command line of a live pid (`ps -o command=`), null when unknown; shown on the unconfirmed-run card. */
  psCommand?: (pid: number) => Promise<string | null>
  /** Clock for the unconfirmed-run card's 24h re-ask (tests). */
  now?: () => number
}

interface Active {
  team: TeamConfig; runId: number; hash: string; log: string; adopted: boolean
  pid: number | null; lstart: string | null; child: ChildProcess | null; childExit: number | null | undefined
  offset: number; decoder: StringDecoder; partial: string; tail: string[]; marker: number | null
  startedMs: number; timer: NodeJS.Timeout | null; killing: string | null; nextKillCheck: number
  unconfirmed: boolean; done: boolean; resolve: () => void
  /** Per-run cache folder (npm/pip/XDG), removed when the run ends. */
  cacheDir: string | null
  /** The chairman card for an unconfirmed run: its id, the revision hq posted, and when to ask again after 계속 기다림. */
  card: { id: string; rev: number; waitUntil: number | null; posting: boolean } | null
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const SECRET_ENV = /(_TOKEN|_KEY)$|^(ANTHROPIC|OPENAI)_/i

/** Parent env minus HQ_TOKEN_FILE and secrets (*_TOKEN, *_KEY, ANTHROPIC_*, OPENAI_*), plus the team's own HQ_* values. */
export function teamEnv(extra: Record<string, string>, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(from)) if (k !== 'HQ_TOKEN_FILE' && !SECRET_ENV.test(k)) env[k] = v
  return { ...env, ...extra }
}

export interface TeamProfileOpts {
  codexHome?: string
  /** The team repo: readable and writable. */
  cwd: string
  hqHome: string
  tokenDir: string
  /** Extra read-only roots (TeamConfig.sandbox.readable, already expanded). */
  readable?: string[]
  /** Extra read-write roots (TeamConfig.sandbox.writable, already expanded). */
  writable?: string[]
  /** Extra mach services (TeamConfig.sandbox.mach, already checked against TEAM_MACH_ALLOWED). */
  mach?: string[]
  /** Home directory for ~ paths (tests use a fake one). */
  home?: string
  /** The hq repository: never writable, whatever the other rules allow (last rule). */
  hqRoot?: string
}

/** True when `a` and `b` are the same folder or one contains the other (resolved paths). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = real(resolve(a)), y = real(resolve(b))
  const inside = (p: string, q: string) => p === q || p.startsWith(q.endsWith('/') ? q : `${q}/`)
  return inside(x, y) || inside(y, x)
}

/** A team cwd that is the hq repository or $HQ_HOME, or an ancestor or descendant of either: the team never runs. */
export const teamCwdOverlaps = (cwd: string, hqRoot: string, hqHome: string): boolean => pathsOverlap(cwd, hqRoot) || pathsOverlap(cwd, hqHome)

/**
 * Seatbelt profile for team commands: the worker v4 rules (sandbox.ts: signals only inside the sandbox, mach-lookup
 * allow-list, ~ content reads deny-by-default + the measured list, ~/.claude write limits, no open/osascript/launchctl)
 * plus the team's own allowances: its cwd (read+write), temp, its own ~/.claude/projects/<cwd>/ (claude -p transcripts,
 * minus memory/) and the configured extra paths. The network stays open, including the hq port (the team talks to hq with
 * its scoped token). The daemon token folder, $HQ_HOME and ~ credentials are denied last, so nothing re-allows them.
 */
export function teamProfile(o: TeamProfileOpts): string {
  const home = real(o.home ?? homedir())
  const readable = o.readable ?? [], writable = o.writable ?? []
  const claude = claudeOwnFilters(home, o.cwd)
  const w = [o.cwd, ...tempRoots(), '/dev', ...writable].map(subpathOf)
  return [
    '(version 1)',
    '(allow default)',
    ...signalRules(),
    ...machRules(),
    ...(o.mach ?? []).map((n) => `(allow mach-lookup (global-name ${JSON.stringify(n)})) ; team config`),
    `(deny file-read-data ${subpathOf(home)} ${subpathOf(o.hqHome)})`,
    `(allow file-read-data ${[...homeReadFilters(home), ...[...readable, ...writable, o.cwd].map(subpathOf), claude.own].join(' ')})`,
    `(deny file-write* (require-not (require-any ${w.join(' ')} ${claude.own})))`,
    ...claudeWriteRules(home, claude),
    `(deny file-read-data file-write* ${[...new Set([o.tokenDir, o.hqHome].map(subpathOf))].join(' ')} ${homeSecretFilters(home).join(' ')})`,
    ...(o.codexHome ? ['(allow mach-lookup (global-name "com.apple.trustd.agent")) ; Codex TLS certificate validation', `(allow file-read-data file-write* ${subpathOf(o.codexHome)})`] : []),
    ...(o.codexHome ? [`(deny file-read-data file-write* ${subpathOf(join(home, '.claude'))} ${subpathOf(join(home, '.codex'))})`] : []),
    ...launchRules(),
    ...(o.hqRoot ? [`(deny file-write* ${subpathOf(o.hqRoot)}) ; the hq repository (daemon code, teams.json)`] : []),
    '',
  ].join('\n')
}

/** A team's sandbox setting that cannot be applied; the run ends with `실행할 수 없어요: <message>`. */
export class TeamSandboxError extends Error {}

/**
 * TeamConfig.sandbox → profile paths (~ expanded, relative to cwd) and allowed extra mach services, or 'none'.
 * Throws TeamSandboxError on a malformed value or a mach service outside TEAM_MACH_ALLOWED.
 */
export function teamSandboxPaths(t: TeamConfig, home = homedir()): { readable: string[]; writable: string[]; mach: string[] } | 'none' {
  const sb = t.sandbox
  if (sb === 'none') return 'none'
  if (sb === undefined) return { readable: [], writable: [], mach: [] }
  const list = (v: unknown, key: string): string[] => {
    if (v === undefined) return []
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw new TeamSandboxError(`teams.json sandbox.${key}는 목록이어야 해요`)
    return v as string[]
  }
  const path = (p: string) => resolve(t.cwd, p.replace(/^~(?=\/|$)/, home))
  if (!sb || typeof sb !== 'object' || Array.isArray(sb)) throw new TeamSandboxError('teams.json sandbox는 {readable, writable, mach} 또는 "none"이어야 해요')
  for (const k of Object.keys(sb)) if (!['readable', 'writable', 'mach'].includes(k)) throw new TeamSandboxError(`teams.json sandbox: 알 수 없는 키 "${k}"`)
  const mach = list(sb.mach, 'mach')
  for (const n of mach) if (!TEAM_MACH_ALLOWED.some(([name]) => name === n)) throw new TeamSandboxError(`허용되지 않은 mach 서비스 ${n}`)
  return { readable: list(sb.readable, 'readable').map(path), writable: list(sb.writable, 'writable').map(path), mach: [...new Set(mach)] }
}

function psCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('ps', ['-o', 'command=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } }, (err, out) => resolve(err ? null : String(out).trim() || null))
    } catch { resolve(null) }
  })
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
  /** Teams whose cwd overlaps the hq repository or $HQ_HOME (TEAM_CWD_OVERLAP): shown as an error, never started. */
  private badCwd: Set<string>
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
    this.iso = { pollMs: 1000, killGraceMs: 10_000, ps: psLstart, psCommand, now: Date.now, hqRoot: HQ_ROOT, ...iso }
    this.badCwd = new Set(teams.filter((t) => teamCwdOverlaps(t.cwd, this.iso.hqRoot, this.iso.hqHome)).map((t) => t.id))
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
      const o = this.badCwd.has(t.id) ? { state: 'error' as const, bubble: TEAM_CWD_OVERLAP }
        : last && t.enabled ? restoredOutcome(last) : { state: 'idle' as const, bubble: '대기 중' }
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
    // A run whose identity could not be confirmed is only watched for its pid disappearing (never signalled), or
    // released by the chairman's card.
    for (const a of this.active.values()) {
      if (!a.unconfirmed) continue
      if (!pidAlive(a.pid!)) this.drain(a)
      else this.checkCard(a)
    }
    if (this.blockedUntil()) return
    for (const t of this.teams) {
      if (this.refuseCwd(t)) continue
      if (!t.enabled || this.state.get(t.id)!.running) continue
      const last = this.store.lastRun(t.id)
      const due = !last?.endedAt || Date.now() - Date.parse(last.endedAt) >= t.everyMinutes * 60_000
      if (due) void this.runTeam(t)
    }
  }

  runNow(teamId: string): boolean {
    const t = this.teams.find((x) => x.id === teamId)
    if (this.stopped || !t) return false
    // The server calls runNow right after a team card is decided: apply an unconfirmed-run decision first.
    const a = this.active.get(t.id)
    if (a?.unconfirmed) this.checkCard(a)
    if (this.refuseCwd(t)) return false
    if (!t.enabled || this.state.get(t.id)!.running) return false
    if (this.blockedUntil()) return false
    void this.runTeam(t)
    return true
  }

  /** True for a team whose cwd overlaps hq (it never starts); puts it back to the error bubble once no run is active. */
  private refuseCwd(t: TeamConfig): boolean {
    if (!this.badCwd.has(t.id)) return false
    const s = this.state.get(t.id)!
    if (!s.running && (s.state !== 'error' || s.bubble !== TEAM_CWD_OVERLAP)) this.set(t.id, 'error', TEAM_CWD_OVERLAP)
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
      killing: null, nextKillCheck: 0, unconfirmed: false, done: false, resolve: () => {}, cacheDir: null, card: null }
  }

  private runTeam(t: TeamConfig): Promise<void> {
    if (this.refuseCwd(t)) return Promise.resolve()
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
        const paths = teamSandboxPaths(t)
        const codexHome = prepareCodexHome(this.iso.hqHome, `team:${t.id}`)
        // Per-run package caches (S4), recorded next to the log so a later daemon can remove them too.
        a.cacheDir = makeCacheDir()
        const env = teamEnv({ CODEX_HOME: codexHome, ...cacheEnv(a.cacheDir), HQ_URL: this.hqUrl, HQ_TOKEN: token, HQ_TEAM: t.id })
        const exe = resolveCommand(cmd, t.cwd, env.PATH)
        const dir = this.logDir(t)
        mkdirSync(dir, { recursive: true })
        pruneLogs(dir, runId)
        writeFileSync(join(dir, `${runId}.cache`), a.cacheDir)
        let argv = [exe, ...args]
        if (paths !== 'none') {
          const profile = join(dir, `${runId}.sb`)
          writeFileSync(profile, teamProfile({ codexHome, cwd: t.cwd, hqHome: this.iso.hqHome, tokenDir: this.iso.tokenDir, hqRoot: this.iso.hqRoot, ...paths }))
          argv = wrap(argv, profile)
        }
        fd = openSync(a.log, 'a')
        // detached: own process group, so it outlives a daemon restart and a timeout can stop the whole tree.
        const child = spawn('/bin/sh', ['-c', WRAPPER, 'hq-team', ...argv], { cwd: t.cwd, env, detached: true, stdio: ['ignore', fd, fd] })
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
        if (err instanceof TeamSandboxError) this.finish(a, -1, `${SPAWN_FAILED} ${err.message}`)
        else spawnFailed(err as NodeJS.ErrnoException)
      } finally {
        if (fd !== null) closeSync(fd)
      }
    })
  }

  /** After a restart: adopt a live run whose identity is confirmed, finish a dead one from its log, or hold off. */
  private async recover(t: TeamConfig, run: RunRecord): Promise<void> {
    const proc = this.store.runProcess(run.id)
    const a = this.newActive(t, run, proc?.tokenHash ?? '', true, proc?.pid ?? null, proc?.lstart ?? null)
    try { a.cacheDir = readFileSync(join(this.logDir(t), `${run.id}.cache`), 'utf8').trim() || null } catch { /* none recorded */ }
    this.active.set(t.id, a)
    if (a.pid === null || !pidAlive(a.pid)) { this.drain(a); return }
    const now = await this.iso.ps(a.pid).catch(() => null)
    if (a.lstart !== null && now !== null && now !== a.lstart) { this.drain(a); return } // pid reused by another process
    if (a.hash) this.tokens.set(a.hash, { teamId: t.id, runId: run.id })
    if (a.lstart === null || now === null) {
      if (!pidAlive(a.pid)) { this.drain(a); return }
      a.unconfirmed = true
      this.set(t.id, 'error', UNCONFIRMED)
      await this.postUnconfirmed(a, false)
      return
    }
    this.readLog(a)
    this.set(t.id, 'working', lastStatus(a.tail) ?? '이전 실행을 이어서 지켜봐요')
    a.timer = setInterval(() => this.poll(a), this.iso.pollMs)
    a.timer.unref()
    this.poll(a)
  }

  private cardId(a: Active): string { return `team:${a.team.id}:unconfirmed-${a.runId}` }

  /**
   * N3: an hq-owned card asking the chairman about a run whose pid lives on but cannot be confirmed as ours.
   * After a daemon restart a decision already made on this run's card is applied instead of asking again — only on the
   * revision hq itself posted (recorded in kv, which team tokens cannot reach), so a card a team posted under this id
   * never counts.
   */
  private async postUnconfirmed(a: Active, again: boolean): Promise<void> {
    const id = this.cardId(a)
    const subjectHash = sha(`unconfirmed:${a.team.id}:${a.runId}:${a.pid}`)
    const prev = this.store.approval(id)
    const ownRev = Number(this.store.get(`teamcard.${id}`) ?? -1)
    if (!again && prev && prev.revision === ownRev && prev.subjectHash === subjectHash && prev.state === 'decided') {
      a.card = { id, rev: prev.revision, waitUntil: null, posting: false }
      this.checkCard(a)
      return
    }
    a.card = { id, rev: -1, waitUntil: null, posting: true }
    const cmd = await this.iso.psCommand(a.pid!).catch(() => null)
    if (a.done) return
    const body = [
      `이전 hq가 시작한 실행(#${a.runId})의 프로세스가 아직 있지만, 같은 프로세스인지 확인할 수 없어요 (pid가 다른 프로그램에 다시 쓰였을 수도 있어요).`,
      '그래서 신호를 보내지 않고, 새 실행도 시작하지 않고 있어요.',
      `pid: ${a.pid}`,
      cmd ? `명령 (ps): ${cmd}` : `명령 (기록된 팀 명령, ps로 확인 못 함): ${a.team.command.join(' ')}`,
      `· ${RELEASE}: 이 실행을 끝난 것(-1)으로 기록하고 새 실행을 허용해요. 프로세스에는 신호를 보내지 않아요.`,
      `· ${KEEP_WAITING}: 그대로 두고, 24시간 뒤에도 확인이 안 되면 다시 물어요.`,
    ].join('\n')
    const rev = this.store.putApproval({ id, teamId: a.team.id, title: `${a.team.name}: 이전 실행을 확인할 수 없어요`, body,
      options: [RELEASE, KEEP_WAITING], subjectHash, kind: 'team' })
    this.store.set(`teamcard.${id}`, String(rev))
    a.card = { id, rev, waitUntil: null, posting: false }
    this.bus.emit({ kind: 'approval', teamId: a.team.id, text: `승인 요청: ${a.team.name}: 이전 실행을 확인할 수 없어요`, data: { id } })
  }

  /** Applies the chairman's decision on an unconfirmed run's card; re-asks 24h after 계속 기다림. */
  private checkCard(a: Active): void {
    const c = a.card
    if (!a.unconfirmed || a.done || !c || c.posting) return
    const row = this.store.approval(c.id)
    if (row && row.revision === c.rev && row.state === 'decided') {
      // No signal: the pid may belong to someone else. The run is only closed in the DB.
      if (row.decision === RELEASE) return this.finish(a, -1, RELEASED)
      if (row.decision === KEEP_WAITING && c.waitUntil === null) c.waitUntil = Date.parse(row.decidedAt ?? '') + REPOST_MS
    }
    if (c.waitUntil !== null && this.iso.now() >= c.waitUntil) void this.postUnconfirmed(a, true)
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
    if (a.card) this.store.supersede(a.card.id) // an unconfirmed run's open card is moot once the run is closed
    removeCacheDir(a.cacheDir ?? undefined)
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
      const id = Number(/^(\d+)\.(log|sb|cache)$/.exec(f)?.[1])
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
  if (failure === INTERRUPTED || failure === RELEASED) return { state: 'idle', bubble: failure }
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
  const failure = run.exitCode === -1 && (last.startsWith(SPAWN_FAILED) || last.startsWith(TIMED_OUT) || last === INTERRUPTED || last === RELEASED) ? lines.pop()! : null
  return runOutcome(run.exitCode ?? -1, lines, failure)
}
