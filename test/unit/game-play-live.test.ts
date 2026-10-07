import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, tmp } from './helpers.ts'
import { runSandboxed } from '../../src/exec/checks.ts'
import { sandboxProfile } from '../../src/exec/sandbox.ts'

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
test('live sandbox accepts ordinary key events, releases keys, captures pixels and isolates saves', {
  skip: !process.env.HQ_LIVE_GAME_PLAY && 'HQ_LIVE_GAME_PLAY=1 opens a real Godot window', timeout: 90_000,
}, async () => {
  const root = tmp('hq-live-play-'), project = join(root, 'game'), session = join(root, 'session')
  const tokenDir = join(root, 'secrets'), profile = join(root, 'sandbox.sb'), helper = join(ROOT, 'tools/game-play')
  mkdirSync(project); mkdirSync(tokenDir); writeFileSync(join(tokenDir, 'token'), 'test-secret')
  writeFileSync(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="HQ play input test"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
  writeFileSync(join(project, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n')
  writeFileSync(join(project, 'main.gd'), `extends Node2D
var save_root := "user://save"
var moves := 0
func _ready():
 DirAccess.make_dir_recursive_absolute(save_root)
func _physics_process(_delta):
 if Input.is_physical_key_pressed(KEY_D): moves += 1
 var f = FileAccess.open(save_root+"/observation.json",FileAccess.WRITE)
 f.store_string(JSON.stringify({"moves":moves,"held":Input.is_physical_key_pressed(KEY_D)}))
 queue_redraw()
func _draw():
 draw_rect(Rect2(moves,20,30,30),Color.GREEN)
`)
  writeFileSync(profile, sandboxProfile({ worktree: project, out: null, hqHome: join(root, 'hq'), tokenDir, hqPort: 18649, extraWritable: [], projects: [ROOT], graphics: true, readable: [helper] }))
  const command = (op: string) => `python3 ${quote(join(helper, 'play.py'))} ${op} --session ${quote(session)}`
  const run = (cmd: string) => runSandboxed(cmd, project, 35_000, profile, 'live-play', undefined, true)
  try {
    const boot = await run(command(`start --project ${quote(project)}`)); assert.equal(boot.pass, true, boot.outputTail)
    const step = await run(command('step --keys D --seconds 0.3')); assert.equal(step.pass, true, step.outputTail)
    const out = JSON.parse(step.outputTail.trim().split('\n').at(-1)!)
    assert.equal(readFileSync(out.screenshot).subarray(1,4).toString(), 'PNG')
    const idle = await run(command('step --seconds 0.2')); assert.equal(idle.pass, true, idle.outputTail)
    const state = JSON.parse(readFileSync(join(session, 'save/observation.json'), 'utf8'))
    assert.ok(state.moves > 0, 'ordinary physical-key polling receives input'); assert.equal(state.held, false)
    const next = await run(command('step --seconds 0.2')); assert.equal(next.pass, true, next.outputTail)
    assert.equal(JSON.parse(readFileSync(join(session, 'save/observation.json'), 'utf8')).moves, state.moves, 'keys do not remain stuck')
    const denied = await run(`/bin/cat ${quote(join(tokenDir, 'token'))}`); assert.equal(denied.pass, false)
    const bad = await run(command('step --keys CMD --seconds 0.1')); assert.equal(bad.pass, false, 'arbitrary shortcuts rejected')
  } finally {
    if (existsSync(join(session,'session.json'))) {
      await run(command('stop'))
      const pid = JSON.parse(readFileSync(join(session,'session.json'),'utf8')).pid
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
    rmSync(root, { recursive: true, force: true })
  }
})
