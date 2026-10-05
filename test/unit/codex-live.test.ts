// Explicit opt-in: uses the ChatGPT login, a disposable repo and HQ-owned Codex sessions only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULTS } from '../../src/config.ts'
import { codexArgs, killGroup, launch, removeCacheDir } from '../../src/exec/worker.ts'
import { StreamTail, extractBashRuns } from '../../src/exec/stream.ts'
import { prepareCodexHome } from '../../src/codex.ts'
import { NESTED_SKIP, nestedSandbox } from '../nested.ts'

test('live Codex: structured response, real command exit, and explicit thread resume under Seatbelt', {
  skip: (nestedSandbox && NESTED_SKIP) || (!process.env.HQ_LIVE && 'HQ_LIVE=1 enables paid/subscription Codex calls'), timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-codex-live-'))
  const cwd = join(root, 'repo'), home = join(root, 'hq')
  mkdirSync(cwd)
  execFileSync('git', ['init', '-q', cwd])
  // HQ_CODEX_AUTH_SOURCE is for an isolated test HOME; values are never printed.
  prepareCodexHome(home, cwd, process.env.HQ_CODEX_AUTH_SOURCE ?? process.env.CODEX_HOME)
  const cfg = { ...DEFAULTS, home, codexBin: process.env.HQ_CODEX_BIN ?? 'codex' }
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
  let sessionId = randomUUID() as string
  const caches: string[] = []
  try {
    for (let n = 0; n < 2; n++) {
      const hqDir = join(root, `attempt-${n}`)
      const l = await launch({ codexBin: cfg.codexBin, argv: codexArgs(cfg, { role: 'review', model: 'haiku', sessionId, resume: n > 0, out: null }),
        cwd, hqDir, outDir: null, sessionId, spec: {}, schema,
        prompt: n === 0 ? 'Run exactly pwd using the shell tool. Remember the word otter. Return JSON {"answer":"HQ CODEX OK"}. No other tools.'
          : 'Return JSON whose answer is the word I asked you to remember. Do not use tools.',
        sandbox: { worktree: cwd, out: null, hqHome: home, tokenDir: join(root, 'tokens'), hqPort: 18627, extraWritable: [], projects: [] } })
      if (l.info.cacheDir) caches.push(l.info.cacheDir)
      const timer = setTimeout(() => killGroup(l.info.pid, 'SIGKILL'), 50_000)
      try { await new Promise<void>((resolve) => l.exit.onExit(resolve)) } finally { clearTimeout(timer); killGroup(l.info.pid, 'SIGKILL') }
      const tail = new StreamTail(hqDir); tail.poll()
      const result = tail.finalResult()
      assert.equal(l.exit.code, 0, readFileSync(join(hqDir, 'stderr.log'), 'utf8').slice(-500))
      assert.equal(result?.is_error, false, String(result?.result))
      assert.equal((result?.structured_output as any)?.answer, n === 0 ? 'HQ CODEX OK' : 'otter')
      if (n === 0) assert.ok(extractBashRuns(join(hqDir, 'stream.jsonl')).some(r => r.command === 'pwd' && r.exitCode === 0))
      else assert.equal(result?.session_id, sessionId)
      sessionId = String(result?.session_id)
    }
  } finally { for (const c of caches) removeCacheDir(c); rmSync(root, { recursive: true, force: true }) }
})
