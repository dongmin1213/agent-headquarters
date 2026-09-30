// Shared test harness: temp git repo, fake claude, in-process store/runner/engine with a fake clock.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Bus } from '../../src/bus.ts'
import type { PlanTask, Project } from '../../src/ceo.ts'
import { DEFAULTS, type HqConfig } from '../../src/config.ts'
import { RequestEngine, planCardBody } from '../../src/engine.ts'
import { Runner } from '../../src/exec/runner.ts'
import { Store } from '../../src/store.ts'

process.env.HQ_NO_NOTIFY = '1'
export const ROOT = resolve(import.meta.dirname, '../..')
export const FAKE = resolve(import.meta.dirname, 'fixtures/fake-claude.ts')

export const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

export function tmp(prefix = 'hq-test-'): string { return mkdtempSync(join(realpathSync(tmpdir()), prefix)) }

export function makeRepo(path: string, files: Record<string, string> = { 'README.md': '# test\n' }): string {
  mkdirSync(path, { recursive: true })
  sh(path, 'init', '-q', '-b', 'main')
  sh(path, 'config', 'user.name', 'tester'); sh(path, 'config', 'user.email', 't@example.com'); sh(path, 'config', 'commit.gpgsign', 'false')
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(path, f, '..'), { recursive: true }); writeFileSync(join(path, f), c) }
  sh(path, 'add', '-A'); sh(path, 'commit', '-q', '-m', 'init')
  return path
}

export function commitFile(repo: string, file: string, content: string, msg = 'change'): string {
  mkdirSync(join(repo, file, '..'), { recursive: true })
  writeFileSync(join(repo, file), content)
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', msg)
  return sh(repo, 'rev-parse', 'HEAD')
}

export const task = (id: string, o: Partial<PlanTask> = {}): PlanTask => ({
  id, title: `작업 ${id}`, project: 'p', role: 'implement', grade: 'L1', model: 'sonnet', owns: [`${id.toLowerCase()}/**`],
  acceptance: [{ id: 'A1', text: 'README 유지', check: 'test -f README.md' }], brief: `[[FAKE:write=${id.toLowerCase()}/out.txt]]`, depends_on: [], ...o,
})

export interface Harness {
  dir: string; repo: string; store: Store; bus: Bus; runner: Runner; engine: RequestEngine; cfg: HqConfig; projects: Project[]
  notes: [string, string][]; clock: { t: number }
  plan(tasks: PlanTask[], text?: string): string
  approve(requestId: string): Promise<string | null>
  decide(id: string, decision: string): Promise<string | null>
  waitFor(pred: () => boolean, what?: string, ms?: number): Promise<void>
  close(): Promise<void>
}

export function harness(o: { cfg?: Partial<HqConfig>; repoFiles?: Record<string, string>; setup?: string } = {}): Harness {
  const dir = tmp()
  const repo = makeRepo(join(dir, 'proj'), o.repoFiles)
  const cfg: HqConfig = { ...DEFAULTS, home: join(dir, 'home'), claudeBin: FAKE, sandbox: { extraWritable: [] }, ...o.cfg }
  const store = new Store(join(cfg.home, 'hq.db'))
  const bus = new Bus(store)
  const clock = { t: Date.now() }
  const notes: [string, string][] = []
  const projects: Project[] = [{ id: 'p', name: 'P', path: repo, ...(o.setup ? { setup: o.setup } : {}) }]
  mkdirSync(join(dir, 'tok'), { recursive: true })
  const runner = new Runner({ store, bus, cfg, projects, hqRoot: ROOT, hqPort: 17999, notify: (t, b) => notes.push([t, b]), now: () => clock.t, tokenDir: join(dir, 'tok') })
  const engine = new RequestEngine(store, bus, projects, ROOT, runner)
  let seq = 0
  const h: Harness = {
    dir, repo, store, bus, runner, engine, cfg, projects, notes, clock,
    plan(tasks, text = '테스트 요청') {
      const id = `req-t${String(++seq).padStart(7, '0')}`
      store.addRequest(id, 'p', text)
      const plan = JSON.stringify({ summary: text, assumptions: [], tasks })
      const hash = createHash('sha256').update(plan).digest('hex')
      store.updateRequest(id, { status: 'planned', plan, plan_hash: hash })
      store.putApproval({ id: `plan:${id}`, teamId: 'ceo', subjectId: id, title: `계획 승인: ${text}`, body: planCardBody(JSON.parse(plan), projects), options: ['승인', '반려'], subjectHash: hash })
      return id
    },
    async approve(requestId) { return h.decide(`plan:${requestId}`, '승인') },
    async decide(id, decision) {
      const a = store.approval(id)
      if (!a) throw new Error(`no card ${id}`)
      const d = store.decide(id, decision, a.subjectHash, clock.t)
      if (!d) throw new Error(`cannot decide ${id}`)
      if (d.kind === 'plan') return engine.planDecided(d.subjectId!, decision)
      return h.runner.onApproval(d)
    },
    async waitFor(pred, what = 'condition', ms = 60_000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        await h.runner.tick()
        if (pred()) return
        await new Promise((r) => setTimeout(r, 40))
      }
      const dump = store.raw().prepare('select id, status, attempts, note from tasks').all()
      const atts = store.raw().prepare('select id, status, reason from attempts').all()
      throw new Error(`timeout waiting for ${what}\ntasks: ${JSON.stringify(dump, null, 1)}\nattempts: ${JSON.stringify(atts, null, 1)}`)
    },
    async close() {
      h.runner.stop()
      for (const a of store.liveAttempts()) if (a.pid) try { process.kill(-a.pid, 'SIGKILL') } catch { /* gone */ }
      for (const l of h.runner.live.values()) try { process.kill(-l.pid, 'SIGKILL') } catch { /* gone */ }
      await runner.drain()
      await h.runner.drain()
      store.close()
    },
  }
  return h
}

export const req = (h: Harness, id: string) => h.store.request(id)!
export const tsk = (h: Harness, id: string) => h.store.task(id)!
