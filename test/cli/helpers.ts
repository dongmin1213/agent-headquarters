// Test helpers: an isolated Ctx (temp root/home/agents dir, captured output, no real launchctl).
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, chmodSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCtx, type Ctx, type ExecResult } from '../../src/cli/ctx.ts'

export interface TestCtx extends Ctx { lines: string[]; errors: string[]; text(): string }

export function tmp(prefix = 'hq-cli-'): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))) }

export function testCtx(opts: { port?: number; dryRun?: boolean; run?: Ctx['run']; env?: Record<string, string> } = {}): TestCtx {
  const base = tmp()
  const root = join(base, 'repo'), user = join(base, 'user')
  mkdirSync(join(root, 'config'), { recursive: true }); mkdirSync(user)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: user,
    HQ_HOME: join(base, 'hqhome'), HQ_LAUNCH_AGENTS_DIR: join(base, 'agents'), HQ_TOKEN_FILE: join(base, 'token'),
    HQ_BIN_DIR: join(base, 'localbin'), HQ_PORT: String(opts.port ?? 1), ...(opts.dryRun === false ? {} : { HQ_DRY_RUN: '1' }), ...opts.env,
  }
  const lines: string[] = [], errors: string[] = []
  const fakeRun: Ctx['run'] = async (): Promise<ExecResult> => ({ code: 113, stdout: '', stderr: 'fake: not loaded' })
  const ctx = makeCtx(env, { root, out: (l) => { lines.push(l) }, err: (l) => { errors.push(l) }, run: opts.run ?? fakeRun }) as TestCtx
  ctx.lines = lines; ctx.errors = errors
  ctx.text = () => [...lines, ...errors].join('\n')
  return ctx
}

export function writeToken(ctx: Ctx, value = 'test-token-abc', mode = 0o600) {
  writeFileSync(ctx.tokenFile, value); chmodSync(ctx.tokenFile, mode)
}

/** A fake daemon: checks Host + Bearer like src/server.ts and serves the given snapshot. */
export async function fakeDaemon(token: string, snapshot: unknown, extra?: (path: string) => { status: number; body: unknown } | null): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' })
    const x = extra?.(req.url ?? '')
    if (x) return send(x.status, x.body)
    if (req.method === 'GET' && req.url === '/api/state') return send(200, snapshot)
    send(404, { error: 'not found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { server, port: (server.address() as { port: number }).port }
}

export async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as { port: number }).port
  await new Promise((r) => s.close(r))
  return port
}
