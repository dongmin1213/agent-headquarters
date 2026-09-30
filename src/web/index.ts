// Web detail UI (docs/design/execution.md §15). Stub: owned by the web-ui work stream.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiRouter } from '../server.ts'

export interface WebUi {
  /** Handles /ui, /ui/*, /ui-api/* (cookie + CSRF auth, then delegates /ui-api/* to routeApi as /api/*). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** One-time login URL (60 s) the pet opens in the browser. */
  issueLoginUrl(): string
}

export function createWebUi(opts: { port: number; token: string; routeApi: ApiRouter }): WebUi {
  return {
    async handle(_req, res) { res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' }); res.end('web ui not built yet') },
    issueLoginUrl() { return `http://127.0.0.1:${opts.port}/ui` },
  }
}
