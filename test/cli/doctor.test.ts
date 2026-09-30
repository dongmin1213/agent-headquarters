import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Probes } from '../../src/cli/doctor.ts'
import { doctorCommand, runDoctor } from '../../src/cli/doctor.ts'
import { DAEMON_LABEL, PET_LABEL, plistPath } from '../../src/cli/ctx.ts'
import { testCtx, writeToken, type TestCtx } from './helpers.ts'

const SECRET_EMAIL = 'secret-person@example.com'

function probes(over: Partial<Probes> = {}): Probes {
  return {
    platform: () => 'darwin',
    macVersion: async () => '26.5',
    nodeVersion: () => '26.4.0',
    findBin: (n) => `/fake/bin/${n}`,
    run: async (cmd, args) => {
      if (cmd.endsWith('claude') && args[0] === '--version') return { code: 0, stdout: '2.1.285 (Claude Code)\n', stderr: '' }
      if (cmd.endsWith('claude') && args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ loggedIn: true, email: SECRET_EMAIL, orgId: 'org-1' }), stderr: '' }
      if (cmd.endsWith('git') && args[0] === '--version') return { code: 0, stdout: 'git version 2.50.1\n', stderr: '' }
      if (cmd.endsWith('git') && args.includes('rev-parse')) return { code: 0, stdout: 'true\n', stderr: '' }
      if (cmd === 'xcode-select') return { code: 0, stdout: '/Library/Developer/CommandLineTools\n', stderr: '' }
      if (cmd === 'swiftc') return { code: 0, stdout: 'Apple Swift version 6.3.3\n', stderr: '' }
      return { code: 127, stdout: '', stderr: 'unexpected' }
    },
    hq: async () => ({ kind: 'hq', snapshot: {} }),
    pgrep: async () => true,
    launchctlLoaded: async () => true,
    ...over,
  }
}

/** A ctx where every filesystem-backed check passes. */
function healthy(): TestCtx {
  const ctx = testCtx()
  const proj = join(ctx.userHome, 'proj'); mkdirSync(proj)
  writeFileSync(join(ctx.root, 'config/projects.json'), JSON.stringify([{ id: 'proj', name: 'P', path: '~/proj' }]))
  writeToken(ctx)
  mkdirSync(ctx.home, { recursive: true })
  mkdirSync(ctx.agentsDir, { recursive: true })
  for (const l of [DAEMON_LABEL, PET_LABEL]) writeFileSync(plistPath(ctx, l), '<plist/>')
  for (const k of ['pokemon', 'digimon']) { mkdirSync(join(ctx.root, 'pet/packs', k, 'pool'), { recursive: true }); writeFileSync(join(ctx.root, 'pet/packs', k, 'pool', 'a.gif'), '') }
  return ctx
}

test('all checks pass → exit 0, no fix lines, secrets never printed', async () => {
  const ctx = healthy()
  const code = await doctorCommand(ctx, { json: false, probes: probes() })
  assert.equal(code, 0, ctx.text())
  assert.doesNotMatch(ctx.text(), /\[경고\]|\[실패\]|해결:/)
  assert.match(ctx.text(), /결과: 실패 0 · 경고 0/)
  assert.doesNotMatch(ctx.text(), new RegExp(SECRET_EMAIL))
  assert.doesNotMatch(ctx.text(), /test-token-abc/)
})

test('warnings only → exit 6 with fix lines (daemon down, pet not running, not git, no sprites)', async () => {
  const ctx = healthy()
  const p = probes({
    hq: async () => ({ kind: 'down' }), pgrep: async () => false,
    run: async (cmd, args) => cmd.endsWith('git') && args.includes('rev-parse') ? { code: 128, stdout: '', stderr: 'not a git repo' } : probes().run(cmd, args),
  })
  const code = await doctorCommand(ctx, { json: false, probes: p })
  assert.equal(code, 6)
  const t = ctx.text()
  assert.match(t, /\[경고\] 데몬: 실행 중이 아님\n\s+해결: hq start/)
  assert.match(t, /\[경고\] 데스크 펫/)
  assert.match(t, /실행 단계에는 git 필요/)
  assert.match(t, /\[정상\] 포트/)
})

test('failures → exit 5, every failure has a fix line', async () => {
  const ctx = healthy()
  writeToken(ctx, 'x', 0o644)
  writeFileSync(join(ctx.root, 'config/hq.json'), JSON.stringify({ maxWorkerz: 3 }))
  writeFileSync(join(ctx.root, 'config/projects.json'), JSON.stringify([{ id: 'gone', name: 'G', path: '~/gone' }]))
  const p = probes({
    nodeVersion: () => '22.1.0', macVersion: async () => '13.6',
    findBin: (n) => (n === 'claude' ? null : `/fake/bin/${n}`),
    hq: async () => ({ kind: 'other', status: 404 }),
  })
  const checks = await runDoctor(ctx, p)
  const failed = checks.filter((c) => c.status === 'fail').map((c) => c.id)
  for (const id of ['macos', 'node', 'config', 'claude', 'claude-auth', 'project:gone', 'token', 'port']) assert.ok(failed.includes(id), `${id} should fail: ${failed}`)
  for (const c of checks) if (c.status !== 'ok') assert.ok(c.fix, `${c.id} needs a fix`)
  assert.match(checks.find((c) => c.id === 'token')!.fix!, /chmod 600/)
  const code = await doctorCommand(ctx, { json: false, probes: p })
  assert.equal(code, 5)
  const lines = ctx.lines
  lines.forEach((l, i) => { if (l.includes('[실패]')) assert.match(lines[i + 1], /^\s+해결: /) })
})

test('claude logged out, token mismatch on port', async () => {
  const ctx = healthy()
  const p = probes({
    run: async (cmd, args) => cmd.endsWith('claude') && args[0] === 'auth' ? { code: 1, stdout: '{"loggedIn":false}', stderr: '' } : probes().run(cmd, args),
    hq: async () => ({ kind: 'unauthorized' }),
  })
  const checks = await runDoctor(ctx, p)
  assert.equal(checks.find((c) => c.id === 'claude-auth')!.status, 'fail')
  assert.match(checks.find((c) => c.id === 'claude-auth')!.fix!, /login/)
  assert.equal(checks.find((c) => c.id === 'port')!.status, 'fail')
})

test('--json output is machine-readable and carries the exit code', async () => {
  const ctx = healthy()
  const code = await doctorCommand(ctx, { json: true, probes: probes({ pgrep: async () => false }) })
  assert.equal(code, 6)
  const j = JSON.parse(ctx.lines.join('\n'))
  assert.equal(j.exitCode, 6)
  assert.equal(j.summary.warn, 1)
  assert.equal(j.checks.find((c: { id: string }) => c.id === 'pet').fix.length > 0, true)
})

test('missing projects.json and token are warnings, not failures', async () => {
  const ctx = testCtx()
  const checks = await runDoctor(ctx, probes())
  assert.equal(checks.find((c) => c.id === 'projects')!.status, 'warn')
  assert.equal(checks.find((c) => c.id === 'token')!.status, 'warn')
  assert.equal(checks.filter((c) => c.status === 'fail').length, 0)
})
