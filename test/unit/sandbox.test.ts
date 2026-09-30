// §G 1: the Seatbelt boundary, exercised with the real sandbox-exec.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { runSandboxed } from '../../src/exec/checks.ts'
import { atomicWrite } from '../../src/exec/fsx.ts'
import { childEnv, sandboxProfile } from '../../src/exec/sandbox.ts'
import { makeRepo, sh, tmp } from './helpers.ts'

async function setup() {
  const dir = tmp('hq-sbx-')
  const home = join(dir, 'home'), tok = join(dir, 'tok')
  mkdirSync(tok, { recursive: true }); writeFileSync(join(tok, 'token'), 'secret-token')
  const repo = makeRepo(join(dir, 'proj'))
  const wt = join(home, 'worktrees', 'req-1', 'A'), other = join(home, 'worktrees', 'req-1', 'B')
  mkdirSync(join(home, 'worktrees', 'req-1'), { recursive: true })
  sh(repo, 'worktree', 'add', '-q', '-b', 'hq/req-1/A', wt)
  mkdirSync(other, { recursive: true })
  const out = join(home, 'runs', 'req-1', 'A', 'req-1.A~a1', 'out')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(home, 'hq.db'), 'db')
  const server = createServer((s) => s.end('hq')).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  const profile = join(dir, 'p.sb')
  atomicWrite(profile, sandboxProfile({ worktree: wt, out, repoGitDir: join(repo, '.git'), hqHome: home, tokenDir: tok, hqPort: port, extraWritable: [], claudeDir: join(homedir(), '.claude') }))
  const run = (cmd: string) => runSandboxed(cmd, wt, 20_000, profile)
  return { dir, home, tok, wt, other, out, port, run, server }
}

test('1. sandbox denies token, hq port, writes outside the allow list, other worktrees and hq.db; allows own worktree commits and out/', async () => {
  const s = await setup()
  try {
    assert.equal((await s.run(`cat ${s.tok}/token`)).pass, false, 'token read')
    assert.equal((await s.run(`/usr/bin/python3 -c "open('${s.tok}/token').read()"`)).pass, false, 'token read via python')
    assert.equal((await s.run(`cat ${s.home}/hq.db`)).pass, false, 'hq.db read')
    assert.equal((await s.run(`echo x > ${s.other}/f`)).pass, false, 'other worktree write')
    const probe = join(homedir(), `.hq-sbx-probe-${process.pid}`)
    assert.equal((await s.run(`echo x > ${probe}`)).pass, false, 'write outside allow list')
    assert.equal(existsSync(probe), false)
    assert.equal((await s.run(`/usr/bin/curl -s -m 3 http://127.0.0.1:${s.port}/`)).pass, false, 'hq port (127.0.0.1)')
    assert.equal((await s.run(`/usr/bin/curl -s -m 3 http://localhost:${s.port}/`)).pass, false, 'hq port (localhost)')
    const commit = await s.run('echo hi > f.txt && git add f.txt && git -c user.name=t -c user.email=t@t commit -q -m w && git rev-parse HEAD')
    assert.equal(commit.pass, true, commit.outputTail)
    assert.equal((await s.run(`echo '{}' > ${s.out}/done.json`)).pass, true, 'own out write')
  } finally { s.server.close() }
})

test('1. sandbox env carries no HQ_TOKEN, API keys or SSH agent', async () => {
  const env = childEnv({ HQ_ATTEMPT_OUT: '/x' }, { PATH: '/bin', HOME: '/h', HQ_TOKEN: 't', ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: '/s', GITHUB_TOKEN: 'g' })
  assert.equal(env.HQ_TOKEN, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.SSH_AUTH_SOCK, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.HQ_ATTEMPT_OUT, '/x')
  assert.equal(env.GIT_CONFIG_VALUE_1, 'nothing')
  const s = await setup()
  try {
    process.env.HQ_TOKEN = 'leak-me'
    const r = await s.run('env')
    assert.equal(r.pass, true)
    assert.doesNotMatch(r.outputTail, /HQ_TOKEN|leak-me/)
  } finally { delete process.env.HQ_TOKEN; s.server.close() }
})
