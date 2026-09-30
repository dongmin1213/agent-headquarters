// `hq install` / `hq uninstall`: pet build, sprites, LaunchAgents, verification.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { loadConfig } from '../config.ts'
import { probeHq, waitFor } from './api.ts'
import { daemonLabel, daemonLog, findBin, installMarker, installSuffix, launchdJob, launchdTarget, logsDir, markerContent, markerMatches, petApp, petBinary, petLabel, petLog, plistPath, samePath, type Ctx, writeAtomic } from './ctx.ts'
import { alive, readLockPid, stopTarget } from './daemon.ts'
import { printDoctor, realProbes, runDoctor, type Probes } from './doctor.ts'
import { daemonPlist, launchPath, petPlist } from './plist.ts'
import { hqReadPaths, protectedFolders, tccLabels } from './tcc.ts'

const hasSprites = (ctx: Ctx) => ['pokemon', 'digimon'].every((k) => {
  try { return readdirSync(join(ctx.root, 'pet/packs', k, 'pool')).length > 0 } catch { return false }
})

export function buildPlists(ctx: Ctx) {
  let claudeName = 'claude'
  try { claudeName = loadConfig(ctx.root, ctx.env).claudeBin } catch { /* doctor already reported */ }
  const path = launchPath([process.execPath, findBin(claudeName, ctx.env.PATH), findBin('git', ctx.env.PATH)])
  return {
    daemon: daemonPlist({
      label: daemonLabel(ctx), nodePath: process.execPath, root: ctx.root, home: ctx.home, port: ctx.port, path, logFile: daemonLog(ctx),
      tokenFile: ctx.env.HQ_TOKEN_FILE ? ctx.tokenFile : undefined,
    }),
    pet: petPlist({ label: petLabel(ctx), appBinary: petBinary(ctx), logFile: petLog(ctx), port: ctx.port, tokenFile: ctx.tokenFile, suffix: installSuffix(ctx) }),
  }
}

const foreignMsg = (label: string) => `launchd 작업(${label})은 다른 설치의 plist로 이미 로드돼 있어 건드리지 않습니다. 확인: launchctl print gui/<uid>/${label}`

/** launchd timing (tests shrink these): poll `print` after bootout until the job is gone, then retry a racing bootstrap. */
export interface LaunchdTiming { pollMs: number; goneMs: number; retryMs: number; attempts: number }
export const LAUNCHD_TIMING: LaunchdTiming = { pollMs: 250, goneMs: 10_000, retryMs: 1000, attempts: 4 }
/** bootstrap stderr seen while launchd is still tearing the old job down (`Bootstrap failed: 5: Input/output error`). */
const RACE_RE = /Bootstrap failed: 5|Input\/output error|already/i
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type BootResult = { ok: true } | { ok: false; stderr: string }

/** bootout → wait until `launchctl print` fails (job gone, max goneMs) → bootstrap, retrying the teardown race. */
async function bootstrap(ctx: Ctx, label: string, t: LaunchdTiming): Promise<BootResult> {
  if (await launchdJob(ctx, label) === 'foreign') { ctx.err(foreignMsg(label)); return { ok: false, stderr: foreignMsg(label) } }
  const target = launchdTarget(ctx, label)
  await ctx.act('launchctl', ['bootout', target]) // not loaded yet → error, ignored
  if (!ctx.dryRun) {
    // Gone = print exits non-zero. Still present after goneMs → try anyway (the retry below covers it).
    await waitFor(async () => (await ctx.run('launchctl', ['print', target], { timeoutMs: 5000 })).code !== 0, t.goneMs, t.pollMs)
  }
  let stderr = ''
  for (let i = 1; i <= t.attempts; i++) {
    const r = await ctx.act('launchctl', ['bootstrap', `gui/${ctx.uid}`, plistPath(ctx, label)])
    if (r.code === 0) return { ok: true }
    stderr = (r.stderr || r.stdout).trim().split('\n')[0] ?? ''
    // A failed bootstrap whose job is nevertheless loaded from our plist did its job.
    if (await launchdJob(ctx, label) === 'ours') return { ok: true }
    if (i === t.attempts || !RACE_RE.test(r.stderr)) break
    await sleep(t.retryMs)
  }
  ctx.err(`launchctl bootstrap 실패 (${label}): ${stderr}`)
  return { ok: false, stderr }
}

function linkHint(ctx: Ctx): void {
  const shim = join(ctx.root, 'bin/hq')
  const link = join(ctx.binDir, 'hq')
  const onPath = (ctx.env.PATH ?? '').split(delimiter).map((d) => resolve(d)).includes(ctx.binDir)
  let existing: string | null = null
  try { if (lstatSync(link).isSymbolicLink()) existing = readlinkSync(link); else existing = '(일반 파일)' } catch { /* none */ }
  if (existing === shim) { ctx.out(`hq 명령: ${link} → ${shim} (이미 연결됨)`); return }
  if (existsSync(ctx.binDir) && onPath && existing === null) {
    if (ctx.dryRun) ctx.out(`[dry-run] ln -s ${shim} ${link}`)
    else symlinkSync(shim, link)
    ctx.out(`hq 명령 연결: ${link} → ${shim}`)
    return
  }
  ctx.out(`hq 명령을 어디서나 쓰려면 PATH에 추가하세요: export PATH="${join(ctx.root, 'bin')}:$PATH"`)
}

export interface InstallOpts {
  sprites: boolean
  probes?: Probes
  /** Step-6 daemon wait in ms (tests override): normal 10 s, 90 s when a macOS TCC dialog may appear. */
  daemonWaitMs?: number
  protectedWaitMs?: number
  launchd?: Partial<LaunchdTiming>
}

export async function install(ctx: Ctx, opts: InstallOpts): Promise<number> {
  ctx.out('1/6 환경 진단')
  const checks = await runDoctor(ctx, opts.probes ?? realProbes(ctx))
  if (checks.some((c) => c.status === 'fail')) {
    printDoctor(ctx, checks, false)
    ctx.err('설치 중단: [실패] 항목을 먼저 해결하세요')
    return 5
  }
  ctx.out(`  통과 (경고 ${checks.filter((c) => c.status === 'warn').length}건은 hq doctor로 확인)`)

  ctx.out('2/6 펫 스프라이트')
  if (!opts.sprites) ctx.out('  건너뜀 (--no-sprites) — 펫은 기본 아이콘으로 표시')
  else if (hasSprites(ctx)) ctx.out('  이미 있음')
  else {
    ctx.out('  포켓몬·디지몬 스프라이트는 제3자 저작물입니다. 공개 저장소에서 이 맥에만 내려받고 저장소에 포함하지 않습니다.')
    const r = await ctx.act('/bin/bash', [join(ctx.root, 'scripts/fetch-packs.sh')], { timeoutMs: 300_000 })
    if (r.code !== 0) ctx.out(`  경고: 스프라이트 받기 실패 (exit ${r.code}) — 기본 아이콘으로 계속. 나중에 scripts/fetch-packs.sh 후 hq install`)
  }

  ctx.out('3/6 펫 빌드 (swiftc)')
  const b = await ctx.act('/bin/sh', [join(ctx.root, 'pet/build.sh')], { timeoutMs: 600_000 })
  if (b.code !== 0 || (!ctx.dryRun && !existsSync(petBinary(ctx)))) {
    ctx.err(`펫 빌드 실패 (exit ${b.code}):\n${(b.stderr || b.stdout).trim().split('\n').slice(-15).join('\n')}`)
    return 1
  }
  ctx.out(`  ${petApp(ctx)}`)

  ctx.out('4/6 기존 데몬 정리')
  if (await launchdJob(ctx, daemonLabel(ctx)) === 'ours') {
    // Our launchd job is replaced by 5/6 (bootout → bootstrap); its process is never signalled directly.
    ctx.out('  launchd 데몬은 5/6에서 새 설정으로 다시 띄웁니다')
  } else {
    const moved = await stopTarget(ctx)
    if (moved && 'error' in moved) { ctx.err(moved.error); return 1 }
    if (moved) ctx.out(`  백그라운드 데몬(pid ${moved.pid})을 멈추고 launchd로 옮깁니다`)
    else {
      const p = await probeHq(ctx)
      if (p.kind === 'hq' || p.kind === 'unauthorized') {
        ctx.err(`127.0.0.1:${ctx.port}에 직접 실행한 hq가 떠 있습니다. 그 프로세스를 먼저 종료하세요 (lsof -nP -iTCP:${ctx.port} -sTCP:LISTEN)`)
        return 1
      }
      ctx.out('  정리할 것 없음')
    }
  }

  const tcc = protectedFolders(hqReadPaths(ctx), ctx.userHome)
  const labels = tccLabels(tcc)

  ctx.out('5/6 LaunchAgent 등록 (로그인 때 자동 시작)')
  for (const label of [daemonLabel(ctx), petLabel(ctx)]) {
    if (await launchdJob(ctx, label) === 'foreign') { ctx.err(foreignMsg(label)); return 1 }
  }
  if (ctx.dryRun) ctx.out(`[dry-run] mkdir -p ${logsDir(ctx)} · write ${installMarker(ctx)}`)
  else {
    mkdirSync(logsDir(ctx), { recursive: true })
    // Marker proving $HQ_HOME is this installation's (uninstall --purge deletes it only when it matches).
    if (!markerMatches(ctx)) writeAtomic(installMarker(ctx), markerContent(ctx))
  }
  const pl = buildPlists(ctx)
  for (const [label, content] of [[daemonLabel(ctx), pl.daemon], [petLabel(ctx), pl.pet]] as const) {
    if (ctx.dryRun) ctx.out(`[dry-run] write ${plistPath(ctx, label)}`)
    else writeAtomic(plistPath(ctx, label), content)
    ctx.out(`  ${plistPath(ctx, label)}`)
  }
  const lt: LaunchdTiming = { ...LAUNCHD_TIMING, ...opts.launchd }
  const d = await bootstrap(ctx, daemonLabel(ctx), lt)
  if (!d.ok) {
    ctx.err(`데몬을 다시 등록하지 못했어요: ${d.stderr} · 잠시 뒤 hq install을 다시 실행하거나 launchctl bootstrap gui/${ctx.uid} ${plistPath(ctx, daemonLabel(ctx))}를 실행해 주세요`)
    // The pet needs the daemon: reload it only when a daemon still answers.
    if ((await probeHq(ctx, 1000)).kind === 'hq') await bootstrap(ctx, petLabel(ctx), lt)
    return 1
  }

  ctx.out('6/6 데몬 응답 확인')
  if (ctx.dryRun) ctx.out('[dry-run] 데몬 응답 확인 생략')
  else {
    if (tcc.length) {
      ctx.out(`  macOS가 'node'의 ${labels} 폴더 접근 허용 창을 띄우면 [허용]을 눌러 주세요 (처음 한 번)`)
      ctx.out('  응답 기다리는 중… (최대 90초)')
    }
    const waitMs = tcc.length ? (opts.protectedWaitMs ?? 90_000) : (opts.daemonWaitMs ?? 10_000)
    if (!(await waitFor(async () => (await probeHq(ctx, 1000)).kind === 'hq', waitMs))) {
      ctx.err(tcc.length
        ? `데몬이 90초 안에 응답하지 않았습니다. 화면에 'node'의 ${labels} 폴더 접근 허용 창이 떠 있으면 [허용]을 누른 뒤 hq install을 다시 실행하세요. 거부했다면: 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더 → node. 로그: hq logs  (${daemonLog(ctx)})`
        : `데몬이 10초 안에 응답하지 않았습니다. 로그: hq logs  (${daemonLog(ctx)})`)
      return 1
    }
  }
  if (!(await bootstrap(ctx, petLabel(ctx), lt)).ok) return 1
  ctx.out(`  데몬 응답 확인됨 (127.0.0.1:${ctx.port}), 펫 실행`)

  linkHint(ctx)
  ctx.out('')
  ctx.out('설치 완료. 화면의 펫(사장)을 클릭해 첫 요청을 보내보세요. 상태: hq status · 진단: hq doctor')
  return 0
}

export interface PurgePlan { home: string | null; token: string | null; petApp: string | null; notes: string[] }

/** Decides what `--purge` may delete, before anything is touched. Any doubt is an error and nothing is deleted. */
export function purgePlan(ctx: Ctx): PurgePlan | { error: string } {
  const notes: string[] = []
  const h = resolve(ctx.home)
  if (h === '/' || h === resolve(ctx.userHome) || resolve(ctx.userHome).startsWith(h + '/') || resolve(ctx.root).startsWith(h + '/') || h === resolve(ctx.root)) {
    return { error: `안전을 위해 데이터 폴더(${h})는 지우지 않습니다 (HQ_HOME 확인)` }
  }
  let home: string | null = null
  if (existsSync(h)) {
    if (!markerMatches(ctx)) {
      return { error: `${h}에 이 설치의 표식(${installMarker(ctx)})이 없거나 맞지 않아 아무것도 지우지 않았어요 · 이 폴더가 hq 데이터가 맞다면 hq install을 한 번 다시 실행해 표식을 만든 뒤 다시 시도하거나 직접 지워 주세요` }
    }
    home = h
  }
  let token: string | null = null
  let st: ReturnType<typeof lstatSync> | null = null
  try { st = lstatSync(ctx.tokenFile) } catch { /* absent */ }
  if (st) {
    if (!st.isFile()) return { error: `토큰 경로(${ctx.tokenFile})가 일반 파일이 아니라(폴더·심볼릭 링크 등) 아무것도 지우지 않았어요 · HQ_TOKEN_FILE을 확인해 주세요` }
    const defaultToken = resolve(ctx.userHome, '.config/hq/token')
    if (installSuffix(ctx) !== null && samePath(ctx.tokenFile, defaultToken)) notes.push(`기본 설치의 토큰(${ctx.tokenFile})은 남겨 둡니다`)
    else token = ctx.tokenFile
  }
  // The pet app lives in the repository and is shared by every installation from it; only the default one removes it.
  let pet: string | null = null
  if (existsSync(petApp(ctx))) {
    if (installSuffix(ctx) === null) pet = petApp(ctx)
    else notes.push(`펫 앱(${petApp(ctx)})은 기본 설치와 함께 쓰므로 남겨 둡니다`)
  }
  return { home, token, petApp: pet, notes }
}

/** True once this installation's daemon is gone: the lock pid is dead and the port no longer answers as hq. */
async function daemonDown(ctx: Ctx, waitMs = 10_000): Promise<boolean> {
  return waitFor(async () => {
    const pid = readLockPid(ctx)
    if (pid && alive(pid)) return false
    const p = await probeHq(ctx, 1000)
    return p.kind !== 'hq' && p.kind !== 'unauthorized'
  }, waitMs)
}

export async function uninstall(ctx: Ctx, opts: { purge: boolean; yes: boolean; downWaitMs?: number }): Promise<number> {
  if (opts.purge && !opts.yes) {
    ctx.err(`--purge는 ${ctx.home} (DB·worktree·증거)와 토큰 파일을 지웁니다. 확인하려면 --purge --yes`)
    return 2
  }
  let plan: PurgePlan | null = null
  if (opts.purge) {
    const r = purgePlan(ctx)
    if ('error' in r) { ctx.err(r.error); return 1 }
    plan = r
  }
  let daemonBootedOut = false
  for (const label of [petLabel(ctx), daemonLabel(ctx)]) {
    const job = await launchdJob(ctx, label)
    if (job === 'foreign') ctx.err(`경고: ${foreignMsg(label)}`)
    else {
      await ctx.act('launchctl', ['bootout', launchdTarget(ctx, label)])
      if (job === 'ours' && label === daemonLabel(ctx)) daemonBootedOut = true
    }
    const f = plistPath(ctx, label)
    if (existsSync(f)) {
      if (ctx.dryRun) ctx.out(`[dry-run] rm ${f}`)
      else rmSync(f, { force: true })
      ctx.out(`삭제: ${f}`)
    }
  }
  // bootout already sent SIGTERM to our launchd daemon; let it exit before looking at the lock.
  if (daemonBootedOut && !ctx.dryRun) await daemonDown(ctx, opts.downWaitMs)
  const stopped = await stopTarget(ctx)
  if (stopped && 'error' in stopped) ctx.err(`경고: ${stopped.error}`)
  else if (stopped) ctx.out(`백그라운드 데몬 중지 (pid ${stopped.pid})`)
  const link = join(ctx.binDir, 'hq')
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === join(ctx.root, 'bin/hq')) {
      if (ctx.dryRun) ctx.out(`[dry-run] rm ${link}`)
      else rmSync(link)
      ctx.out(`삭제: ${link}`)
    }
  } catch { /* no link */ }
  if (plan) {
    if (ctx.dryRun) ctx.out('[dry-run] 데몬 종료 확인 생략')
    else if (!(await daemonDown(ctx, opts.downWaitMs))) {
      ctx.err(`데몬이 멈췄는지 확인하지 못해 데이터는 지우지 않았어요 (127.0.0.1:${ctx.port}, ${ctx.home}) · 데몬을 직접 종료한 뒤 hq uninstall --purge --yes를 다시 실행해 주세요`)
      return 1
    }
    for (const n of plan.notes) ctx.out(n)
    for (const f of [plan.home, plan.token, plan.petApp]) {
      if (!f) continue
      if (ctx.dryRun) ctx.out(`[dry-run] rm -rf ${f}`)
      else if (f === plan.token) rmSync(f, { force: true })
      else rmSync(f, { recursive: true, force: true })
      ctx.out(`삭제: ${f}`)
    }
  }
  ctx.out(opts.purge ? '제거 완료 (데이터 포함). 저장소 폴더와 config/는 그대로 둡니다.' : `제거 완료. 데이터(${ctx.home})는 남겨 둡니다. 모두 지우려면: hq uninstall --purge --yes`)
  return 0
}
