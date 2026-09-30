// Detects running inside a Seatbelt sandbox (e.g. hq testing its own repo), where macOS refuses a nested sandbox-exec.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setSandboxWrapperForTests } from '../src/exec/sandbox.ts'

// A bare '(allow default)' profile still applies when nested; any real rule is refused (sandbox_apply EPERM, exit 71).
const probe = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)(deny file-read-data (literal "/nonexistent-hq-probe"))', '/usr/bin/true'])
export const nestedSandbox: boolean = probe.error !== undefined || probe.status !== 0

export const NESTED_SKIP = '샌드박스 안에서 실행 중이라 macOS가 중첩 샌드박스를 막아 격리 시험을 건너뜀'

export const NESTED_PS_SKIP = '샌드박스 안에서는 macOS가 setuid 프로그램(ps) 실행을 막아 건너뜀'

const FAKE = fileURLToPath(new URL('./fixtures/fake-sandbox-exec.sh', import.meta.url))

/** Engine-logic tests: pass through a no-op wrapper instead of the real sandbox when nesting is impossible. */
export function useFakeSandboxIfNested(): void {
  if (nestedSandbox) setSandboxWrapperForTests(FAKE)
}
