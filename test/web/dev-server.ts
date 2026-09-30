// Dev server for the web UI against the mock API.
//   node test/web/dev-server.ts [port]
// Prints a one-time login URL. GET /__dev/login-url returns a fresh one; GET /__dev/drop-sse ends open event streams (dev only).
import { createServer } from 'node:http'
import { createWebUi } from '../../src/web/index.ts'
import { createMockApi } from './mock-api.ts'

const port = Number(process.argv[2] ?? 7788)
const mock = createMockApi({ live: true })
const web = createWebUi({ port, token: 'mock-token', routeApi: mock.routeApi })

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/ui' || path.startsWith('/ui/') || path.startsWith('/ui-api/')) return await web.handle(req, res)
    if (path === '/__dev/drop-sse') { mock.dropStreams(); res.writeHead(204); return void res.end() }
    if (path === '/__dev/login-url') { res.writeHead(200, { 'content-type': 'text/plain' }); return void res.end(web.issueLoginUrl()) }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e))
  }
})
server.listen(port, '127.0.0.1', () => console.log(web.issueLoginUrl()))
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { mock.close(); server.close(); process.exit(0) })
