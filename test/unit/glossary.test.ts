// One vocabulary across surfaces: src/glossary.ts, the web copy (lib.js) and the pet copy (main.swift) are identical.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCKED_LABELS, GLOSSARY, KIND_LABELS } from '../../src/glossary.ts'
import { BLOCKED_OPTIONS_LINGERING } from '../../src/exec/decisions.ts'
// @ts-expect-error — plain browser JS module without type declarations
import * as lib from '../../src/web/assets/lib.js'
import type { DecisionItem } from '../../src/types.ts'

const ROOT = join(import.meta.dirname, '../..')

test('glossary: web copy is identical to src/glossary.ts', () => {
  assert.deepEqual(lib.GLOSSARY, GLOSSARY)
  assert.deepEqual(lib.KIND_LABELS, KIND_LABELS)
  for (const [k, label] of Object.entries(KIND_LABELS)) assert.equal(lib.DECISION_KIND[k][0], label, `web chip for ${k}`)
})

test('glossary: pet kindLabels are identical to src/glossary.ts', () => {
  const swift = readFileSync(join(ROOT, 'pet/main.swift'), 'utf8')
  const block = /static let kindLabels = \[([\s\S]*?)\]/.exec(swift)
  assert.ok(block, 'Pet.kindLabels found')
  const pet = Object.fromEntries([...block[1].matchAll(/"([a-z_]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]))
  assert.deepEqual(pet, KIND_LABELS)
})

test('glossary: blocked option labels are identical in web and pet and cover every blocked option', () => {
  assert.deepEqual(lib.BLOCKED_LABEL, BLOCKED_LABELS)
  const swift = readFileSync(join(ROOT, 'pet/main.swift'), 'utf8')
  const line = /static let blockedLabels = \[(.*)\]/.exec(swift)
  assert.ok(line, 'Pet.blockedLabels found')
  assert.deepEqual(Object.fromEntries([...line[1].matchAll(/"([a-z_]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]])), BLOCKED_LABELS)
  assert.deepEqual(Object.keys(BLOCKED_LABELS).sort(), [...BLOCKED_OPTIONS_LINGERING].sort())
})

test('glossary: every decision kind has a label; old or foreign terms are gone from chairman surfaces', () => {
  const kinds: DecisionItem['kind'][] = ['system', 'plan', 'ceo_question', 'worker_question', 'revise', 'blocked', 'integration', 'accept', 'merge', 'team']
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), [...kinds].sort())
  const strings = (text: string) => [...text.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2])
  const files = [join(ROOT, 'pet/main.swift'), join(ROOT, 'src/exec/decisions.ts'), ...readdirSync(join(ROOT, 'src/web/assets')).filter((f) => f.endsWith('.js')).map((f) => join(ROOT, 'src/web/assets', f)),
    ...readdirSync(join(ROOT, 'src/cli')).map((f) => join(ROOT, 'src/cli', f))]
  for (const f of files) {
    const lits = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).flatMap(strings)
    for (const s of lits) assert.doesNotMatch(s, /CEO|회로 차단|멈춤 ·/, `${f}: "${s}"`)
  }
})
