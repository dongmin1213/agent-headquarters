// §G 19: one-time DB move with VACUUM INTO (captures WAL-only commits), not repeated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateDb, Store } from '../../src/store.ts'
import { tmp } from './helpers.ts'

test('19. migration copies rows that live only in the WAL, and does not copy again', () => {
  const dir = tmp('hq-mig-')
  const old = join(dir, '.data', 'hq.db'), fresh = join(dir, 'home', 'hq.db')
  const s = new Store(old)
  s.raw().exec('pragma wal_autocheckpoint = 0')
  s.addRequest('req-wal00001', 'p', 'WAL에만 있는 행')
  s.set('marker', 'v1')
  // Keep the writer open so the rows stay in the -wal file only.
  assert.ok(existsSync(`${old}-wal`) && statSync(`${old}-wal`).size > 0, 'rows are in the WAL')
  assert.equal(migrateDb(old, fresh), true)
  const db = new DatabaseSync(fresh)
  assert.equal((db.prepare("select text from requests where id = 'req-wal00001'").get() as { text: string }).text, 'WAL에만 있는 행')
  assert.equal((db.prepare("select value from kv where key = 'migrated_from'").get() as { value: string }).value, old)
  db.close()
  s.addRequest('req-late0001', 'p', '나중 행')
  assert.equal(migrateDb(old, fresh), false, 'second start does not copy again')
  const again = new Store(fresh)
  assert.equal(again.request('req-late0001'), null)
  assert.ok(again.request('req-wal00001'))
  again.close(); s.close()
  assert.ok(existsSync(old), 'original kept')
})
