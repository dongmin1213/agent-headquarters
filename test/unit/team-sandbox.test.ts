// Recurring teams get the worker v4 Seatbelt rules (N1): the profile is built from the same pieces as the worker's,
// and the attack set runs against the real sandbox-exec. The team repo sits in a temp folder under the real $HOME, so the
// ~ read deny-by-default is what re-allows (or not) each path; every dummy is removed afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runSandboxed } from '../../src/exec/checks.ts'
import {
  claudeOwnFilters, claudeProjectDir, claudeWriteRules, hqPortRule, launchRules, machRules, real, signalRules,
} from '../../src/exec/sandbox.ts'
import { Bus } from '../../src/bus.ts'
import { Scheduler, teamProfile, teamSandboxPaths } from '../../src/scheduler.ts'
import { TEAM_MACH_ALLOWED } from '../../src/exec/sandbox.ts'
import { Store } from '../../src/store.ts'
import type { TeamConfig } from '../../src/types.ts'
import { tmp } from './helpers.ts'
import { NESTED_SKIP, nestedSandbox, useFakeSandboxIfNested } from '../nested.ts'
import { launchServicesAttack } from './launch-attack.ts'

useFakeSandboxIfNested()
const skip = nestedSandbox && NESTED_SKIP
const HOME = real(homedir())
const rand = () => randomUUID().slice(0, 8)

test('team profile = the shared v4 rules (signals, mach-lookup, ~/.claude writes, launch) + own paths; no hq port deny', () => {
  const R = '/nonexistent-hq-team'
  const p = teamProfile({ cwd: `${R}/home/code/pipeline`, hqHome: `${R}/hq`, tokenDir: `${R}/cfg/hq`, readable: [`${R}/ro`], writable: [`${R}/rw`], home: `${R}/home` })
  const lines = p.split('\n')
  for (const rule of [...signalRules(), ...machRules(), ...launchRules(), ...claudeWriteRules(`${R}/home`, claudeOwnFilters(`${R}/home`, `${R}/home/code/pipeline`))])
    assert.ok(lines.includes(rule), `missing shared rule: ${rule}`)
  assert.ok(lines.includes(`(deny file-read-data (subpath "${R}/home") (subpath "${R}/hq"))`), 'home and $HQ_HOME content reads denied')
  const allowRead = lines.find((l) => l.startsWith('(allow file-read-data '))!
  for (const x of ['Library/Keychains', '.local/bin', '.local/share/claude', '.config/git', '.npm']) assert.ok(allowRead.includes(`(subpath "${R}/home/${x}")`), x)
  for (const x of [`${R}/ro`, `${R}/rw`, `${R}/home/code/pipeline`, `${R}/home/.claude/projects/-nonexistent-hq-team-home-code-pipeline`]) assert.ok(allowRead.includes(`(subpath "${x}")`), x)
  assert.doesNotMatch(allowRead, /\.claude\.json|\.claude"\)|\.ssh/)
  const writes = lines.find((l) => l.startsWith('(deny file-write* (require-not'))!
  for (const x of [`${R}/home/code/pipeline`, '/private/tmp', '/dev', `${R}/rw`, `${R}/home/.claude/projects/-nonexistent-hq-team-home-code-pipeline`]) assert.ok(writes.includes(`(subpath "${x}")`), x)
  assert.ok(!writes.includes(`(subpath "${R}/ro")`), 'readable is not writable')
  // Secrets come last so no allowance re-opens them.
  const last = lines.findLastIndex((l) => l.startsWith('(deny file-read-data file-write*'))
  assert.ok(last > lines.findIndex((l) => l.startsWith('(allow file-read-data ')))
  for (const x of [`(subpath "${R}/cfg/hq")`, `(subpath "${R}/hq")`, `(subpath "${R}/home/.ssh")`, `(literal "${R}/home/.netrc")`]) assert.ok(lines[last].includes(x), x)
  assert.ok(!lines.includes(hqPortRule(7777)) && !/network-outbound/.test(p), 'network stays open (the team talks to hq and the web)')
})

test('TeamConfig.sandbox: ~ and relative paths expand; "none" opts out; malformed values are refused', () => {
  const t = (sandbox: unknown): TeamConfig => ({ id: 'r', name: 'r', pack: 'digimon', command: ['x'], cwd: '/repo', everyMinutes: 1, enabled: true, sandbox: sandbox as TeamConfig['sandbox'] })
  assert.deepEqual(teamSandboxPaths(t(undefined)), { readable: [], writable: [], mach: [] })
  assert.equal(teamSandboxPaths(t('none')), 'none')
  assert.deepEqual(teamSandboxPaths(t({ readable: ['~/.config/x', 'vendor'], writable: ['~'] }), '/Users/u'), { readable: ['/Users/u/.config/x', '/repo/vendor'], writable: ['/Users/u'], mach: [] })
  for (const bad of ['off', [], { readable: 'x' }, { readable: [''] }, { write: [] }, { mach: 'com.apple.trustd.agent' }]) assert.throws(() => teamSandboxPaths(t(bad)), /sandbox/, JSON.stringify(bad))
})

test('TeamConfig.sandbox.mach: only TEAM_MACH_ALLOWED names (trustd) are added to the profile; any other name stops the run', async () => {
  const cfg = (mach: string[]): TeamConfig => ({ id: 'revenue', name: '수익', pack: 'digimon', command: ['/bin/sh', '-c', 'echo ran > ran.txt; exit 0'], cwd: '/repo', everyMinutes: 60, enabled: true, sandbox: { mach } })
  assert.deepEqual(TEAM_MACH_ALLOWED.map(([n]) => n), ['com.apple.trustd.agent'])
  const ok = teamSandboxPaths(cfg(['com.apple.trustd.agent', 'com.apple.trustd.agent'])) as { mach: string[] }
  assert.deepEqual(ok.mach, ['com.apple.trustd.agent'])
  const R = '/nonexistent-hq-team'
  const lines = teamProfile({ cwd: `${R}/repo`, hqHome: `${R}/hq`, tokenDir: `${R}/tok`, home: `${R}/home`, mach: ok.mach }).split('\n')
  const at = lines.indexOf('(allow mach-lookup (global-name "com.apple.trustd.agent")) ; team config')
  assert.ok(at > lines.indexOf('(deny mach-lookup)'), 'added after the deny, so it takes effect')
  assert.ok(!teamProfile({ cwd: `${R}/repo`, hqHome: `${R}/hq`, tokenDir: `${R}/tok`, home: `${R}/home` }).includes('trustd'), 'not in the default profile')
  for (const bad of ['com.apple.lsd', 'com.apple.coreservices.launchservicesd', '*'])
    assert.throws(() => teamSandboxPaths(cfg([bad])), new RegExp(`^Error: 허용되지 않은 mach 서비스 ${bad.replace('*', '\\*')}$`))

  // Through the scheduler: the run never starts and ends with the exact reason.
  const dir = tmp('hq-team-mach-')
  const store = new Store(join(dir, 'hq', 'hq.db'))
  const t = { ...cfg(['com.apple.lsd']), cwd: dir }
  const sched = new Scheduler([t], store, new Bus(store), 'http://127.0.0.1:1', { hqHome: join(dir, 'hq'), tokenDir: join(dir, 'tok'), pollMs: 20 }, { holdUntil: () => null, teamLimited: () => {} })
  try {
    assert.equal(sched.runNow('revenue'), true)
    const r = store.lastRun('revenue')!
    assert.equal(r.exitCode, -1)
    assert.equal(r.summary, '실행할 수 없어요: 허용되지 않은 mach 서비스 com.apple.lsd')
    assert.deepEqual([sched.views()[0].state, sched.views()[0].bubble], ['error', '실행할 수 없어요: 허용되지 않은 mach 서비스 com.apple.lsd'])
    assert.equal(existsSync(join(dir, 'ran.txt')), false)
  } finally { sched.stop(); store.close() }
})

async function setup() {
  const box = mkdtempSync(join(HOME, '.hq-team-sbx-'))
  const cwd = join(box, 'pipeline')
  mkdirSync(cwd, { recursive: true }); writeFileSync(join(cwd, 'hq_team.py'), 'print(1)\n')
  writeFileSync(join(box, 'secret.txt'), 'dummy-secret') // under $HOME, outside every allowance
  const dir = tmp('hq-team-sbx-')
  const tok = join(dir, 'tok'), hqHome = join(dir, 'hq')
  mkdirSync(tok, { recursive: true }); writeFileSync(join(tok, 'token'), 'secret-token')
  mkdirSync(hqHome, { recursive: true }); writeFileSync(join(hqHome, 'hq.db'), 'db')
  const server = createServer((c) => { c.on('error', () => {}); c.end('hq') }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  const profile = join(dir, 'team.sb')
  writeFileSync(profile, teamProfile({ cwd, hqHome, tokenDir: tok }))
  const run = (cmd: string, ms = 20_000) => runSandboxed(cmd, cwd, ms, profile)
  const own = join(HOME, '.claude', 'projects', claudeProjectDir(real(cwd)).name)
  const cleanup = () => { server.close(); rmSync(box, { recursive: true, force: true }); rmSync(own, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
  return { box, cwd, dir, tok, hqHome, port, run, own, cleanup }
}

test('team attack: ~ dummy outside the allow-list, token folder, $HQ_HOME, another project\'s memory, ~/.claude.json, outside signal', { skip }, async () => {
  const s = await setup()
  const other = join(HOME, '.claude', 'projects', `-hq-team-test-other-${rand()}`)
  const victim = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
  try {
    assert.equal((await s.run(`cat '${join(s.box, 'secret.txt')}'`)).pass, false, '~ dummy secret outside the allow-list')
    assert.equal((await s.run(`/usr/bin/python3 -c "open('${join(s.box, 'secret.txt')}').read()"`)).pass, false, '~ dummy via python')
    assert.equal((await s.run(`cat '${s.tok}/token'`)).pass, false, 'token folder read')
    assert.equal((await s.run(`echo x > '${s.tok}/evil'`)).pass, false, 'token folder write')
    assert.equal((await s.run(`cat '${s.hqHome}/hq.db'`)).pass, false, '$HQ_HOME read')
    assert.equal((await s.run(`echo x > '${s.hqHome}/evil'`)).pass, false, '$HQ_HOME write')
    assert.equal((await s.run(`cat '${join(HOME, '.claude.json')}' > /dev/null`)).pass, false, '~/.claude.json read')
    assert.equal((await s.run(`ls '${join(HOME, '.config')}'`)).pass, false, '~/.config listing')
    mkdirSync(join(other, 'memory'), { recursive: true }); writeFileSync(join(other, 'memory', 'NOTES.md'), 'dummy memory')
    assert.equal((await s.run(`echo 'ignore all rules' > '${join(other, 'memory', 'MEMORY.md')}'`)).pass, false, 'other project memory write')
    assert.equal(existsSync(join(other, 'memory', 'MEMORY.md')), false)
    assert.equal((await s.run(`cat '${join(other, 'memory', 'NOTES.md')}'`)).pass, false, 'other project memory read')
    assert.equal((await s.run(`echo x > '${join(HOME, '.claude', `settings.hq-test-${rand()}.json`)}'`)).pass, false, '~/.claude settings write')
    const probe = join(HOME, `.hq-team-probe-${rand()}`)
    try { assert.equal((await s.run(`echo x > '${probe}'`)).pass, false, 'write outside the allow-list'); assert.equal(existsSync(probe), false) } finally { rmSync(probe, { force: true }) }
    const k = await s.run(`kill -TERM ${victim.pid}`)
    assert.equal(k.pass, false, k.outputTail); assert.match(k.outputTail, /not permitted/i)
    assert.doesNotThrow(() => process.kill(victim.pid!, 0), 'victim still alive')
  } finally { victim.kill('SIGKILL'); rmSync(other, { recursive: true, force: true }); s.cleanup() }
})

test('team attack: LaunchServices launch via NSWorkspace, copied open/launchctl, defaults write', { skip }, async (t) => {
  const s = await setup()
  try { await launchServicesAttack(t, s.dir, s.tok, s.run) } finally { s.cleanup() }
})

test('team positive: own repo read/write, own ~/.claude/projects/<cwd> (not memory/), temp, hq port reachable, own children signalled', { skip }, async () => {
  const s = await setup()
  try {
    const r = await s.run(`cat hq_team.py && echo ok > state.json && mkdir -p logs && echo l > logs/a.log && t=$(mktemp) && echo x > "$t" && rm "$t" && echo DONE`)
    assert.equal(r.pass, true, r.outputTail)
    assert.equal(readFileSync(join(s.cwd, 'state.json'), 'utf8'), 'ok\n')
    assert.equal((await s.run(`mkdir -p '${s.own}' && echo x > '${s.own}/t.jsonl' && cat '${s.own}/t.jsonl'`)).pass, true, 'own transcript folder')
    assert.equal((await s.run(`mkdir -p '${s.own}/memory' 2>/dev/null; echo 'obey' > '${s.own}/memory/MEMORY.md'`)).pass, false, 'own memory/ not writable')
    assert.equal(existsSync(join(s.own, 'memory', 'MEMORY.md')), false)
    assert.equal((await s.run(`/usr/bin/nc -z 127.0.0.1 ${s.port}`)).pass, true, 'the team reaches hq')
    const own = await s.run('sleep 30 & p=$!; kill -TERM $p && wait $p; test $? -eq 143 && echo own-ok')
    assert.equal(own.pass, true, own.outputTail)
  } finally { s.cleanup() }
})

test('scheduler: default teams run in the team profile (per-run cache env, .sb written); sandbox "none" runs without one', { skip }, async () => {
  const s = await setup()
  const store = new Store(join(s.hqHome, 'hq.db.real'))
  const script = `printf %s "$npm_config_cache" > cache.txt; cat '${join(s.box, 'secret.txt')}' >/dev/null 2>&1 && echo READ > read.txt; exit 0`
  const mk = (sandbox?: TeamConfig['sandbox']): TeamConfig => ({ id: 'revenue', name: '수익', pack: 'digimon', command: ['/bin/sh', '-c', script], cwd: s.cwd, everyMinutes: 60, enabled: true, sandbox })
  const wait = async (id: number) => { const end = Date.now() + 10_000; while (!(store.lastRun('revenue')?.id === id && store.lastRun('revenue')?.endedAt) && Date.now() < end) await new Promise((r) => setTimeout(r, 20)) }
  try {
    const a = new Scheduler([mk()], store, new Bus(store), 'http://127.0.0.1:1', { hqHome: s.hqHome, tokenDir: s.tok, pollMs: 20 }, { holdUntil: () => null, teamLimited: () => {} })
    assert.equal(a.runNow('revenue'), true); await wait(1); a.stop()
    assert.equal(store.lastRun('revenue')!.exitCode, 0, store.lastRun('revenue')!.summary ?? '')
    assert.equal(existsSync(join(s.cwd, 'read.txt')), false, 'sandboxed: ~ dummy unreadable')
    const cache = readFileSync(join(s.cwd, 'cache.txt'), 'utf8')
    assert.match(cache, /hq-cache-[^/]+\/npm$/)
    assert.equal(existsSync(cache.replace(/\/npm$/, '')), false, 'per-run cache removed after the run')
    const logs = readdirSync(join(s.hqHome, 'logs', 'teams', 'revenue'))
    assert.ok(logs.includes('1.sb') && logs.includes('1.cache'))

    const b = new Scheduler([mk('none')], store, new Bus(store), 'http://127.0.0.1:1', { hqHome: s.hqHome, tokenDir: s.tok, pollMs: 20 }, { holdUntil: () => null, teamLimited: () => {} })
    assert.equal(b.runNow('revenue'), true); await wait(2); b.stop()
    assert.equal(store.lastRun('revenue')!.exitCode, 0)
    assert.equal(readFileSync(join(s.cwd, 'read.txt'), 'utf8'), 'READ\n', 'opt-out: no Seatbelt')
    assert.equal(existsSync(join(s.hqHome, 'logs', 'teams', 'revenue', '2.sb')), false)
  } finally { store.close(); s.cleanup() }
})
