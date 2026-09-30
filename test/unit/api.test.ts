// §G 17: HTTP API behaviour (execution.md §15).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { Scheduler } from '../../src/scheduler.ts'
import { startServer } from '../../src/server.ts'
import { harness, req, task, tsk, type Harness } from './helpers.ts'

const TOKEN = 'test-token-123'
/** Percent-encode every character, so the server must decode path ids exactly once. */
const enc = (s: string) => [...Buffer.from(s)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('')

async function api(h: Harness): Promise<{ server: Server; call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }> }> {
  const port = 30000 + Math.floor(Math.random() * 20000)
  const scheduler = new Scheduler([], h.store, h.bus, `http://127.0.0.1:${port}`, TOKEN, { holdUntil: () => h.runner.holdUntil(), teamLimited: () => {} })
  const server = startServer({ port, store: h.store, bus: h.bus, scheduler, token: TOKEN, engine: h.engine, runner: h.runner, projects: h.projects })
  await new Promise((r) => server.once('listening', r))
  return {
    server,
    async call(method, path, body) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await r.text()
      let parsed: unknown = text
      try { parsed = JSON.parse(text) } catch { /* plain text */ }
      return { status: r.status, body: parsed }
    },
  }
}

test('17. API: encoded ids, question ownership, team card namespace, evidence allow list, stale revision', async () => {
  const h = harness()
  const { server, call } = await api(h)
  try {
    // A worker question answered through a fully percent-encoded task id.
    const id = h.plan([task('A', { brief: '[[FAKE:write=a/out.txt]] [[FAKE:outcome=question]]' }), task('B', { brief: '[[FAKE:nodone]]' })])
    assert.equal((await call('POST', `/api/approvals/${enc(`plan:${id}`)}`, { decision: '승인', subjectHash: h.store.approval(`plan:${id}`)!.subjectHash })).status, 200)
    assert.equal(req(h, id).status, 'executing')
    await h.waitFor(() => tsk(h, `${id}.A`).status === 'question' && tsk(h, `${id}.B`).status === 'blocked', 'question + blocked')
    const q = h.store.taskQuestions(`${id}.A`)[0]
    const stale = await call('POST', `/api/tasks/${enc(`${id}.A`)}/answer`, { questionId: q.id, answer: '예', revision: 5 })
    assert.equal(stale.status, 409)
    assert.match(stale.body.error, /revision/)
    assert.equal((await call('POST', `/api/tasks/${enc(`${id}.A`)}/answer`, { questionId: q.id, answer: '예', revision: 0 })).status, 200)
    assert.equal(tsk(h, `${id}.A`).status, 'pending')
    // Circuit-break decision via encoded id; stale revision refused first.
    assert.equal((await call('POST', `/api/tasks/${enc(`${id}.B`)}/decide`, { decision: 'skip', revision: 3 })).status, 409)
    assert.equal((await call('POST', `/api/tasks/${enc(`${id}.B`)}/decide`, { decision: 'skip', revision: 0 })).status, 200)
    assert.equal(tsk(h, `${id}.B`).status, 'cancelled')
    // CEO answer with another request's question id.
    h.store.addRequest('req-ask00001', 'p', '하나'); h.store.addRequest('req-ask00002', 'p', '둘')
    h.store.updateRequest('req-ask00001', { status: 'asking' }); h.store.updateRequest('req-ask00002', { status: 'asking' })
    h.store.addQuestions('req-ask00002', [{ id: 'q-other', question: '?', options: ['a'], default: 'a', reason: 'r' }])
    const wrong = await call('POST', '/api/requests/req-ask00001/answer', { questionId: 'q-other', answer: 'a' })
    assert.equal(wrong.status, 409)
    assert.equal(typeof wrong.body.error, 'string')
    // Team cards live in their own namespace.
    assert.equal((await call('POST', '/api/approvals', { id: 'plan:x', teamId: 'revenue', title: 't', subjectHash: 'h', options: ['a'] })).status, 400)
    assert.equal((await call('POST', '/api/approvals', { id: 'team:other:x', teamId: 'revenue', title: 't', subjectHash: 'h', options: ['a'] })).status, 400)
    assert.equal((await call('POST', '/api/approvals', { id: 'team:revenue:x', teamId: 'revenue', title: 't', subjectHash: 'h', options: ['a'] })).status, 201)
    // Evidence files: allow list only, folder from the DB.
    const att = h.store.attempts(`${id}.A`)[0]
    const report = await call('GET', `/api/attempts/${enc(att.id)}/files/report.md`)
    assert.equal(report.status, 200)
    assert.match(report.body, /## 요약/)
    for (const name of ['prompt.md', 'process.json', '..%2F..%2Fhq.db', 'spec.json']) assert.equal((await call('GET', `/api/attempts/${enc(att.id)}/files/${name}`)).status, 404, name)
    const act = await call('GET', `/api/attempts/${enc(att.id)}/activity?after=0`)
    assert.equal(act.status, 200)
    assert.ok(Array.isArray(act.body.lines) && act.body.next === act.body.lines.length)
    // Snapshot carries decisions and needsYou = decisions.length.
    const snap = (await call('GET', '/api/state')).body
    assert.equal(snap.headline.needsYou, snap.decisions.length)
    assert.ok(Array.isArray(snap.workers))
    const detail = await call('GET', `/api/requests/${id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.tasks.length, 2)
    // Body limit and bad JSON.
    assert.equal((await call('POST', '/api/requests', { text: 'x'.repeat(70_000) })).status, 413)
    assert.equal((await call('GET', '/api/nope')).body.error.length > 0, true)
  } finally { server.close(); await h.close() }
})
