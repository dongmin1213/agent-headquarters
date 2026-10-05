import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sandboxProfile } from '../../src/exec/sandbox.ts'
import { runSandboxed } from '../../src/exec/checks.ts'
import { NESTED_SKIP, nestedSandbox } from '../nested.ts'

test('Codex profile grants only its isolated state; collect cannot write checkout; HQ/token/personal sessions denied', { skip: nestedSandbox && NESTED_SKIP }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-codex-sandbox-'))
  const home = join(root, 'user'), hq = join(root, 'hq'), cwd = join(hq, 'work/task'), out = join(hq, 'runs/task/out')
  const own = join(hq, 'codex/own'), other = join(hq, 'codex/other'), tokens = join(root, 'tokens')
  const files = [join(home, '.codex/auth.json'), join(home, '.claude/projects/other/memory/x'), join(hq, 'hq.db'), join(other, 'auth.json'), join(tokens, 'token')]
  for (const p of [cwd, out, own, ...files.map(f => join(f, '..'))]) mkdirSync(p, { recursive: true })
  for (const f of files) writeFileSync(f, 'dummy')
  writeFileSync(join(cwd, 'README.md'), 'original')
  const profile = join(root, 'profile.sb')
  writeFileSync(profile, sandboxProfile({ home, hqHome: hq, worktree: cwd, out, codexHome: own, readOnlyWorktree: true,
    tokenDir: tokens, hqPort: 18627, projects: [], extraWritable: [] }))
  const run = (cmd: string) => runSandboxed(cmd, cwd, 5000, profile)
  try {
    for (const f of files) assert.equal((await run(`cat '${f}'`)).pass, false, f)
    assert.equal((await run(`echo x > '${join(cwd, 'README.md')}'`)).pass, false)
    assert.equal((await run(`cat '${join(cwd, 'README.md')}'`)).pass, true)
    assert.equal((await run(`echo x > '${join(out, 'report.md')}'`)).pass, true)
    assert.equal((await run(`echo x > '${join(own, 'session.json')}'`)).pass, true)
    assert.equal((await run(`echo x > '${join(home, '.codex/settings.json')}'`)).pass, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
