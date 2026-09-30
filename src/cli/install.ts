// `hq install` / `hq uninstall`: pet build, sprites, LaunchAgents, verification.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { loadConfig } from '../config.ts'
import { probeHq, waitFor } from './api.ts'
import { DAEMON_LABEL, PET_LABEL, daemonLog, findBin, logsDir, petApp, petBinary, petLog, pidFile, plistPath, type Ctx, writeAtomic } from './ctx.ts'
import { alive, ownDaemonPid } from './daemon.ts'
import { printDoctor, realProbes, runDoctor, type Probes } from './doctor.ts'
import { daemonPlist, launchPath, petPlist } from './plist.ts'

const hasSprites = (ctx: Ctx) => ['pokemon', 'digimon'].every((k) => {
  try { return readdirSync(join(ctx.root, 'pet/packs', k, 'pool')).length > 0 } catch { return false }
})

export function buildPlists(ctx: Ctx) {
  let claudeName = 'claude'
  try { claudeName = loadConfig(ctx.root, ctx.env).claudeBin } catch { /* doctor already reported */ }
  const path = launchPath([process.execPath, findBin(claudeName, ctx.env.PATH), findBin('git', ctx.env.PATH)])
  return {
    daemon: daemonPlist({
      nodePath: process.execPath, root: ctx.root, home: ctx.home, port: ctx.port, path, logFile: daemonLog(ctx),
      tokenFile: ctx.env.HQ_TOKEN_FILE ? ctx.tokenFile : undefined,
    }),
    pet: petPlist({ appBinary: petBinary(ctx), logFile: petLog(ctx) }),
  }
}

async function bootstrap(ctx: Ctx, label: string): Promise<boolean> {
  await ctx.act('launchctl', ['bootout', `gui/${ctx.uid}/${label}`]) // not loaded yet → error, ignored
  const r = await ctx.act('launchctl', ['bootstrap', `gui/${ctx.uid}`, plistPath(ctx, label)])
  if (r.code !== 0) { ctx.err(`launchctl bootstrap 실패 (${label}): ${r.stderr.trim()}`); return false }
  return true
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

export async function install(ctx: Ctx, opts: { sprites: boolean; probes?: Probes }): Promise<number> {
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
  const pid = await ownDaemonPid(ctx)
  if (pid) {
    ctx.out(`  백그라운드 데몬(pid ${pid})을 멈추고 launchd로 옮깁니다`)
    if (ctx.dryRun) ctx.out(`[dry-run] kill -TERM ${pid}`)
    else {
      process.kill(pid, 'SIGTERM')
      await waitFor(async () => !alive(pid), 10_000)
      rmSync(pidFile(ctx), { force: true })
    }
  } else {
    const p = await probeHq(ctx)
    const ours = (await ctx.run('launchctl', ['print', `gui/${ctx.uid}/${DAEMON_LABEL}`], { timeoutMs: 5000 })).code === 0
    if ((p.kind === 'hq' || p.kind === 'unauthorized') && !ours) {
      ctx.err(`127.0.0.1:${ctx.port}에 직접 실행한 hq가 떠 있습니다. 그 프로세스를 먼저 종료하세요 (lsof -nP -iTCP:${ctx.port} -sTCP:LISTEN)`)
      return 1
    }
    ctx.out('  정리할 것 없음')
  }

  ctx.out('5/6 LaunchAgent 등록 (로그인 때 자동 시작)')
  mkdirSync(logsDir(ctx), { recursive: true })
  const pl = buildPlists(ctx)
  writeAtomic(plistPath(ctx, DAEMON_LABEL), pl.daemon)
  writeAtomic(plistPath(ctx, PET_LABEL), pl.pet)
  ctx.out(`  ${plistPath(ctx, DAEMON_LABEL)}`)
  ctx.out(`  ${plistPath(ctx, PET_LABEL)}`)
  if (!(await bootstrap(ctx, DAEMON_LABEL))) return 1

  ctx.out('6/6 데몬 응답 확인')
  if (ctx.dryRun) ctx.out('[dry-run] 데몬 응답 확인 생략')
  else if (!(await waitFor(async () => (await probeHq(ctx, 1000)).kind === 'hq', 10_000))) {
    ctx.err(`데몬이 10초 안에 응답하지 않았습니다. 로그: hq logs  (${daemonLog(ctx)})`)
    return 1
  }
  if (!(await bootstrap(ctx, PET_LABEL))) return 1
  ctx.out(`  데몬 응답 확인됨 (127.0.0.1:${ctx.port}), 펫 실행`)

  linkHint(ctx)
  ctx.out('')
  ctx.out('설치 완료. 화면의 펫(CEO)을 클릭해 첫 요청을 보내보세요. 상태: hq status · 진단: hq doctor')
  return 0
}

export async function uninstall(ctx: Ctx, opts: { purge: boolean; yes: boolean }): Promise<number> {
  if (opts.purge && !opts.yes) {
    ctx.err(`--purge는 ${ctx.home} (DB·worktree·증거)와 토큰 파일을 지웁니다. 확인하려면 --purge --yes`)
    return 2
  }
  for (const label of [PET_LABEL, DAEMON_LABEL]) {
    await ctx.act('launchctl', ['bootout', `gui/${ctx.uid}/${label}`])
    const f = plistPath(ctx, label)
    if (existsSync(f)) {
      if (ctx.dryRun) ctx.out(`[dry-run] rm ${f}`)
      else rmSync(f, { force: true })
      ctx.out(`삭제: ${f}`)
    }
  }
  const pid = await ownDaemonPid(ctx)
  if (pid) {
    if (ctx.dryRun) ctx.out(`[dry-run] kill -TERM ${pid}`)
    else { process.kill(pid, 'SIGTERM'); await waitFor(async () => !alive(pid), 10_000); rmSync(pidFile(ctx), { force: true }) }
    ctx.out(`백그라운드 데몬 중지 (pid ${pid})`)
  }
  const link = join(ctx.binDir, 'hq')
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === join(ctx.root, 'bin/hq')) {
      if (ctx.dryRun) ctx.out(`[dry-run] rm ${link}`)
      else rmSync(link)
      ctx.out(`삭제: ${link}`)
    }
  } catch { /* no link */ }
  if (opts.purge) {
    const h = resolve(ctx.home)
    if (h === '/' || h === resolve(ctx.userHome) || resolve(ctx.root).startsWith(h + '/') || h === resolve(ctx.root)) {
      ctx.err(`안전을 위해 ${h}는 지우지 않습니다 (HQ_HOME 확인)`)
      return 1
    }
    for (const f of [h, ctx.tokenFile, petApp(ctx)]) {
      if (!existsSync(f)) continue
      if (ctx.dryRun) ctx.out(`[dry-run] rm -rf ${f}`)
      else rmSync(f, { recursive: true, force: true })
      ctx.out(`삭제: ${f}`)
    }
  }
  ctx.out(opts.purge ? '제거 완료 (데이터 포함). 저장소 폴더와 config/는 그대로 둡니다.' : `제거 완료. 데이터(${ctx.home})는 남겨 둡니다. 모두 지우려면: hq uninstall --purge --yes`)
  return 0
}
