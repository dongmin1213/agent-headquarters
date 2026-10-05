import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { activateCodexProvider, chatgptEnv, CodexEvents, commandText, execArgs, prepareCodexHome, strictSchema } from '../../src/codex.ts'
import { Store } from '../../src/store.ts'
import { loadConfig } from '../../src/config.ts'
import { StreamTail, extractBashRuns } from '../../src/exec/stream.ts'
import { runJsonTurn } from '../../src/ceo.ts'
import { FAKE } from './helpers.ts'

test('Codex argv: read-only coordinator, externally sandboxed worker, explicit thread resume only', () => {
  const args = execArgs({ model: 'my-model', sessionId: 'codex:thread-1', resume: true, schemaPath: '/tmp/schema.json' })
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'thread-1'])
  assert.ok(args.includes('sandbox_mode="read-only"'))
  assert.equal(args.at(-1), '-')
  assert.ok(args.includes('--output-schema'))
  assert.ok(!args.includes('--json-schema') && !args.includes('--session-id'))
  assert.ok(!execArgs({ sessionId: 'old-claude-uuid', resume: true }).includes('resume'))
  assert.ok(execArgs({ externalSandbox: true }).includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('strict schema makes only optional properties nullable, recursively', () => {
  const input = { type: 'object', required: ['a'], properties: { a: { type: 'string' }, review: { type: 'object', properties: { ok: { type: 'boolean' } } } } }
  const output = strictSchema(input) as any
  assert.deepEqual(output.required, ['a', 'review'])
  assert.deepEqual(output.properties.a, { type: 'string' })
  assert.equal(output.properties.review.anyOf[0].additionalProperties, false)
  assert.deepEqual(input.required, ['a'], 'caller schema not mutated')
})

test('Codex success/error events: message and usage are preserved; errors alone determine limits', () => {
  const d = new CodexEvents()
  d.consume({ type: 'thread.started', thread_id: 'thread-1' })
  d.consume({ type: 'turn.started' })
  d.consume({ type: 'item.completed', item: { type: 'agent_message', text: '{"answer":"usage limit is a test string"}' } })
  d.consume({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 } })
  assert.equal(d.result?.session_id, 'codex:thread-1')
  assert.equal(d.result?.is_error, false)
  assert.equal(d.result?.usage.output_tokens, 4)
  assert.equal(d.result?.structured_output.answer, 'usage limit is a test string')
  assert.equal(d.result?.total_cost_usd, undefined, 'subscription dollars are not fabricated')
  d.consume({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } })
  assert.equal(d.result?.api_error_status, 429)
  d.consume({ type: 'turn.failed', error: { message: 'server failure', status_code: 503 } })
  assert.equal(d.result?.api_error_status, 503)
})

test('Codex raw stream: restart between final message and completion; exact tool evidence and unknown exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-codex-stream-'))
  const file = join(dir, 'stream.jsonl')
  const emit = (e: object) => appendFileSync(file, JSON.stringify(e) + '\n')
  try {
    emit({ type: 'thread.started', thread_id: 't' })
    emit({ type: 'turn.started' })
    emit({ type: 'item.started', item: { id: 'a', type: 'command_execution', command: "/bin/zsh -lc 'npm test'", status: 'in_progress' } })
    emit({ type: 'item.completed', item: { id: 'a', type: 'command_execution', command: "/bin/zsh -lc 'npm test'", status: 'completed', exit_code: 1 } })
    emit({ type: 'item.completed', item: { id: 'b', type: 'command_execution', command: 'npm test', status: 'completed', exit_code: null } })
    emit({ type: 'item.completed', item: { id: 'c', type: 'agent_message', text: '{"pass":false}' } })
    new StreamTail(dir).poll()
    emit({ type: 'turn.completed', usage: { output_tokens: 5 } })
    const restarted = new StreamTail(dir)
    restarted.poll()
    assert.equal(restarted.finalResult()?.structured_output && (restarted.finalResult()!.structured_output as any).pass, false)
    assert.equal(new StreamTail(dir).finalResult()?.is_error, false)
    assert.deepEqual(extractBashRuns(file), [{ command: 'npm test', exitCode: 1 }, { command: 'npm test', exitCode: null }])
    assert.equal(commandText("/bin/sh -c 'npm test; exit 0'"), 'npm test; exit 0', 'unsafe script must remain visible to verdict validation')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('private Codex home: credentials only, protected modes, refreshed auth retained, symlink destination replaced', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-codex-auth-'))
  const source = join(root, 'personal')
  mkdirSync(source)
  writeFileSync(join(source, 'auth.json'), '{"dummy":1}')
  writeFileSync(join(source, 'config.toml'), 'untrusted-config')
  mkdirSync(join(source, 'sessions'))
  try {
    const home = prepareCodexHome(join(root, 'hq'), 'task-a', source)
    assert.equal(statSync(home).mode & 0o777, 0o700)
    assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600)
    assert.equal(existsSync(join(home, 'config.toml')), false)
    assert.equal(existsSync(join(home, 'sessions')), false)
    writeFileSync(join(home, 'auth.json'), '{"refreshed":true}')
    prepareCodexHome(join(root, 'hq'), 'task-a', source)
    assert.match(readFileSync(join(home, 'auth.json'), 'utf8'), /refreshed/)
    const victim = join(root, 'victim'); writeFileSync(victim, 'untouched')
    rmSync(join(home, 'auth.json')); symlinkSync(victim, join(home, 'auth.json'))
    // Even an unchanged source must replace a missing or symlinked destination.
    prepareCodexHome(join(root, 'hq'), 'task-a', source)
    assert.equal(statSync(join(home, 'auth.json')).isFile(), true)
    assert.equal(readFileSync(victim, 'utf8'), 'untouched')
    rmSync(join(home, 'auth.json'))
    prepareCodexHome(join(root, 'hq'), 'task-a', source)
    assert.equal(existsSync(join(home, 'auth.json')), true)
    writeFileSync(join(source, 'auth.json'), '{"dummy":2}')
    prepareCodexHome(join(root, 'hq'), 'task-a', source)
    assert.equal(readFileSync(victim, 'utf8'), 'untouched')
    assert.notEqual(prepareCodexHome(join(root, 'hq'), 'task-b', source), home)
    rmSync(join(source, 'auth.json'))
    prepareCodexHome(join(root, 'hq'), 'task-a', source)
    assert.equal(existsSync(join(home, 'auth.json')), false, 'source logout clears the private login')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy config retains routing tiers but uses Codex models and executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-codex-config-'))
  mkdirSync(join(root, 'config'))
  try {
    writeFileSync(join(root, 'config/hq.json'), JSON.stringify({ claudeBin: '/old/claude', models: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' } }))
    const c = loadConfig(root, { HQ_CODEX_BIN: '/new/codex' })
    assert.equal(c.codexBin, '/new/codex')
    assert.deepEqual(c.models, { haiku: 'gpt-6-luna', sonnet: 'gpt-6.1-sol', opus: 'gpt-6-astra' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('structured coordinator uses native Codex argv, schema file and returned thread id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-codex-ceo-'))
  try {
    const t = await runJsonTurn({ codexBin: FAKE, runtimeHome: root, cwd: root, prompt: 'plan', schema: { type: 'object', properties: {} }, sessionId: 'fresh', resume: false, addDirs: [] })
    assert.equal(t.ok, true, t.error ?? '')
    assert.match(t.sessionId, /^codex:/)
    assert.equal((t.output as any).questions.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('provider switch clears only stale account limits once, preserving requests and subsequent Codex quota', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-codex-provider-'))
  const store = new Store(join(root, 'hq.db'))
  try {
    store.addRequest('old-request', 'p', 'keep history')
    store.set('login.required', 'old')
    store.set('limit.backoffUntil', '2099-01-01T00:00:00Z')
    store.setQuotaWindow({ window: 'five_hour', utilization: 1, resets_at: '2099-01-01T00:00:00Z', status: 'rejected', observed_at: new Date().toISOString() })
    activateCodexProvider(store)
    assert.equal(store.get('login.required'), null)
    assert.equal(store.get('limit.backoffUntil'), null)
    assert.equal(store.raw().prepare('select count(*) as n from quota').get()?.n, 0)
    assert.equal(store.request('old-request')?.text, 'keep history')
    store.set('login.required', 'new-codex-login')
    activateCodexProvider(store)
    assert.equal(store.get('login.required'), 'new-codex-login', 'restart must not clear a current provider hold')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('ChatGPT calls preserve the private Codex home without inherited API keys or daemon credentials', () => {
  const from = { CODEX_HOME: '/private-codex', PATH: '/bin', CODEX_API_KEY: 'dummy', OPENAI_API_KEY: 'dummy', ANTHROPIC_API_KEY: 'dummy', HQ_TOKEN: 'dummy', HQ_TOKEN_FILE: '/token' }
  assert.deepEqual(chatgptEnv(from), { CODEX_HOME: '/private-codex', PATH: '/bin' })
  assert.equal(from.CODEX_API_KEY, 'dummy', 'caller environment is not mutated')
})

test('shell envelopes decode adjacent literal quotes but never evaluate expansions or hide operators', () => {
  assert.equal(commandText("/bin/bash -lc \"rg --files -g '\"'!.env*'\"'\""), "rg --files -g '!.env*'")
  assert.equal(commandText("/bin/zsh -lc 'rg --files -g '\"'\"'!.env*'\"'\"''"), "rg --files -g '!.env*'")
  assert.equal(commandText("/bin/sh -c 'npm test; exit 0'"), "npm test; exit 0")
  assert.equal(commandText("/bin/sh -c \"echo \\$HOME\""), "echo $HOME")
  assert.equal(commandText("/bin/sh -c \"echo $HOME\""), "/bin/sh -c \"echo $HOME\"")
  assert.equal(commandText("/bin/sh -c \"$(echo true)\""), "/bin/sh -c \"$(echo true)\"")
  assert.equal(commandText("/bin/sh -c 'npm test' extra"), "/bin/sh -c 'npm test' extra")
  assert.equal(commandText("/bin/sh -c 'npm test' && true"), "/bin/sh -c 'npm test' && true")
  assert.equal(commandText("/bin/sh -c \"echo \\\\$HOME\""), "/bin/sh -c \"echo \\\\$HOME\"")
  assert.equal(commandText("/bin/sh -c 'unclosed"), "/bin/sh -c 'unclosed")
})

test('failed native commands retain their measured nonzero exit instead of becoming unknown', () => {
  const decoder = new CodexEvents()
  const lines = decoder.consume({ type: 'item.completed', item: { id: 'failure', type: 'command_execution', command: 'node check.mjs', status: 'failed', exit_code: 1, aggregated_output: 'assertion failed' } })
  assert.equal(lines.at(-1)?.tool_use_result.interrupted, false)
  assert.match(lines.at(-1)?.message.content[0].content, /^Exit code 1/)
  const unknown = decoder.consume({ type: 'item.completed', item: { id: 'unknown', type: 'command_execution', command: 'node check.mjs', status: 'failed', exit_code: null } })
  assert.equal(unknown.at(-1)?.tool_use_result.interrupted, true)
})
