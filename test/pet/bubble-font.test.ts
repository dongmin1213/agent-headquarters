import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let bin = ''

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqpet-font-'))
  bin = join(dir, 'hqpet')
  const r = spawnSync('swiftc', ['-swift-version', '6', 'pet/main.swift', '-o', bin], { encoding: 'utf8', timeout: 300_000 })
  assert.equal(r.status, 0, r.stderr)
}, { timeout: 330_000 })

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

let n = 0
function run(content: string | null) {
  const file = join(dir, content === null ? 'missing.json' : `pet-${n++}.json`)
  if (content !== null) writeFileSync(file, content)
  const r = spawnSync(bin, [], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', HOME: dir, HQ_PET_PRINT_CONFIG: '1', HQ_PET_CONFIG: file } })
  assert.equal(r.status, 0, r.stderr)
  return r
}

const cases: [string, string | null, string, boolean | null][] = [
  ['file missing', null, '10.0', false],
  ['14', '{"bubbleFontSize":14}', '14.0', false],
  ['12.5', '{"bubbleFontSize":12.5}', '12.5', false],
  ['lower bound 8', '{"bubbleFontSize":8}', '8.0', false],
  ['upper bound 24', '{"bubbleFontSize":24}', '24.0', false],
  ['string', '{"bubbleFontSize":"big"}', '10.0', true],
  ['zero', '{"bubbleFontSize":0}', '10.0', true],
  ['too large', '{"bubbleFontSize":100}', '10.0', true],
  ['boolean', '{"bubbleFontSize":true}', '10.0', true],
  ['broken JSON', '{bubble', '10.0', true],
  ['top-level array', '[14]', '10.0', true],
  ['empty object', '{}', '10.0', false],
  ['unknown key ignored', '{"other":1}', '10.0', false],
]

for (const [name, content, want, warns] of cases) {
  test(`bubbleFontSize: ${name}`, () => {
    const r = run(content)
    assert.equal(r.stdout.trim(), `bubbleFontSize=${want}`)
    if (warns) assert.match(r.stderr, /pet\.json:/)
    else assert.doesNotMatch(r.stderr, /pet\.json:/)
  })
}
