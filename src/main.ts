// hq daemon entry point.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { RequestEngine } from './engine.ts'
import type { Project } from './ceo.ts'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { Bus } from './bus.ts'
import { Scheduler } from './scheduler.ts'
import { startServer } from './server.ts'
import { Store } from './store.ts'
import type { TeamConfig } from './types.ts'

const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.HQ_PORT ?? 7777)
const teams = JSON.parse(readFileSync(resolve(root, 'config/teams.json'), 'utf8')) as TeamConfig[]
const store = new Store(resolve(root, '.data/hq.db'))
const bus = new Bus(store)
// Outside ~/Desktop so the pet app never triggers a macOS folder-access prompt.
const tokenDir = resolve(homedir(), '.config/hq'); mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
const tokenPath = resolve(tokenDir, 'token')
if (!existsSync(tokenPath)) { writeFileSync(tokenPath, randomBytes(24).toString('hex')); chmodSync(tokenPath, 0o600) }
const token = readFileSync(tokenPath, 'utf8').trim()
const scheduler = new Scheduler(teams, store, bus, `http://127.0.0.1:${port}`, token)
// config/projects.json is machine-specific (gitignored); fall back to the committed example.
const projectsFile = ['config/projects.json', 'config/projects.example.json'].map(f => resolve(root, f)).find(existsSync)!
const projects = (JSON.parse(readFileSync(projectsFile, 'utf8')) as Project[])
  .map(p => ({ ...p, path: p.path.replace(/^~(?=\/|$)/, homedir()) }))
const engine = new RequestEngine(store, bus, projects, root)
startServer(port, store, bus, scheduler, token, engine, projects)
engine.start()
setInterval(() => bus.heartbeat(), 10_000)
scheduler.start()
bus.emit({ kind: 'team', text: `hq 시작 (팀 ${teams.length}개, 127.0.0.1:${port})` })
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { scheduler.stop(); process.exit(0) })
