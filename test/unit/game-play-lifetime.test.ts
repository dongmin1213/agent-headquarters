import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, tmp } from './helpers.ts'

test('play clock keeps an active session beyond fifteen minutes but expires idle and abandoned sessions', {
  skip: spawnSync('godot', ['--version'], { timeout: 5_000 }).status !== 0 && 'Godot is required for the transport clock test',
}, () => {
  const root = tmp('hq-play-clock-')
  try {
    writeFileSync(join(root, 'project.godot'), 'config_version=5\n')
    writeFileSync(join(root, 'check.gd'), `extends SceneTree
func _initialize():
 var clock = load(${JSON.stringify(join(ROOT, 'tools/game-play/session_clock.gd'))}).new(0)
 assert(clock.expired(899000000) == "")
 clock.touch(899000000)
 assert(clock.expired(901000000) == "", "valid input must preserve in-room progress past the old absolute limit")
 assert(clock.expired(1799000000) == "idle_timeout_15m")
 clock.touch(7199000000)
 assert(clock.expired(7200000000) == "session_limit_2h", "activity must not keep abandoned sessions forever")
 quit()
`)
    const run = spawnSync('godot', ['--headless', '--path', root, '--script', join(root, 'check.gd')], { encoding: 'utf8', timeout: 15_000 })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.doesNotMatch(run.stderr, /SCRIPT ERROR|Assertion failed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CLI reports recorded session expiry immediately and stopping it remains idempotent', () => {
  const root = tmp('hq-play-expired-'), script = join(ROOT, 'tools/game-play/play.py')
  try {
    writeFileSync(join(root, 'session.json'), '{}')
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ reason: 'idle_timeout_15m' }))
    const step = spawnSync('python3', [script, 'step', '--session', root], { encoding: 'utf8', timeout: 2_000 })
    assert.equal(step.status, 1)
    assert.match(step.stderr, /idle_timeout_15m/)
    const stop = spawnSync('python3', [script, 'stop', '--session', root], { encoding: 'utf8', timeout: 2_000 })
    assert.equal(stop.status, 0)
    assert.equal(JSON.parse(stop.stdout).stopped, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
