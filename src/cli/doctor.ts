// `hq doctor`: environment checks, each with a one-line fix. Probes are injectable for tests.
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from '../config.ts'
import { probeHq, tokenMismatchMsg, type HqProbe } from './api.ts'
import { pidCommand, readLockPid } from './daemon.ts'
import { sandboxSmoke, type SmokeResult } from './sandbox.ts'
import { hqReadPaths, protectedFolders, tccLabels, tccPathList } from './tcc.ts'
import {
  daemonLabel, expandHome, launchdJob, petLabel, findBin, lockFile, petApp, plistPath, projectsFile, runCmd, type Ctx, type ExecResult,
} from './ctx.ts'
import { josa } from '../josa.ts'

export type Status = 'ok' | 'warn' | 'fail'
export interface Check { id: string; title: string; status: Status; detail: string; fix?: string }

export interface Probes {
  platform(): string
  macVersion(): Promise<string | null>
  nodeVersion(): string
  findBin(name: string): string | null
  run(cmd: string, args: string[]): Promise<ExecResult>
  hq(): Promise<HqProbe>
  pgrep(pattern: string): Promise<boolean>
  launchctlLoaded(label: string): Promise<boolean>
  /** Runs the Seatbelt smoke test (src/cli/sandbox.ts) with the given sandbox-exec. */
  sandboxSmoke(sandboxExec: string): Promise<SmokeResult>
  /** Command line of a live pid, null when it is gone. */
  pidCommand(pid: number): Promise<string | null>
}

export function realProbes(ctx: Ctx): Probes {
  return {
    platform: () => process.platform,
    macVersion: async () => {
      const r = await runCmd('sw_vers', ['-productVersion'], { timeoutMs: 5000 })
      return r.code === 0 ? r.stdout.trim() : null
    },
    nodeVersion: () => process.versions.node,
    findBin: (name) => findBin(name, ctx.env.PATH),
    run: (cmd, args) => runCmd(cmd, args, { timeoutMs: 20_000 }),
    hq: () => probeHq(ctx),
    pgrep: async (pattern) => (await runCmd('pgrep', ['-f', pattern], { timeoutMs: 5000 })).code === 0,
    // Loaded *and* this installation's plist (a same-named job from another installation does not count).
    launchctlLoaded: async (label) => (await launchdJob({ ...ctx, run: runCmd }, label)) === 'ours',
    sandboxSmoke: (bin) => sandboxSmoke(bin),
    pidCommand: (pid) => pidCommand(pid),
  }
}

const major = (v: string) => Number(v.replace(/^v/, '').split('.')[0])
const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

function nearestExisting(p: string): string {
  let cur = p
  while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur)
  return cur
}

export const MIN_MACOS = 14
export const MIN_NODE = 26

export async function runDoctor(ctx: Ctx, p: Probes): Promise<Check[]> {
  const checks: Check[] = []
  const add = (id: string, title: string, status: Status, detail: string, fix?: string) =>
    checks.push({ id, title, status, detail, ...(status !== 'ok' && fix ? { fix } : {}) })

  // macOS
  if (p.platform() !== 'darwin') add('macos', 'macOS', 'fail', `지원하지 않는 OS: ${p.platform()}`, 'hq는 macOS 전용입니다 (launchd·Swift 펫 사용)')
  else {
    const v = await p.macVersion()
    if (!v) add('macos', 'macOS', 'warn', '버전을 확인하지 못함 (sw_vers 실패)', `macOS ${MIN_MACOS} 이상인지 직접 확인하세요`)
    else if (major(v) < MIN_MACOS) add('macos', 'macOS', 'fail', `macOS ${v} (필요: ${MIN_MACOS} 이상)`, `macOS ${MIN_MACOS} 이상으로 업데이트하세요 (Swift 6 펫 빌드에 필요)`)
    else add('macos', 'macOS', 'ok', `macOS ${v}`)
  }

  // Node
  const nv = p.nodeVersion()
  if (major(nv) >= MIN_NODE) add('node', 'Node', 'ok', `Node ${nv}`)
  else add('node', 'Node', 'fail', `Node ${nv} (필요: ${MIN_NODE} 이상)`, `Node ${MIN_NODE}+ 설치: brew install node 또는 https://nodejs.org`)

  // Config (also tells us which claude binary the daemon will use)
  let claudeName = 'claude'
  try {
    const c = loadConfig(ctx.root, ctx.env)
    claudeName = c.claudeBin
    add('config', '설정 (config/hq.json)', 'ok', existsSync(join(ctx.root, 'config/hq.json')) ? '유효함' : '파일 없음 → 기본값 사용')
  } catch (e) {
    add('config', '설정 (config/hq.json)', 'fail', (e as Error).message, 'config/hq.json을 고치세요 (docs/SETUP.md "설정" 참고). 모든 키는 선택입니다')
  }

  // Claude CLI
  const claude = p.findBin(claudeName)
  if (!claude) {
    add('claude', 'Claude CLI', 'fail', `'${claudeName}' 실행 파일을 PATH에서 찾지 못함`, 'Claude Code 설치: npm install -g @anthropic-ai/claude-code (설치 후 claude 한 번 실행해 로그인)')
    add('claude-auth', 'Claude 로그인', 'fail', 'CLI가 없어 확인 불가', 'Claude CLI 설치 후 `claude` 실행 → /login')
  } else {
    const ver = await p.run(claude, ['--version'])
    add('claude', 'Claude CLI', ver.code === 0 ? 'ok' : 'fail', ver.code === 0 ? `${firstLine(ver.stdout)} (${claude})` : `실행 실패 (exit ${ver.code})`,
      'Claude Code를 다시 설치하세요: npm install -g @anthropic-ai/claude-code')
    const auth = await p.run(claude, ['auth', 'status'])
    let loggedIn: boolean | null = null
    try { loggedIn = JSON.parse(auth.stdout).loggedIn === true } catch { loggedIn = null }
    // Only the boolean is reported: auth status also prints the account e-mail and org, which never leave this function.
    if (loggedIn === true) add('claude-auth', 'Claude 로그인', 'ok', '로그인됨')
    else if (loggedIn === false) add('claude-auth', 'Claude 로그인', 'fail', '로그인 안 됨', '`claude` 실행 후 /login 으로 구독 계정에 로그인하세요')
    else add('claude-auth', 'Claude 로그인', 'warn', '`claude auth status` 결과를 해석하지 못함', 'Claude CLI를 최신으로 업데이트하고 `claude auth status`를 확인하세요')
  }

  // git
  const git = p.findBin('git')
  const gv = git ? await p.run(git, ['--version']) : null
  if (gv && gv.code === 0) add('git', 'git', 'ok', firstLine(gv.stdout))
  else add('git', 'git', 'fail', 'git을 실행하지 못함', 'Xcode Command Line Tools 설치: xcode-select --install')

  // swiftc (Xcode CLT). /usr/bin/swiftc is a stub without CLT, so ask xcode-select first.
  const xs = await p.run('xcode-select', ['-p'])
  const sv = xs.code === 0 ? await p.run('swiftc', ['--version']) : null
  if (sv && sv.code === 0) add('swiftc', 'swiftc (펫 빌드)', 'ok', firstLine(sv.stdout || sv.stderr))
  else add('swiftc', 'swiftc (펫 빌드)', 'fail', xs.code !== 0 ? 'Xcode Command Line Tools 없음' : 'swiftc 실행 실패', 'xcode-select --install 실행 후 다시 시도하세요')

  // Worker sandbox (execution.md §6)
  const SANDBOX_FIX = 'macOS 샌드박스가 동작하지 않아 작업자를 격리할 수 없음'
  const sbx = p.findBin('sandbox-exec') ?? p.findBin('/usr/bin/sandbox-exec')
  if (!sbx) {
    add('sandbox-exec', 'sandbox-exec', 'fail', 'sandbox-exec 없음', SANDBOX_FIX)
    add('sandbox', '샌드박스 시험', 'fail', 'sandbox-exec가 없어 시험하지 못함', SANDBOX_FIX)
  } else {
    add('sandbox-exec', 'sandbox-exec', 'ok', sbx)
    let smoke: SmokeResult
    try { smoke = await p.sandboxSmoke(sbx) } catch (e) { smoke = { ok: false, detail: (e as Error).message } }
    add('sandbox', '샌드박스 시험', smoke.ok ? 'ok' : 'fail', smoke.detail, SANDBOX_FIX)
  }

  // Projects
  const pf = projectsFile(ctx)
  if (!existsSync(pf)) {
    add('projects', '프로젝트 목록', 'warn', 'config/projects.json 없음 → 예시 파일로 동작 (실제 프로젝트 없음)', 'hq projects add <프로젝트 경로>')
  } else {
    let list: { id?: unknown; name?: unknown; path?: unknown }[] | null = null
    try {
      const raw = JSON.parse(readFileSync(pf, 'utf8'))
      if (Array.isArray(raw)) list = raw
    } catch { /* handled below */ }
    if (!list) add('projects', '프로젝트 목록', 'fail', 'config/projects.json 형식 오류 (배열이어야 함)', 'config/projects.json을 고치거나 지우고 hq projects add <경로>로 다시 만드세요')
    else if (!list.length) add('projects', '프로젝트 목록', 'warn', '등록된 프로젝트 없음', 'hq projects add <프로젝트 경로>')
    else {
      add('projects', '프로젝트 목록', 'ok', `${list.length}개`)
      for (const pr of list) {
        const id = String(pr.id ?? '?')
        const path = typeof pr.path === 'string' ? expandHome(pr.path, ctx.userHome) : ''
        if (!path || !existsSync(path) || !statSync(path).isDirectory()) {
          add(`project:${id}`, `프로젝트 ${id}`, 'fail', `경로 없음: ${String(pr.path)}`, `hq projects remove ${id} 후 올바른 경로로 hq projects add`)
          continue
        }
        // The execution phase needs git with at least one commit (worktrees branch from HEAD): fail, not warn.
        const g = git ? await p.run(git, ['-C', path, 'rev-parse', '--is-inside-work-tree']) : null
        if (!(g && g.code === 0 && g.stdout.trim() === 'true')) {
          add(`project:${id}`, `프로젝트 ${id}`, 'fail', `경로(${String(pr.path)})는 git 저장소가 아님 — 실행 단계에는 git 필요`, `cd ${path} && git init && git add -A && git commit -m init`)
          continue
        }
        const head = await p.run(git!, ['-C', path, 'rev-parse', '--verify', '--quiet', 'HEAD'])
        if (head.code !== 0) {
          add(`project:${id}`, `프로젝트 ${id}`, 'fail', `${String(pr.path)}에 커밋이 없음 — 실행 단계에는 커밋이 하나 이상 필요`, `cd ${path} && git add -A && git commit -m init`)
          continue
        }
        add(`project:${id}`, `프로젝트 ${id}`, 'ok', `${String(pr.path)} (git, 커밋 있음)`)
        const st = await p.run(git!, ['-C', path, 'status', '--porcelain'])
        if (st.code === 0 && !st.stdout.trim()) add(`project-tree:${id}`, `작업 트리 ${id}`, 'ok', '깨끗함')
        else add(`project-tree:${id}`, `작업 트리 ${id}`, 'warn',
          st.code === 0 ? `변경 ${st.stdout.trim().split('\n').length}건 — 병합은 깨끗한 작업 트리에서만 가능` : 'git status 실패 — 병합은 깨끗한 작업 트리에서만 가능',
          `cd ${path} && git status (커밋하거나 stash 후 병합)`)
      }
    }
  }

  // $HQ_HOME
  try {
    const target = existsSync(ctx.home) ? ctx.home : nearestExisting(ctx.home)
    accessSync(target, constants.W_OK)
    add('home', '데이터 폴더 ($HQ_HOME)', 'ok', existsSync(ctx.home) ? `${ctx.home} 쓰기 가능` : `${ctx.home} 없음 (첫 실행 때 생성 가능)`)
  } catch {
    add('home', '데이터 폴더 ($HQ_HOME)', 'fail', `${ctx.home}에 쓸 수 없음`, `권한 확인: ls -ld ${ctx.home} (또는 HQ_HOME을 쓰기 가능한 경로로)`)
  }

  // Token (existence + mode only, never the value)
  if (!existsSync(ctx.tokenFile)) add('token', '토큰 파일', 'warn', `${ctx.tokenFile} 없음 (데몬 첫 실행 때 생성)`, 'hq start 로 데몬을 한 번 실행하세요')
  else {
    const mode = statSync(ctx.tokenFile).mode & 0o777
    if (mode === 0o600) add('token', '토큰 파일', 'ok', `${ctx.tokenFile} (0600)`)
    else add('token', '토큰 파일', 'fail', `${ctx.tokenFile} 권한 ${mode.toString(8).padStart(4, '0')} (0600이어야 함)`, `chmod 600 ${ctx.tokenFile}`)
  }

  // Port / daemon
  const hq = await p.hq()
  if (hq.kind === 'down') add('port', `포트 ${ctx.port}`, 'ok', '비어 있음')
  else if (hq.kind === 'hq') add('port', `포트 ${ctx.port}`, 'ok', 'hq가 사용 중')
  else if (hq.kind === 'unauthorized') add('port', `포트 ${ctx.port}`, 'fail', 'hq가 응답하지만 토큰이 다름 (401)', tokenMismatchMsg(ctx.tokenFile))
  else add('port', `포트 ${ctx.port}`, 'fail', hq.kind === 'other' ? `다른 프로그램이 응답 (HTTP ${hq.status})` : `연결 오류: ${hq.message}`,
    `사용 중인 프로세스 확인: lsof -nP -iTCP:${ctx.port} -sTCP:LISTEN (또는 HQ_PORT로 다른 포트)`)
  if (hq.kind === 'hq') add('daemon', '데몬', 'ok', `실행 중 (127.0.0.1:${ctx.port})`)
  else add('daemon', '데몬', 'warn', '실행 중이 아님', 'hq start (자동 시작까지: hq install)')

  // Daemon single-instance lock
  const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
  const lf = lockFile(ctx)
  if (!existsSync(lf)) add('lock', '데몬 잠금', 'ok', '없음')
  else {
    const pid = readLockPid(ctx)
    const cmd = pid ? await p.pidCommand(pid) : null
    if (!pid) add('lock', '데몬 잠금', 'warn', `${lf}에서 pid를 읽지 못함`, `데몬이 꺼져 있다면 rm ${lf}`)
    else if (cmd === null && pidAlive(pid)) add('lock', '데몬 잠금', 'warn', `pid ${pid}의 프로그램을 확인할 수 없음 (ps 실행 불가)`, 'ps가 동작하는 터미널에서 hq doctor를 다시 실행하세요')
    else if (cmd === null) add('lock', '데몬 잠금', 'warn', `오래된 잠금 (pid ${pid} 종료됨)`, `hq start (데몬이 넘겨받음). 안 되면 rm ${lf}`)
    else if (!cmd.includes('src/main.ts')) add('lock', '데몬 잠금', 'warn', `pid ${josa(pid, '이/가')} hq가 아닌 프로세스 (pid 재사용: 오래된 잠금)`, `rm ${lf} 후 hq start`)
    else add('lock', '데몬 잠금', 'ok', `pid ${pid} 실행 중`)
  }

  // Pet
  const petBuilt = existsSync(petApp(ctx))
  if (await p.pgrep('HQPet.app')) add('pet', '데스크 펫', 'ok', '실행 중')
  else add('pet', '데스크 펫', 'warn', petBuilt ? '실행 중이 아님' : '빌드되지 않음 (pet/HQPet.app 없음)', petBuilt ? `open ${petApp(ctx)}` : 'hq install (또는 pet/build.sh)')

  // LaunchAgents
  let daemonAgentLoaded = false
  for (const [label, name] of [[daemonLabel(ctx), '자동 시작: 데몬'], [petLabel(ctx), '자동 시작: 펫']] as const) {
    const installed = existsSync(plistPath(ctx, label))
    const loaded = installed && await p.launchctlLoaded(label)
    if (label === daemonLabel(ctx)) daemonAgentLoaded = loaded
    if (installed && loaded) add(`launchd:${label}`, name, 'ok', '설치·로드됨')
    else add(`launchd:${label}`, name, 'warn', installed ? `${plistPath(ctx, label)} 있으나 로드 안 됨` : 'LaunchAgent 미설치', 'hq install')
  }

  // macOS TCC: a launchd-started node blocks on a permission dialog the first time it reads a protected folder.
  const tcc = protectedFolders(hqReadPaths(ctx), ctx.userHome)
  const TCC_TITLE = '폴더 접근 권한 (macOS)'
  if (!tcc.length) add('tcc', TCC_TITLE, 'ok', '보호 폴더(데스크탑·문서·다운로드) 밖이라 권한 창이 필요 없음')
  else {
    const labels = tccLabels(tcc)
    if (hq.kind === 'hq' && daemonAgentLoaded) add('tcc', TCC_TITLE, 'ok', `${labels} 폴더 아래에 있지만 자동 시작 데몬이 응답 중 → 권한 허용됨`)
    else add('tcc', TCC_TITLE, 'warn',
      `hq가 읽는 경로가 ${labels} 폴더 아래에 있어요 (${tccPathList(tcc, ctx.userHome)}). 자동 시작한 데몬이 처음 이 폴더를 읽을 때 macOS가 'node'의 접근 허용 창을 띄우고, 허용할 때까지 데몬이 멈춰요`,
      `창이 뜨면 [허용]을 누르세요. 이미 거부했다면: 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더 → node에서 ${labels} 폴더를 켜세요. 권한 창을 피하려면 저장소를 ~/src 같은 곳으로 옮기세요`)
  }

  // Sprites (optional)
  const packs = ['pokemon', 'digimon'].map((k) => join(ctx.root, 'pet/packs', k, 'pool'))
  const have = packs.filter((d) => { try { return readdirSync(d).length > 0 } catch { return false } })
  if (have.length === packs.length) add('sprites', '펫 스프라이트', 'ok', '포켓몬·디지몬 팩 있음')
  else add('sprites', '펫 스프라이트', 'warn', '스프라이트 팩 없음 → 기본 아이콘으로 표시', 'scripts/fetch-packs.sh 후 pet/build.sh (제3자 저작물, 로컬 전용)')

  return checks
}

export function summarize(checks: Check[]) {
  const n = (s: Status) => checks.filter((c) => c.status === s).length
  const s = { ok: n('ok'), warn: n('warn'), fail: n('fail') }
  return { ...s, exitCode: s.fail ? 5 : s.warn ? 6 : 0 }
}

const TAG: Record<Status, string> = { ok: '[정상]', warn: '[경고]', fail: '[실패]' }

export function printDoctor(ctx: Ctx, checks: Check[], json: boolean): number {
  const sum = summarize(checks)
  if (json) {
    ctx.out(JSON.stringify({ checks, summary: { ok: sum.ok, warn: sum.warn, fail: sum.fail }, exitCode: sum.exitCode }, null, 2))
    return sum.exitCode
  }
  ctx.out('hq 진단')
  for (const c of checks) {
    ctx.out(`  ${TAG[c.status]} ${c.title}: ${c.detail}`)
    if (c.fix) ctx.out(`         해결: ${c.fix}`)
  }
  ctx.out(`결과: 실패 ${sum.fail} · 경고 ${sum.warn} · 정상 ${sum.ok}`)
  return sum.exitCode
}

export async function doctorCommand(ctx: Ctx, opts: { json: boolean; probes?: Probes }): Promise<number> {
  return printDoctor(ctx, await runDoctor(ctx, opts.probes ?? realProbes(ctx)), opts.json)
}
