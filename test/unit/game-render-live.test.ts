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

test('live game sandbox plays real audio while regular workers and HQ secrets stay isolated', {
  skip: !process.env.HQ_LIVE_GAME_AUDIO && 'HQ_LIVE_GAME_AUDIO=1 requires a local audio output device', timeout: 30_000,
}, async () => {
  const root = tmp('hq-game-audio-'), cwd = join(root, 'game'), tokenDir = join(root, 'tokens')
  mkdirSync(cwd); mkdirSync(tokenDir)
  const secret = join(tokenDir, 'token'); writeFileSync(secret, 'test-only-secret')
  // A quiet 0.2-second PCM tone; this checks real output, not subjective sound quality.
  const rate = 22050, frames = 4410, wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(300 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2)
  writeFileSync(join(cwd, 'tone.wav'), wav)
  const profile = join(root, 'sandbox.sb')
  const options = { worktree: cwd, out: null, hqHome: join(root, 'hq'), tokenDir, hqPort: 18649, extraWritable: [], projects: [] }
  try {
    writeFileSync(profile, sandboxProfile(options))
    const denied = await runSandboxed('/usr/bin/afplay -v 0.1 tone.wav', cwd, 5000, profile, 'audio-denied', undefined, true)
    assert.equal(denied.pass, false, 'ordinary workers do not acquire audio access')
    writeFileSync(profile, sandboxProfile({ ...options, graphics: true }))
    const played = await runSandboxed('/usr/bin/afplay -v 0.1 tone.wav', cwd, 5000, profile, 'audio-output', undefined, true)
    assert.equal(played.pass, true, played.outputTail)
    const readSecret = await runSandboxed(`/bin/cat ${secret}`, cwd, 5000, profile, 'secret', undefined, true)
    assert.equal(readSecret.pass, false)
    assert.ok(!readSecret.outputTail.includes('test-only-secret'))
  } finally { rmSync(root, { recursive: true, force: true }) }
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
