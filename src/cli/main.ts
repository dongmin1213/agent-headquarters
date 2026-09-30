// hq operator CLI. Exit codes: 0 ok, 1 error, 2 usage, 5 doctor fail, 6 doctor warn.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeCtx, runCmd, type Ctx } from './ctx.ts'
import { logs, openUi, restart, start, status, stop } from './daemon.ts'
import { doctorCommand } from './doctor.ts'
import { install, uninstall } from './install.ts'
import { projectsAdd, projectsList, projectsRemove } from './projects.ts'

export const HELP = `hq — agent-headquarters 운영 명령

사용법: hq <명령> [옵션]

  install [--no-sprites]        진단 → 펫 빌드 → 스프라이트 → LaunchAgent 등록 (로그인 때 자동 시작)
  uninstall [--purge --yes]     자동 시작 해제 (--purge: 데이터·토큰까지 삭제)
  doctor [--json]               환경 진단 (종료 코드 0 정상 / 6 경고 / 5 실패)
  start | stop | restart        데몬 시작·중지·재시작
  status [--json]               데몬 상태, 상황 문장, 작업자, 결정 대기, 사용 한도
  open                          웹 화면 열기 (일회용 링크)
  logs [-f] [-n <줄>]           데몬 로그 (-f: 계속 보기)
  projects list                 관리 프로젝트 목록
  projects add <경로> [--id x] [--name y] [--setup "<명령>"]
  projects remove <id>
  version | help

환경 변수: HQ_HOME, HQ_PORT, HQ_TOKEN_FILE, HQ_LAUNCH_AGENTS_DIR, HQ_DRY_RUN=1 (실행 대신 출력)
자세한 안내: docs/SETUP.md`

interface Parsed { pos: string[]; flags: Map<string, string | true> }

const VALUE_FLAGS = new Set(['--id', '--name', '--setup', '-n'])

export function parseArgs(argv: string[]): Parsed | string {
  const pos: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=')
      const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
      if (VALUE_FLAGS.has(name)) {
        const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : argv[++i]
        if (v === undefined || v === '') return `${name}에 값이 필요합니다`
        flags.set(name, v)
      } else flags.set(a, true)
    } else pos.push(a)
  }
  return { pos, flags }
}

/** Allowed flags per command; anything else is a usage error. */
const ALLOWED: Record<string, string[]> = {
  install: ['--no-sprites'], uninstall: ['--purge', '--yes'], doctor: ['--json'], status: ['--json'],
  start: [], stop: [], restart: [], open: [], logs: ['-f', '--follow', '-n'], projects: ['--id', '--name', '--setup'],
  version: [], help: [],
}

async function version(ctx: Ctx): Promise<number> {
  const r = existsSync(join(ctx.root, '.git')) ? await runCmd('git', ['-C', ctx.root, 'describe', '--always', '--dirty', '--tags'], { timeoutMs: 5000 }) : null
  ctx.out(`hq ${r && r.code === 0 ? r.stdout.trim() : 'unknown'} (node ${process.versions.node}, ${ctx.root})`)
  return 0
}

function usage(ctx: Ctx, msg: string): number {
  ctx.err(`사용법 오류: ${msg}`)
  ctx.err('도움말: hq help')
  return 2
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(argv)
  if (typeof parsed === 'string') return usage(ctx, parsed)
  const { pos, flags } = parsed
  let cmd = pos.shift() ?? 'help'
  if (flags.has('--help') || flags.has('-h')) { flags.delete('--help'); flags.delete('-h'); if (cmd !== 'help') { ctx.out(HELP); return 0 } }
  if (flags.has('--version') && cmd === 'help') { flags.delete('--version'); cmd = 'version' }
  const allowed = ALLOWED[cmd]
  if (!allowed) return usage(ctx, `알 수 없는 명령 "${cmd}"`)
  for (const f of flags.keys()) if (!allowed.includes(f)) return usage(ctx, `${cmd}에 쓸 수 없는 옵션 ${f}`)
  const json = flags.has('--json')
  const noArgs = (n: number) => pos.length > n

  switch (cmd) {
    case 'help': ctx.out(HELP); return 0
    case 'version': return version(ctx)
    case 'doctor': if (noArgs(0)) return usage(ctx, 'doctor는 인자를 받지 않습니다'); return doctorCommand(ctx, { json })
    case 'status': if (noArgs(0)) return usage(ctx, 'status는 인자를 받지 않습니다'); return status(ctx, { json })
    case 'start': return noArgs(0) ? usage(ctx, 'start는 인자를 받지 않습니다') : start(ctx)
    case 'stop': return noArgs(0) ? usage(ctx, 'stop은 인자를 받지 않습니다') : stop(ctx)
    case 'restart': return noArgs(0) ? usage(ctx, 'restart는 인자를 받지 않습니다') : restart(ctx)
    case 'open': return noArgs(0) ? usage(ctx, 'open은 인자를 받지 않습니다') : openUi(ctx)
    case 'logs': {
      const n = flags.get('-n')
      const lines = typeof n === 'string' ? Number(n) : undefined
      if (lines !== undefined && !(Number.isInteger(lines) && lines > 0)) return usage(ctx, '-n은 양의 정수')
      return logs(ctx, { follow: flags.has('-f') || flags.has('--follow'), lines })
    }
    case 'install': return install(ctx, { sprites: !flags.has('--no-sprites') })
    case 'uninstall': return uninstall(ctx, { purge: flags.has('--purge'), yes: flags.has('--yes') })
    case 'projects': {
      const sub = pos.shift() ?? 'list'
      const id = flags.get('--id'), name = flags.get('--name'), setup = flags.get('--setup')
      if (sub !== 'add' && (id || name || setup)) return usage(ctx, '--id/--name/--setup은 projects add에서만 씁니다')
      if (sub === 'list') return pos.length ? usage(ctx, 'projects list는 인자를 받지 않습니다') : projectsList(ctx)
      if (sub === 'add') {
        if (pos.length !== 1) return usage(ctx, 'hq projects add <경로> [--id x] [--name y] [--setup "<명령>"]')
        const v = (x: string | true | undefined) => (typeof x === 'string' ? x : undefined)
        return projectsAdd(ctx, pos[0], { id: v(id), name: v(name), setup: v(setup) })
      }
      if (sub === 'remove' || sub === 'rm') return pos.length !== 1 ? usage(ctx, 'hq projects remove <id>') : projectsRemove(ctx, pos[0])
      return usage(ctx, `알 수 없는 projects 하위 명령 "${sub}" (list|add|remove)`)
    }
  }
  return usage(ctx, `알 수 없는 명령 "${cmd}"`)
}

if (import.meta.main) {
  let ctx: Ctx
  try { ctx = makeCtx() } catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(2) }
  main(process.argv.slice(2), ctx).then(
    (code) => { process.exitCode = code },
    (e) => { process.stderr.write(`오류: ${(e as Error)?.stack ?? String(e)}\n`); process.exitCode = 1 },
  )
}
