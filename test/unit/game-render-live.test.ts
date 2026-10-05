// Opt-in: briefly opens an isolated Godot window and records real rendered frames.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './helpers.ts'
import { runSandboxed } from '../../src/exec/checks.ts'
import { GAME_MACH_SERVICES, sandboxProfile } from '../../src/exec/sandbox.ts'

test('graphics capability is limited to game profiles and keeps launch tools denied', () => {
  const o = { worktree: '/tmp/game', out: null, hqHome: '/tmp/hq', tokenDir: '/tmp/token', hqPort: 18649, extraWritable: [], projects: [] }
  for (const service of GAME_MACH_SERVICES) {
    assert.ok(!sandboxProfile(o).includes(service))
    assert.ok(sandboxProfile({ ...o, graphics: true }).includes(service))
  }
  assert.match(sandboxProfile({ ...o, graphics: true }), /deny process-exec/)
  assert.ok(!sandboxProfile({ ...o, graphics: true }).includes('allow mach-lookup (global-name "com.apple.coreservices.launchservicesd")'))
})

test('live game sandbox renders a viewport, records a playable video and denies HQ secrets', {
  skip: !process.env.HQ_LIVE_GAME_RENDER && 'HQ_LIVE_GAME_RENDER=1 requires Godot, ffmpeg and a local display', timeout: 60_000,
}, async () => {
  const root = tmp('hq-game-render-'), cwd = join(root, 'game'), tokenDir = join(root, 'tokens')
  mkdirSync(cwd); mkdirSync(tokenDir)
  const secret = join(tokenDir, 'token'); writeFileSync(secret, 'test-only-secret')
  writeFileSync(join(cwd, 'project.godot'), 'config_version=5\n[application]\nconfig/name="HQ rendering test"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=180\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
  writeFileSync(join(cwd, 'smoke.gd'), `extends SceneTree
var frames = 0
var rect = ColorRect.new()
func _initialize():
 if FileAccess.open(${JSON.stringify(secret)}, FileAccess.READ) != null:
  quit(9)
 rect.color = Color(0.2, 0.8, 0.3)
 rect.size = Vector2(40, 40)
 root.add_child(rect)
func _process(_delta):
 frames += 1
 rect.position = Vector2(40 + frames, 60)
 if frames >= 120:
  var image = root.get_texture().get_image()
  if image == null:
   quit(2)
  else:
   var error = image.save_png("res://capture.png")
   print("HQ_RENDER_CHECK ", error)
   quit(error)
 return false
`)
  const profile = join(root, 'sandbox.sb')
  writeFileSync(profile, sandboxProfile({ worktree: cwd, out: null, hqHome: join(root, 'hq'), tokenDir, hqPort: 18649, extraWritable: [], projects: [], graphics: true }))
  try {
    const render = await runSandboxed('godot --path . --script smoke.gd --rendering-method gl_compatibility --audio-driver Dummy --resolution 320x180 --write-movie capture.avi --fixed-fps 30', cwd, 30_000, profile, 'render', undefined, true)
    assert.equal(render.pass, true, render.outputTail)
    assert.match(render.outputTail, /HQ_RENDER_CHECK 0/)
    const png = readFileSync(join(cwd, 'capture.png'))
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    assert.equal(png.readUInt32BE(16), 320); assert.equal(png.readUInt32BE(20), 180)
    const video = await runSandboxed('ffmpeg -hide_banner -loglevel error -i capture.avi -c:v libx264 -pix_fmt yuv420p -an capture.mp4', cwd, 20_000, profile, 'video', undefined, true)
    assert.equal(video.pass, true, video.outputTail)
    const metadata = await runSandboxed('ffprobe -v error -show_entries format=duration -of json capture.mp4', cwd, 5000, profile, 'probe', undefined, true)
    assert.equal(metadata.pass, true, metadata.outputTail)
    assert.ok(Number(JSON.parse(metadata.outputTail).format.duration) >= 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
