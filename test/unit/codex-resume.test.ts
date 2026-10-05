import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness, task, tsk } from './helpers.ts'
import { useFakeSandboxIfNested } from '../nested.ts'

useFakeSandboxIfNested()
const first = (dir: string) => JSON.parse(readFileSync(join(dir, 'hq/stream.jsonl'), 'utf8').split('\n')[0])

test('legacy worker resume starts Codex with the full brief, acceptance and stored answers', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { brief: '원본 지시 MARKER [[FAKE:outcome=question]]' })], '원래 회장의 요청')
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => tsk(h, tid).status === 'question')
    h.store.updateTask(tid, { resume_session: 'legacy-claude-thread' })
    const q = h.store.taskQuestions(tid)[0]
    h.runner.answerTask(tid, q.id, '확정 답변', 0)
    await h.waitFor(() => h.store.attempts(tid).length >= 2 && h.store.attempts(tid)[1].status === 'running')
    const att = h.store.attempts(tid)[1]
    const prompt = readFileSync(join(att.dir, 'hq/prompt.md'), 'utf8')
    assert.match(prompt, /원본 지시 MARKER/)
    assert.match(prompt, /원래 회장의 요청/)
    assert.match(prompt, /test -f README.md/)
    assert.match(prompt, /확정 답변/)
    await h.waitFor(() => tsk(h, tid).status === 'question')
    assert.ok(!first(att.dir).argv.includes('resume'), 'Claude thread ids are never passed to Codex')
  } finally { await h.close() }
})

test('collect resume uses the same private Codex home even when the checkout changes', async () => {
  const h = harness()
  try {
    const id = h.plan([task('A', { role: 'collect', grade: 'L0', owns: [], brief: '조사 [[FAKE:outcome=question]]',
      acceptance: [{ id: 'A1', text: '보고서 작성', kind: 'new', check: 'manual' }] })])
    await h.approve(id)
    const tid = `${id}.A`
    await h.waitFor(() => tsk(h, tid).status === 'question')
    const q = h.store.taskQuestions(tid)[0]
    h.runner.answerTask(tid, q.id, '예', 0)
    await h.waitFor(() => h.store.attempts(tid).filter(a => a.kind === 'work').length === 2 && tsk(h, tid).status !== 'running')
    const [a, b] = h.store.attempts(tid).filter(a => a.kind === 'work').map(a => first(a.dir))
    assert.notEqual(a.cwd, b.cwd)
    assert.equal(a.codex_home, b.codex_home)
    assert.equal(b.argv[b.argv.indexOf('resume') + 1], a.thread_id)
  } finally { await h.close() }
})
