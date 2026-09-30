// Seatbelt smoke test for `hq doctor`: runs the real worker profile (execution.md §6.2) against a throwaway fake home
// and proves it denies a home secret read, a write outside the allow list and a signal to an outside process.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxProfile } from '../exec/sandbox.ts'
import { runCmd } from './ctx.ts'

export interface SmokeResult { ok: boolean; detail: string }

/** The worker profile for a fake home under `base`: `allowedDir` is the worktree, nothing else is granted. */
export function smokeProfile(base: string, allowedDir: string): string {
  return sandboxProfile({ worktree: allowedDir, out: null, hqHome: join(base, 'hq'), tokenDir: join(base, 'tok'), hqPort: 1, extraWritable: [], projects: [], home: join(base, 'home') })
}

// Paths/pid arrive as positional args ($1..$4); nothing is interpolated into the script.
const SCRIPT = [
  'if cat "$1" >/dev/null 2>&1; then echo READ=allowed; else echo READ=denied; fi',
  'if echo ok > "$2" 2>/dev/null; then echo WRITE_IN=allowed; else echo WRITE_IN=denied; fi',
  'if echo bad > "$3" 2>/dev/null; then echo WRITE_OUT=allowed; else echo WRITE_OUT=denied; fi',
  'if kill -0 "$4" 2>/dev/null; then echo SIGNAL=allowed; else echo SIGNAL=denied; fi',
].join('\n')

export async function sandboxSmoke(sandboxExec = '/usr/bin/sandbox-exec'): Promise<SmokeResult> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hq-sbx-')))
  let outside: string | null = null
  const victim = spawn('/bin/sleep', ['30'], { stdio: 'ignore' }) // an outside process the sandbox must not signal
  try {
    const home = join(base, 'home'), secret = join(home, '.codex', 'auth.json'), allowed = join(base, 'allowed')
    const inside = join(allowed, 'ok.txt')
    // Temp roots are writable in the profile, so the outside target is a probe in the real home (removed below).
    outside = join(homedir(), `.hq-sbx-probe-${process.pid}-${Date.now()}`)
    mkdirSync(join(home, '.codex'), { recursive: true }); writeFileSync(secret, 'secret')
    mkdirSync(allowed)
    const profile = join(base, 'profile.sb')
    writeFileSync(profile, smokeProfile(base, allowed))
    const r = await runCmd(sandboxExec, ['-f', profile, '/bin/sh', '-c', SCRIPT, 'sh', secret, inside, outside, String(victim.pid)], { timeoutMs: 15_000 })
    if (r.code !== 0) return { ok: false, detail: `sandbox-exec 실행 실패 (exit ${r.code}): ${r.stderr.trim().split('\n')[0] ?? ''}` }
    const got = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')))
    const problems: string[] = []
    if (got.READ !== 'denied') problems.push('비밀 파일 읽기가 막히지 않음')
    if (got.WRITE_IN !== 'allowed' || !existsSync(inside)) problems.push('허용 폴더 쓰기 실패')
    if (got.WRITE_OUT !== 'denied' || existsSync(outside)) problems.push('허용 밖 쓰기가 막히지 않음')
    if (got.SIGNAL !== 'denied') problems.push('밖 프로세스에 시그널이 막히지 않음')
    return problems.length ? { ok: false, detail: problems.join(', ') } : { ok: true, detail: '홈 비밀 읽기 거부·허용 쓰기·밖 쓰기 거부·밖 시그널 거부 확인' }
  } finally {
    victim.kill('SIGKILL')
    if (outside) rmSync(outside, { force: true })
    rmSync(base, { recursive: true, force: true })
  }
}
