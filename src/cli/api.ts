// Minimal client for the daemon API (127.0.0.1 only, Bearer token, no Origin header).
import { request } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import type { Ctx } from './ctx.ts'

export interface ApiResponse { status: number; body: any }

/** Returns the token or null. The value is never printed. */
export function readToken(ctx: Ctx): string | null {
  try { return existsSync(ctx.tokenFile) ? readFileSync(ctx.tokenFile, 'utf8').trim() || null : null } catch { return null }
}

export function apiRequest(port: number, token: string | null, method: string, path: string, body?: unknown, timeoutMs = 3000): Promise<ApiResponse> {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` }
    if (token) headers.authorization = `Bearer ${token}`
    if (payload !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)) }
    const req = request({ host: '127.0.0.1', port, method, path, headers, timeout: timeoutMs }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { if (raw.length < 4_000_000) raw += c })
      res.on('end', () => {
        let parsed: unknown = raw
        try { parsed = raw ? JSON.parse(raw) : null } catch { /* not JSON */ }
        done({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', fail)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

export type HqProbe =
  | { kind: 'hq'; snapshot: Record<string, any> }
  | { kind: 'unauthorized' }
  | { kind: 'other'; status: number }
  | { kind: 'down' }
  | { kind: 'error'; message: string }

/** What answers on the port: hq (200 on /api/state), hq with a different token (401), something else, or nothing. */
export async function probeHq(ctx: Ctx, timeoutMs = 2000): Promise<HqProbe> {
  try {
    const r = await apiRequest(ctx.port, readToken(ctx), 'GET', '/api/state', undefined, timeoutMs)
    if (r.status === 200 && r.body && typeof r.body === 'object') return { kind: 'hq', snapshot: r.body }
    if (r.status === 401 && r.body && typeof r.body === 'object' && r.body.error === 'unauthorized') return { kind: 'unauthorized' }
    return { kind: 'other', status: r.status }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ECONNREFUSED') return { kind: 'down' }
    return { kind: 'error', message: code ?? String(e) }
  }
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() >= end) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}
