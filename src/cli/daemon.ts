// Daemon lifecycle (start/stop/restart), status, logs and `hq open`.
// launchd mode when the daemon LaunchAgent plist is installed; otherwise a detached process tracked by $HQ_HOME/daemon.pid.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiRequest, probeHq, readToken, waitFor, type HqProbe } from './api.ts'
import { DAEMON_LABEL, daemonLog, lockFile, logsDir, pidFile, plistPath, runCmd, showCmd, type Ctx } from './ctx.ts'

export const LOG_MAX_BYTES = 10 * 1024 * 1024
export const LOG_KEEP = 3
const START_WAIT_MS = 10_000

/** Rotates file → file.1 → … → file.<keep> once it reaches maxBytes. */
export function rotateLog(file: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  try { if (statSync(file).size < maxBytes) return false } catch { return false }
  rmSync(`${file}.${keep}`, { force: true })
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
  renameSync(file, `${file}.1`)
  return true
}

export const launchdInstalled = (ctx: Ctx) => existsSync(plistPath(ctx, DAEMON_LABEL))
const target = (ctx: Ctx) => `gui/${ctx.uid}/${DAEMON_LABEL}`
const launchdLoaded = async (ctx: Ctx) => (await ctx.run('launchctl', ['print', target(ctx)], { timeoutMs: 5000 })).code === 0

export function readPid(ctx: Ctx): number | null {
  try { const n = Number(readFileSync(pidFile(ctx), 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null } catch { return null }
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
/** Command line of a live pid, or null when the process is gone. */
export async function pidCommand(pid: number): Promise<string | null> {
  if (!alive(pid)) return null
  const r = await runCmd('ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 5000 })
  return r.code === 0 ? r.stdout.trim() : null
}

/** First integer in $HQ_HOME/daemon.lock (plain "123" or JSON like {"pid":123}); null if absent or unreadable. */
export function readLockPid(ctx: Ctx): number | null {
  try {
    const m = /\d+/.exec(readFileSync(lockFile(ctx), 'utf8'))
    const n = m ? Number(m[0]) : 0
    return n > 0 ? n : null
  } catch { return null }
}

export type KillTarget = { pid: number; source: 'lock' | 'pidfile' } | { refuse: string } | null

/**
 * The only process `stop` may signal. With a daemon lock present that is the lock's pid and nothing else;
 * without one (older daemon) the CLI's own pidfile. Either way the command line must contain src/main.ts.
 */
export async function killTarget(ctx: Ctx): Promise<KillTarget> {
  if (existsSync(lockFile(ctx))) {
    const pid = readLockPid(ctx)
    if (!pid) return null
    const cmd = await pidCommand(pid)
    if (cmd === null) return null // stale lock
    if (!cmd.includes('src/main.ts')) return { refuse: `잠금 파일 ${lockFile(ctx)}의 pid ${pid}는 hq 데몬이 아닙니다 (${cmd.slice(0, 80)}). 종료하지 않습니다. 오래된 잠금이면: rm ${lockFile(ctx)}` }
    return { pid, source: 'lock' }
  }
  const pid = readPid(ctx)
  if (!pid) return null
  const cmd = await pidCommand(pid)
  return cmd !== null && cmd.includes('src/main.ts') ? { pid, source: 'pidfile' } : null
}

/** Signals the kill target and waits; returns the pid it stopped, null if none, or an error message. */
export async function stopTarget(ctx: Ctx): Promise<{ pid: number } | { error: string } | null> {
  const t = await killTarget(ctx)
  if (!t) return null
  if ('refuse' in t) return { error: t.refuse }
  if (ctx.dryRun) ctx.out(`[dry-run] kill -TERM ${t.pid}`)
  else process.kill(t.pid, 'SIGTERM')
  if (!ctx.dryRun && !(await waitFor(async () => !alive(t.pid), START_WAIT_MS))) return { error: `pid ${t.pid}가 종료되지 않았습니다. 강제 종료: kill -9 ${t.pid}` }
  if (!ctx.dryRun) rmSync(pidFile(ctx), { force: true })
  return { pid: t.pid }
}

function busyMessage(ctx: Ctx, p: HqProbe): string | null {
  if (p.kind === 'hq') return `이미 hq가 127.0.0.1:${ctx.port}에서 실행 중입니다 (중복 실행 거부). 재시작: hq restart`
  if (p.kind === 'unauthorized') return `포트 ${ctx.port}에서 다른 토큰을 쓰는 hq가 실행 중입니다. 그 프로세스를 먼저 종료하세요 (lsof -nP -iTCP:${ctx.port} -sTCP:LISTEN)`
  if (p.kind === 'other') return `포트 ${ctx.port}를 다른 프로그램이 쓰고 있습니다 (HTTP ${p.status}). lsof -nP -iTCP:${ctx.port} -sTCP:LISTEN 으로 확인하거나 HQ_PORT를 바꾸세요`
  if (p.kind === 'error') return `포트 ${ctx.port} 확인 실패: ${p.message}`
  return null
}

async function waitUp(ctx: Ctx): Promise<boolean> {
  if (ctx.dryRun) { ctx.out('[dry-run] 데몬 응답 확인 생략'); return true }
  return waitFor(async () => (await probeHq(ctx, 1000)).kind === 'hq', START_WAIT_MS)
}
async function waitDown(ctx: Ctx, pid?: number): Promise<boolean> {
  if (ctx.dryRun) return true
  return waitFor(async () => (pid ? !alive(pid) : true) && (await probeHq(ctx, 1000)).kind !== 'hq', START_WAIT_MS)
}

function failStart(ctx: Ctx): number {
  ctx.err(`데몬이 ${START_WAIT_MS / 1000}초 안에 응답하지 않았습니다. 로그 확인: hq logs  (${daemonLog(ctx)})`)
  return 1
}

export async function start(ctx: Ctx): Promise<number> {
  const busy = busyMessage(ctx, await probeHq(ctx))
  if (busy) { ctx.err(busy); return 1 }
  const lockPid = readLockPid(ctx)
  if (lockPid && alive(lockPid)) {
    ctx.err(`데몬 잠금 ${lockFile(ctx)}의 pid ${lockPid}가 살아 있어 시작하지 않습니다 (중복 실행 거부). 상태: hq status · 중지: hq stop`)
    return 1
  }
  mkdirSync(logsDir(ctx), { recursive: true })
  rotateLog(daemonLog(ctx))
  if (launchdInstalled(ctx)) {
    const r = await launchdLoaded(ctx)
      ? await ctx.act('launchctl', ['kickstart', target(ctx)])
      : await ctx.act('launchctl', ['bootstrap', `gui/${ctx.uid}`, plistPath(ctx, DAEMON_LABEL)])
    if (r.code !== 0) { ctx.err(`launchctl 실패: ${r.stderr.trim()}`); return 1 }
  } else {
    const own = await killTarget(ctx)
    if (own && 'pid' in own) { ctx.err(`pid ${own.pid}의 hq가 이미 떠 있지만 아직 응답하지 않습니다. 잠시 후 hq status, 안 되면 hq restart`); return 1 }
    const args = [join(ctx.root, 'src/main.ts')]
    if (ctx.dryRun) ctx.out(`[dry-run] ${showCmd(process.execPath, args)} (백그라운드, 로그 ${daemonLog(ctx)})`)
    else {
      const fd = openSync(daemonLog(ctx), 'a')
      const child = spawn(process.execPath, args, {
        cwd: ctx.root, detached: true, stdio: ['ignore', fd, fd],
        env: { ...ctx.env, HQ_HOME: ctx.home, HQ_PORT: String(ctx.port) },
      })
      closeSync(fd)
      child.unref()
      writeFileSync(pidFile(ctx), `${child.pid}\n`)
    }
  }
  if (!(await waitUp(ctx))) return failStart(ctx)
  ctx.out(`hq 시작됨 (127.0.0.1:${ctx.port}, ${launchdInstalled(ctx) ? 'launchd' : '백그라운드 프로세스'})`)
  return 0
}

export async function stop(ctx: Ctx): Promise<number> {
  if (launchdInstalled(ctx) && await launchdLoaded(ctx)) {
    // SIGTERM → daemon exits 0 → KeepAlive{SuccessfulExit:false} does not restart it. It comes back on next login or `hq start`.
    const r = await ctx.act('launchctl', ['kill', 'SIGTERM', target(ctx)])
    if (r.code !== 0 && !/not running|No such process/i.test(r.stderr)) { ctx.err(`launchctl 실패: ${r.stderr.trim()}`); return 1 }
    if (!(await waitDown(ctx))) { ctx.err('데몬이 종료되지 않았습니다. hq logs 확인'); return 1 }
    ctx.out('hq 중지됨 (launchd 작업은 로드된 채 유지: 다음 로그인 또는 hq start 때 다시 시작)')
    return 0
  }
  const r = await stopTarget(ctx)
  if (r && 'error' in r) { ctx.err(r.error); return 1 }
  if (r) {
    if (!(await waitDown(ctx))) { ctx.err('데몬 프로세스는 끝났지만 포트가 아직 응답합니다. hq status 확인'); return 1 }
    ctx.out(`hq 중지됨 (pid ${r.pid})`)
    return 0
  }
  if (!ctx.dryRun) rmSync(pidFile(ctx), { force: true })
  const p = await probeHq(ctx)
  if (p.kind === 'hq' || p.kind === 'unauthorized') {
    ctx.err(`127.0.0.1:${ctx.port}의 hq는 이 CLI가 시작한 프로세스가 아닙니다 (직접 실행한 node src/main.ts 등). 그 터미널에서 종료하거나: lsof -nP -iTCP:${ctx.port} -sTCP:LISTEN`)
    return 1
  }
  ctx.out('hq가 실행 중이 아닙니다')
  return 0
}

export async function restart(ctx: Ctx): Promise<number> {
  if (launchdInstalled(ctx) && await launchdLoaded(ctx)) {
    rotateLog(daemonLog(ctx))
    const r = await ctx.act('launchctl', ['kickstart', '-k', target(ctx)])
    if (r.code !== 0) { ctx.err(`launchctl 실패: ${r.stderr.trim()}`); return 1 }
    if (!(await waitUp(ctx))) return failStart(ctx)
    ctx.out(`hq 재시작됨 (127.0.0.1:${ctx.port}, launchd)`)
    return 0
  }
  const s = await stop(ctx)
  if (s !== 0) return s
  return start(ctx)
}

// ---- status ----

export interface StatusView {
  up: boolean
  port: number
  headline: string | null
  needsYou: number
  workers: { title: string; model: string; state: string; bubble: string }[]
  quota: { fiveHour: number | null; sevenDay: number | null; mode: string } | null
  limitBlockedUntil: string | null
  olderDaemon: boolean
}

/** Tolerates snapshots from older daemons (no workers/headline/quota). */
export function statusFromSnapshot(port: number, s: Record<string, any>): StatusView {
  const hasNew = 'headline' in s || 'workers' in s || 'quota' in s
  const approvals = Array.isArray(s.approvals) ? s.approvals.length : 0
  const workers = Array.isArray(s.workers) ? s.workers.map((w: Record<string, unknown>) => ({
    title: String(w.title ?? ''), model: String(w.model ?? ''), state: String(w.state ?? ''), bubble: String(w.bubble ?? '') })) : []
  const q = s.quota && typeof s.quota === 'object' ? s.quota : null
  return {
    up: true, port,
    headline: s.headline && typeof s.headline.text === 'string' && s.headline.text ? s.headline.text : null,
    needsYou: typeof s.headline?.needsYou === 'number' ? s.headline.needsYou : approvals,
    workers,
    quota: q ? { fiveHour: q.fiveHour ?? null, sevenDay: q.sevenDay ?? null, mode: String(q.mode ?? 'normal') } : null,
    limitBlockedUntil: s.limit?.blockedUntil ?? null,
    olderDaemon: !hasNew,
  }
}

const pct = (v: number | null) => (v == null ? '?' : `${Math.round(v * 100)}%`)

export async function status(ctx: Ctx, opts: { json: boolean }): Promise<number> {
  const p = await probeHq(ctx)
  if (p.kind !== 'hq') {
    const why = p.kind === 'down' ? '꺼져 있음' : p.kind === 'unauthorized' ? '토큰 불일치 (401)' : p.kind === 'other' ? `다른 프로그램이 포트 사용 (HTTP ${p.status})` : p.message
    if (opts.json) ctx.out(JSON.stringify({ up: false, port: ctx.port, reason: why }, null, 2))
    else {
      ctx.out(`데몬: ${why} (127.0.0.1:${ctx.port})`)
      ctx.out(launchdInstalled(ctx) ? '시작: hq start' : '시작: hq start  (로그인 때 자동 시작: hq install)')
      if (p.kind !== 'down') ctx.out('진단: hq doctor')
    }
    return 1
  }
  const v = statusFromSnapshot(ctx.port, p.snapshot)
  if (opts.json) { ctx.out(JSON.stringify(v, null, 2)); return 0 }
  ctx.out(`데몬: 실행 중 (127.0.0.1:${ctx.port})`)
  ctx.out(`상황: ${v.headline ?? (v.olderDaemon ? '(이전 버전 데몬: 상황 문장 없음)' : '지금 하실 일은 없어요')}`)
  ctx.out(`결정 대기: ${v.needsYou}건`)
  if (!v.workers.length) ctx.out('작업자: 없음')
  else {
    ctx.out(`작업자 ${v.workers.length}명:`)
    for (const w of v.workers) ctx.out(`  - [${w.model}] ${w.title} · ${w.state}${w.bubble ? ` · ${w.bubble}` : ''}`)
  }
  if (v.quota) ctx.out(`사용 한도: 5시간 ${pct(v.quota.fiveHour)} · 7일 ${pct(v.quota.sevenDay)} · 모드 ${v.quota.mode}`)
  else ctx.out('사용 한도: 정보 없음')
  if (v.limitBlockedUntil) ctx.out(`한도 보류: ${v.limitBlockedUntil}까지`)
  return 0
}

// ---- open ----

/** Only http://127.0.0.1:<port>/... (e.g. /ui/#code=... from contract v2, or the older /ui/open?code=...). */
export function isLocalUiUrl(url: string, port: number): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(port) && !u.username && !u.password
    && url.startsWith(`http://127.0.0.1:${port}/`)
}

export async function openUi(ctx: Ctx): Promise<number> {
  let r
  try { r = await apiRequest(ctx.port, readToken(ctx), 'POST', '/api/ui-code', {}) } catch {
    ctx.err(`데몬에 연결할 수 없습니다 (127.0.0.1:${ctx.port}). 시작: hq start`); return 1
  }
  if (r.status !== 200 || typeof r.body?.url !== 'string') { ctx.err(`웹 화면 코드 발급 실패 (HTTP ${r.status}). 진단: hq doctor`); return 1 }
  const url: string = r.body.url
  if (!isLocalUiUrl(url, ctx.port)) { ctx.err('데몬이 로컬이 아닌 주소를 돌려줘 열지 않았습니다'); return 1 }
  const o = await ctx.act('open', [url])
  if (o.code !== 0) { ctx.err(`브라우저를 열지 못함: ${o.stderr.trim()}`); return 1 }
  ctx.out('웹 화면을 열었습니다 (일회용 링크, 60초 유효 · 세션은 그 브라우저 탭에만 유지)')
  return 0
}

// ---- logs ----

export function tailLines(file: string, n: number): string[] {
  const size = statSync(file).size
  const fd = openSync(file, 'r')
  try {
    const len = Math.min(size, 256 * 1024)
    const buf = Buffer.alloc(len)
    readSyncAll(fd, buf, size - len)
    const lines = buf.toString('utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines.slice(-n)
  } finally { closeSync(fd) }
}
function readSyncAll(fd: number, buf: Buffer, pos: number) {
  let off = 0
  while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, pos + off); if (!n) break; off += n }
}

export async function logs(ctx: Ctx, opts: { follow: boolean; lines?: number }): Promise<number> {
  const file = daemonLog(ctx)
  if (!existsSync(file)) { ctx.err(`로그 파일이 아직 없습니다: ${file} (hq start 후 생성)`); return 1 }
  const n = opts.lines ?? 200
  if (!opts.follow) { for (const l of tailLines(file, n)) ctx.out(l); return 0 }
  return new Promise((done) => {
    const child = spawn('tail', ['-n', String(n), '-F', file], { stdio: 'inherit' })
    const stopTail = () => child.kill('SIGTERM')
    process.once('SIGINT', stopTail)
    child.on('close', () => { process.off('SIGINT', stopTail); done(0) })
  })
}
