// In-process event bus. Every event is persisted and pushed to SSE subscribers (the pet).
import type { ServerResponse } from 'node:http'
import type { HqEvent } from './types.ts'
import type { Store } from './store.ts'

export class Bus {
  private clients = new Set<ServerResponse>()
  private store: Store
  constructor(store: Store) { this.store = store }

  emit(e: Omit<HqEvent, 'at'>): void {
    const ev: HqEvent = { at: new Date().toISOString(), ...e }
    ev.id = this.store.addEvent(ev)
    const payload = `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`
    for (const c of this.clients) c.write(payload)
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': connected\n\n')
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }

  /** Keeps SSE connections alive and lets the pet detect a dead daemon (no heartbeat = offline). */
  heartbeat(): void {
    for (const c of this.clients) c.write(`event: heartbeat\ndata: ${Date.now()}\n\n`)
  }
}
