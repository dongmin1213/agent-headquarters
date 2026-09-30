// hq daemon entry point. Start order (exec-engine-spec §F): recover → runner → engine → server.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { Bus } from './bus.ts'
import type { Project } from './ceo.ts'
import { loadConfig } from './config.ts'
import { RequestEngine } from './engine.ts'
import { Runner } from './exec/runner.ts'
import { notify } from './notify.ts'
import { Scheduler } from './scheduler.ts'
import { startServer } from './server.ts'
import { migrateDb, Store } from './store.ts'
import type { TeamConfig } from './types.ts'

const root = resolve(import.meta.dirname, '..')
const cfg = loadConfig(root)
const port = Number(process.env.HQ_PORT ?? 7777)
mkdirSync(cfg.home, { recursive: true })

// Single instance (§7.8): daemon.lock is created with O_CREAT|O_EXCL and holds our identity as JSON
// {pid, port, root, home, startedAt} so the CLI can verify it before signalling (startedAt = `ps -o lstart=` under LC_ALL=C).
// Older daemons wrote a plain pid line; the first integer of either format is the pid.
// An existing lock whose pid is alive and runs src/main.ts means another daemon; anything else is stale.
const lockPath = resolve(cfg.home, 'daemon.lock')
const lockPid = (text: string) => { const m = /\d+/.exec(text); return m ? Number(m[0]) : 0 }
const startedAt = (() => { try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim() } catch { return '' } })()
const lockBody = JSON.stringify({ pid: process.pid, port, root, home: resolve(cfg.home), startedAt }) + '\n'
const tryLock = () => {
  try { const fd = openSync(lockPath, 'wx', 0o644); writeSync(fd, lockBody); closeSync(fd); return true } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}
if (!tryLock()) {
  const other = lockPid((() => { try { return readFileSync(lockPath, 'utf8') } catch { return '' } })())
  let cmd = ''
  if (other > 0 && other !== process.pid) try { cmd = execFileSync('ps', ['-o', 'command=', '-p', String(other)], { encoding: 'utf8' }) } catch { /* not running */ }
  if (cmd.includes('src/main.ts')) { console.error(`hq가 이미 실행 중이에요 (pid ${other})`); process.exit(1) }
  rmSync(lockPath, { force: true })
  if (!tryLock()) { console.error('daemon.lock을 만들지 못했어요 (다른 hq가 동시에 시작 중)'); process.exit(1) }
}
const releaseLock = () => { try { if (lockPid(readFileSync(lockPath, 'utf8')) === process.pid) rmSync(lockPath) } catch { /* gone */ } }
process.on('exit', releaseLock)

const dbPath = resolve(cfg.home, 'hq.db')
if (migrateDb(resolve(root, '.data/hq.db'), dbPath)) console.log(`DB 이전: .data/hq.db → ${dbPath}`)
const store = new Store(dbPath)
const bus = new Bus(store)

// Outside ~/Desktop so the pet app never triggers a macOS folder-access prompt.
const tokenPath = process.env.HQ_TOKEN_FILE ?? resolve(homedir(), '.config/hq/token')
mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
if (!existsSync(tokenPath)) { writeFileSync(tokenPath, randomBytes(24).toString('hex')); chmodSync(tokenPath, 0o600) }
const token = readFileSync(tokenPath, 'utf8').trim()

// config/teams.json is machine-specific (gitignored: it points at private repos); fall back to the committed example.
const teamsFile = ['config/teams.json', 'config/teams.example.json'].map((f) => resolve(root, f)).find(existsSync)!
const tilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir())
const teams = (JSON.parse(readFileSync(teamsFile, 'utf8')) as TeamConfig[])
  .map((t) => ({ ...t, cwd: resolve(root, tilde(t.cwd)), command: t.command.map(tilde) }))
// config/projects.json is machine-specific (gitignored); fall back to the committed example.
const projectsFile = ['config/projects.json', 'config/projects.example.json'].map((f) => resolve(root, f)).find(existsSync)!
const projects = (JSON.parse(readFileSync(projectsFile, 'utf8')) as Project[]).map((p) => ({ ...p, path: p.path.replace(/^~(?=\/|$)/, homedir()) }))

const runner = new Runner({ store, bus, cfg, projects, hqRoot: root, hqPort: port, notify: cfg.notify ? notify : () => {}, now: Date.now, tokenDir: dirname(tokenPath),
  teamNames: Object.fromEntries(teams.map((t) => [t.id, t.name])) })
// Teams get a scoped per-run token and cannot read the token folder or $HQ_HOME (see Scheduler).
const scheduler = new Scheduler(teams, store, bus, `http://127.0.0.1:${port}`, { hqHome: cfg.home, tokenDir: dirname(tokenPath) }, {
  // A login hold has no end time; teams still wait (checked again every scheduler tick).
  holdUntil: () => (runner.quota().mode === 'hold' ? runner.holdUntil() ?? new Date(Date.now() + 60_000).toISOString() : null),
  teamLimited: (until) => store.setQuotaWindow({ window: 'team', utilization: null, resets_at: until, status: 'rejected', observed_at: new Date().toISOString() }),
})
const engine = new RequestEngine(store, bus, projects, root, runner)

await runner.recover()
runner.start()
engine.start()
startServer({ port, store, bus, scheduler, token, engine, runner, projects })
setInterval(() => bus.heartbeat(), 10_000)
scheduler.start()
bus.emit({ kind: 'team', text: `hq 시작 (팀 ${teams.length}개, 127.0.0.1:${port}, ${cfg.home})` })
// Workers are detached and survive; the next start re-adopts them (§7).
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { runner.stop(); engine.stop(); scheduler.stop(); process.exit(0) })
