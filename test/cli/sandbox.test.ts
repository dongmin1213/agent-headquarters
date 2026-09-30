import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandboxSmoke, smokeProfile } from '../../src/cli/sandbox.ts'
import { tmp } from './helpers.ts'
import { NESTED_SKIP, nestedSandbox } from '../nested.ts'

test('profile denies the secret read and all writes except the allowed dir', () => {
  const p = smokeProfile('/t/secret.txt', '/t/allowed')
  assert.match(p, /\(deny file-read\* \(literal "\/t\/secret\.txt"\)\)/)
  assert.match(p, /\(deny file-write\*\)\n\(allow file-write\* \(subpath "\/t\/allowed"\)/)
})

test('real Seatbelt smoke test passes on macOS', { skip: (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) || (nestedSandbox && NESTED_SKIP) }, async () => {
  const r = await sandboxSmoke()
  assert.equal(r.ok, true, r.detail)
})

test('smoke test detects a sandbox that does not confine (fake sandbox-exec that ignores the profile)', async () => {
  const fake = join(tmp(), 'fake-sandbox-exec')
  writeFileSync(fake, '#!/bin/sh\nshift 2\nexec "$@"\n'); chmodSync(fake, 0o755)
  const r = await sandboxSmoke(fake)
  assert.equal(r.ok, false)
  assert.match(r.detail, /비밀 파일 읽기가 막히지 않음/)
  assert.match(r.detail, /허용 밖 쓰기가 막히지 않음/)
})

test('smoke test reports a sandbox-exec that cannot run', async () => {
  const r = await sandboxSmoke('/nonexistent/sandbox-exec')
  assert.equal(r.ok, false)
  assert.match(r.detail, /실행 실패/)
})
