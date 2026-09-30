// Seatbelt smoke test for `hq doctor`: proves sandbox-exec can deny a read and confine writes (execution.md §6).
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCmd } from './ctx.ts'

export interface SmokeResult { ok: boolean; detail: string }

const q = (p: string) => JSON.stringify(p) // SBPL string literal (paths from mkdtemp have no quotes/backslashes)

export function smokeProfile(secret: string, allowedDir: string): string {
  return `(version 1)
(allow default)
(deny file-read* (literal ${q(secret)}))
(deny file-write*)
(allow file-write* (subpath ${q(allowedDir)}) (subpath "/dev"))
`
}

// Paths arrive as positional args ($1..$3); nothing is interpolated into the script.
const SCRIPT = [
  'if cat "$1" >/dev/null 2>&1; then echo READ=allowed; else echo READ=denied; fi',
  'if echo ok > "$2" 2>/dev/null; then echo WRITE_IN=allowed; else echo WRITE_IN=denied; fi',
  'if echo bad > "$3" 2>/dev/null; then echo WRITE_OUT=allowed; else echo WRITE_OUT=denied; fi',
].join('\n')

export async function sandboxSmoke(sandboxExec = '/usr/bin/sandbox-exec'): Promise<SmokeResult> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hq-sbx-')))
  try {
    const secret = join(base, 'secret.txt'), allowed = join(base, 'allowed'), inside = join(allowed, 'ok.txt'), outside = join(base, 'outside.txt')
    writeFileSync(secret, 'secret')
    mkdirSync(allowed)
    const profile = join(base, 'profile.sb')
    writeFileSync(profile, smokeProfile(secret, allowed))
    const r = await runCmd(sandboxExec, ['-f', profile, '/bin/sh', '-c', SCRIPT, 'sh', secret, inside, outside], { timeoutMs: 15_000 })
    if (r.code !== 0) return { ok: false, detail: `sandbox-exec 실행 실패 (exit ${r.code}): ${r.stderr.trim().split('\n')[0] ?? ''}` }
    const got = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')))
    const problems: string[] = []
    if (got.READ !== 'denied') problems.push('비밀 파일 읽기가 막히지 않음')
    if (got.WRITE_IN !== 'allowed' || !existsSync(inside)) problems.push('허용 폴더 쓰기 실패')
    if (got.WRITE_OUT !== 'denied' || existsSync(outside)) problems.push('허용 밖 쓰기가 막히지 않음')
    return problems.length ? { ok: false, detail: problems.join(', ') } : { ok: true, detail: '읽기 거부·허용 쓰기·밖 쓰기 거부 확인' }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
