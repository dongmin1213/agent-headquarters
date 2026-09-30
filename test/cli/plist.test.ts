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

const petOpts = { label: 'com.agent-headquarters.pet', appBinary: '/r/pet/HQPet.app/Contents/MacOS/hqpet', logFile: '/h/logs/pet.log', port: 7777, tokenFile: '/Users/me/.config/hq/token', suffix: null }

test('pet plist runs the app binary at load', () => {
  const x = petPlist(petOpts)
  assert.match(x, /<string>com\.agent-headquarters\.pet<\/string>/)
  assert.match(x, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/r\/pet\/HQPet\.app\/Contents\/MacOS\/hqpet<\/string>/)
  assert.match(x, /<key>RunAtLoad<\/key>\s*<true\/>/)
})

test('pet plist tells the pet where the daemon and token are; non-default installs get their own defaults suite', () => {
  const def = petPlist(petOpts)
  assert.match(def, /<key>EnvironmentVariables<\/key>\s*<dict>/)
  assert.match(def, /<key>HQ_URL<\/key>\s*<string>http:\/\/127\.0\.0\.1:7777<\/string>/)
  assert.match(def, /<key>HQ_TOKEN_FILE<\/key>\s*<string>\/Users\/me\/\.config\/hq\/token<\/string>/)
  assert.doesNotMatch(def, /HQ_DEFAULTS_SUITE|HQ_ALLOW_SECOND_INSTANCE/)
  const other = petPlist({ ...petOpts, port: 7790, tokenFile: '/tmp/x/token', suffix: 'ab12cd34' })
  assert.match(other, /<key>HQ_URL<\/key>\s*<string>http:\/\/127\.0\.0\.1:7790<\/string>/)
  assert.match(other, /<key>HQ_TOKEN_FILE<\/key>\s*<string>\/tmp\/x\/token<\/string>/)
  assert.match(other, /<key>HQ_DEFAULTS_SUITE<\/key>\s*<string>hqpet\.ab12cd34<\/string>/)
  assert.match(other, /<key>HQ_ALLOW_SECOND_INSTANCE<\/key>\s*<string>1<\/string>/)
})

test('the pet reads exactly the env names the plist sets', async () => {
  const { readFileSync } = await import('node:fs')
  const swift = readFileSync(new URL('../../pet/main.swift', import.meta.url), 'utf8')
  for (const k of ['HQ_URL', 'HQ_TOKEN_FILE', 'HQ_DEFAULTS_SUITE', 'HQ_ALLOW_SECOND_INSTANCE']) assert.ok(swift.includes(`env["${k}"]`), k)
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
