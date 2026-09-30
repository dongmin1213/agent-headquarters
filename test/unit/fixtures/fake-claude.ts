#!/usr/bin/env node
// Fake `claude -p` for tests. Behaviour is chosen by argv (--json-schema, --resume) and by [[FAKE:key=value]] markers
// in the prompt (stdin). Markers are remembered per session in $TMPDIR so a `--resume` run keeps them.
//   work:   write=<path> (repeatable), outcome=succeeded|failed|blocked|question, questions=<n>, sleep=<ms>, nodone, badtoken,
//           limit429, e529, maxturns, errors=<n>, rejectfirst, rejectalways, resets=<epoch s>, util=<0..1>
//   review: review=pass|block|invalid|faketest|badexit
//   revise: revise=same|widen|question
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const resume = argv.includes('--resume')
const sid = arg('--session-id') ?? arg('--resume') ?? 'no-session'
const schema = argv.includes('--json-schema')
const prompt = readFileSync(0, 'utf8')
const stateFile = join(process.env.TMPDIR ?? tmpdir(), `fake-claude-${sid}.json`)

const parse = (text: string) => {
  const m: Record<string, string[]> = {}
  for (const x of text.matchAll(/\[\[FAKE:([a-z0-9]+)(?:=([^\]]*))?\]\]/g)) (m[x[1]] ??= []).push(x[2] ?? '1')
  return m
}
let marks = parse(prompt)
if (resume && existsSync(stateFile)) marks = { ...JSON.parse(readFileSync(stateFile, 'utf8')), ...marks }
else if (!schema) { try { writeFileSync(stateFile, JSON.stringify(marks)) } catch { /* sandbox */ } }
const mk = (k: string) => marks[k]?.[0] ?? null

const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = Math.floor(Date.now() / 1000)
emit({ type: 'system', subtype: 'init', session_id: sid, argv, cwd: process.cwd() })
const rejected = mk('rejectalways') || (mk('rejectfirst') && !resume)
emit({ type: 'rate_limit_event', rate_limit_info: { status: rejected ? 'rejected' : 'allowed', resetsAt: Number(mk('resets') ?? now + 3600), rateLimitType: 'five_hour',
  unifiedWindows: { five_hour: { utilization: rejected ? 1 : Number(mk('util') ?? 0.1), resetsAt: Number(mk('resets') ?? now + 3600) }, seven_day: { utilization: 0.05, resetsAt: now + 6 * 86400 } } } })
const result = (extra: Record<string, unknown> = {}) => emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.001,
  usage: { input_tokens: 10, output_tokens: 20 }, result: 'done', ...extra })

let n = 0
const bash = (command: string, exit: number, output = '') => {
  const id = `toolu_${++n}`
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: exit !== 0, content: exit ? `Exit code ${exit}\n${output}` : output || '(Bash completed with no output)' }] } })
}

if (schema && prompt.includes('# 교차 검토')) {
  const ids = /수용 기준 id\(([^)]*)\)/.exec(prompt)?.[1].split(', ').filter(Boolean) ?? []
  const mode = mk('review') ?? 'pass'
  bash('npm test', mode === 'badexit' ? 1 : 0)
  const tests = [{ command: mode === 'faketest' ? 'make secret-tests' : 'npm test', exit_code: 0, summary: 'ok' }]
  const criteria = ids.map((id) => ({ id, result: mode === 'block' ? 'fail' : 'pass', evidence: 'checked' }))
  const out = mode === 'block' ? { pass: false, blocking: [{ id: 'B1', summary: '결함 있음', evidence: 'x.ts:1' }], advisory: [], criteria, tests_run: tests }
    : mode === 'invalid' ? { pass: true, blocking: [{ id: 'B1', summary: 'x', evidence: 'y' }], advisory: [], criteria, tests_run: tests }
    : { pass: true, blocking: [], advisory: [], criteria, tests_run: tests }
  result({ structured_output: out })
  process.exit(0)
}

if (schema && prompt.includes('## 이번 턴: 지시서 수정')) {
  const m = /## 원래 작업 \(PlanTask JSON\)\n```json\n([\s\S]*?)\n```/.exec(prompt)
  const task = JSON.parse(m![1])
  const mode = mk('revise') ?? 'same'
  if (mode === 'question') result({ structured_output: { revised_task: null, questions: [{ question: '어느 쪽?', options: ['A', 'B'], default: 'A', reason: '모호' }] } })
  else result({ structured_output: { revised_task: { ...task, brief: task.brief + ' (수정됨)', owns: mode === 'widen' ? [...task.owns, 'extra/**'] : task.owns }, questions: [] } })
  process.exit(0)
}

if (schema && prompt.includes('## 이번 턴: 진단')) {
  const opts = /recommendation\.option: 다음 중 정확히 하나 \(([^)]*)\)/.exec(prompt)?.[1].split(', ') ?? ['retry']
  const mode = mk('diag') ?? 'ok'
  if (mode === 'fail') { emit({ type: 'result', subtype: 'error', is_error: true, session_id: sid, result: 'boom', usage: {} }); process.exit(1) }
  result({ structured_output: { situation: '가짜 진단: 검사가 계속 실패했어요', cause: '검사 명령이 새 파일을 거부해요', causeConfirmed: true,
    recommendation: { option: mode === 'badoption' ? 'maybe-later' : opts[opts.length > 1 ? 1 : 0], reason: '가짜 추천 이유' } } })
  process.exit(0)
}

if (schema) { // CEO planning turn
  result({ structured_output: { questions: [{ question: '범위?', options: ['작게', '크게'], default: '작게', reason: '테스트' }], plan: null } })
  process.exit(0)
}

// ----- work -----
if (rejected) { emit({ type: 'result', subtype: 'error', is_error: true, session_id: sid, api_error_status: 429, result: 'rate limited', usage: {} }); process.exit(1) }
if (mk('limit429')) { emit({ type: 'result', subtype: 'error', is_error: true, session_id: sid, api_error_status: 429, result: 'usage limit', usage: {} }); process.exit(1) }
if (mk('e529')) { emit({ type: 'result', subtype: 'error', is_error: true, session_id: sid, api_error_status: 529, result: 'overloaded', usage: {} }); process.exit(1) }
if (mk('errors')) { for (let i = 0; i < Number(mk('errors')); i++) bash('ls /nope', 1, 'ls: /nope: No such file or directory') }
if (mk('sleep')) await sleep(Number(mk('sleep')))
if (mk('maxturns')) { emit({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: sid, usage: {} }); process.exit(1) }

const out = process.env.HQ_ATTEMPT_OUT!
const token = /attempt_token: (\S+)/.exec(prompt)?.[1] ?? ''
const base = /--no-renames ([0-9a-f]{40}) HEAD/.exec(prompt)?.[1] ?? /head_sha는 `([0-9a-f]{40})`/.exec(prompt)?.[1] ?? ''
const collect = prompt.includes('읽기 전용 조사·수집')
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim()
let outcome = mk('outcome') ?? 'succeeded'
if (outcome === 'question' && resume) outcome = 'succeeded'
let head = base, files: string[] = []
if (!collect && outcome === 'succeeded') {
  for (const f of marks.write ?? ['hq-fake.txt']) {
    mkdirSync(join(process.cwd(), f, '..'), { recursive: true })
    writeFileSync(join(process.cwd(), f), `${mk('content') ?? 'hello'} ${sid} ${Date.now()} ${Math.random()}\n`)
    bash(`echo > ${f}`, 0)
  }
  git('add', '-A')
  git('commit', '-q', '-m', `fake work ${sid}`)
  head = git('rev-parse', 'HEAD')
  files = git('diff', '--name-only', '--no-renames', base, 'HEAD').split('\n').filter(Boolean)
} else if (!collect) head = git('rev-parse', 'HEAD')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'report.md'), `## 요약\n${'이 작업은 가짜 작업자가 지시서에 따라 파일을 만들고 커밋한 뒤 수용 기준을 확인한 결과를 적은 보고서입니다. '.repeat(4)}\n\n## 수용 기준\n- 확인함\n`)
if (!mk('nodone')) {
  const qn = Number(mk('questions') ?? 1)
  const done = { attempt_token: mk('badtoken') ? 'wrong' : token, outcome, head_sha: head, files_modified: files, summary: `가짜 작업 ${outcome}`,
    questions: outcome === 'question' ? Array.from({ length: qn }, (_, i) => ({ question: `질문 ${i + 1}?`, options: ['예', '아니오'], default: '예' })) : [] }
  writeFileSync(join(out, 'done.json.tmp'), JSON.stringify(done))
  renameSync(join(out, 'done.json.tmp'), join(out, 'done.json'))
}
emit({ type: 'assistant', message: { content: [{ type: 'text', text: `작업 끝: ${outcome}` }] } })
result()
