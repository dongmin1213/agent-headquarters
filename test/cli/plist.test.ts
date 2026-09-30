import { test } from 'node:test'
import assert from 'node:assert/strict'
import { daemonPlist, launchPath, petPlist, renderPlist, xmlEscape } from '../../src/cli/plist.ts'

const opts = { label: 'com.agent-headquarters.daemon', nodePath: '/opt/node/bin/node', root: '/Users/me/src/hq', home: '/Users/me/.hq', port: 7777, path: '/opt/node/bin:/usr/bin', logFile: '/Users/me/.hq/logs/daemon.log' }

test('daemon plist has the required launchd keys', () => {
  const x = daemonPlist(opts)
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>/)
  assert.match(x, /<key>Label<\/key>\s*<string>com\.agent-headquarters\.daemon<\/string>/)
  assert.match(x, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/Users\/me\/src\/hq\/src\/main\.ts<\/string>\s*<\/array>/)
  assert.match(x, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(x, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/)
  assert.match(x, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
  assert.match(x, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/src\/hq<\/string>/)
  assert.match(x, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:\/usr\/bin<\/string>/)
  assert.match(x, /<key>HQ_HOME<\/key>\s*<string>\/Users\/me\/\.hq<\/string>/)
  assert.match(x, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/\.hq\/logs\/daemon\.log<\/string>/)
  assert.match(x, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/\.hq\/logs\/daemon\.log<\/string>/)
  assert.doesNotMatch(x, /HQ_TOKEN_FILE/)
})

test('values are XML-escaped', () => {
  const x = daemonPlist({ ...opts, root: `/Users/me/a&b <"x'>` })
  assert.match(x, /<string>\/Users\/me\/a&amp;b &lt;&quot;x&apos;&gt;<\/string>/)
  assert.doesNotMatch(x, /a&b/)
  assert.equal(xmlEscape(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;')
  assert.match(renderPlist({ 'k&': 'v' }), /<key>k&amp;<\/key>/)
})

test('pet plist runs the app binary at load', () => {
  const x = petPlist({ label: 'com.agent-headquarters.pet', appBinary: '/r/pet/HQPet.app/Contents/MacOS/hqpet', logFile: '/h/logs/pet.log' })
  assert.match(x, /<string>com\.agent-headquarters\.pet<\/string>/)
  assert.match(x, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/r\/pet\/HQPet\.app\/Contents\/MacOS\/hqpet<\/string>/)
  assert.match(x, /<key>RunAtLoad<\/key>\s*<true\/>/)
})

test('launchPath puts tool dirs first and dedupes', () => {
  assert.equal(launchPath(['/a/bin/node', '/b/claude', null, '/usr/bin/git']), '/a/bin:/b:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin')
})

test('generated plist parses with plutil', async (t) => {
  const { runCmd } = await import('../../src/cli/ctx.ts')
  const { writeFileSync } = await import('node:fs')
  const { tmp } = await import('./helpers.ts')
  if ((await runCmd('plutil', ['-help'])).code === 127) return t.skip('plutil not available')
  const f = tmp() + '/d.plist'
  writeFileSync(f, daemonPlist({ ...opts, root: `/weird & <path>` }))
  const r = await runCmd('plutil', ['-lint', f])
  assert.equal(r.code, 0, r.stdout + r.stderr)
})
