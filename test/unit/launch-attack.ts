// S1 attack set shared by the worker and team profile tests: LaunchServices launch via NSWorkspace, copied
// open/launchctl, defaults write. `run` executes a shell command inside the profile under test.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

type Run = (cmd: string, ms?: number) => Promise<{ pass: boolean; outputTail: string }>

/** Every launch path must fail, and no process outside the sandbox may read `tokenDir`/token. */
export async function launchServicesAttack(t: TestContext, dir: string, tokenDir: string, run: Run): Promise<void> {
  const rand = () => randomUUID().slice(0, 8)
  const evil = join(dir, 'evil'), leak = join(evil, 'leak.txt')
  const app = join(evil, 'Evil.app', 'Contents')
  mkdirSync(join(app, 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>x</string><key>CFBundleIdentifier</key><string>test.hq.evil.${rand()}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
  writeFileSync(join(app, 'MacOS', 'x'), `#!/bin/sh\ncat '${tokenDir}/token' > '${leak}' 2>&1\n`); chmodSync(join(app, 'MacOS', 'x'), 0o755)
  const label = `test.hq.evil.${rand()}`
  try {
    const hasSwift = spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status === 0
    if (!hasSwift) t.diagnostic('swiftc 없음: NSWorkspace 공격은 건너뜀 (Xcode 명령행 도구 필요)')
    else {
      writeFileSync(join(evil, 'l.swift'), 'import AppKit\nlet c = NSWorkspace.OpenConfiguration(); c.activates = false\nlet s = DispatchSemaphore(value: 0)\n'
        + 'NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: CommandLine.arguments[1]), configuration: c) { app, err in print(app == nil ? "LAUNCH-FAILED" : "LAUNCHED"); s.signal() }\n_ = s.wait(timeout: .now() + 15)\n')
      // Compiled outside the sandbox so the attack binary certainly runs; only the launch happens inside.
      execFileSync('/usr/bin/xcrun', ['swiftc', '-o', join(evil, 'launcher'), join(evil, 'l.swift')], { stdio: 'ignore', timeout: 120_000 })
      const r = await run(`'${join(evil, 'launcher')}' '${join(evil, 'Evil.app')}'`, 30_000)
      assert.doesNotMatch(r.outputTail, /LAUNCHED/, 'LaunchServices must refuse the launch')
      assert.match(r.outputTail, /LAUNCH-FAILED/, `the attack binary ran and was refused: ${r.outputTail}`)
    }
    for (const [src, name] of [['/usr/bin/open', 'op'], ['/bin/launchctl', 'lc']]) execFileSync('/bin/cp', [src, join(evil, name)])
    execFileSync('/usr/bin/codesign', ['-s', '-', '-f', join(evil, 'lc')], { stdio: 'ignore' })
    assert.equal((await run(`'${join(evil, 'op')}' -a '${join(evil, 'Evil.app')}'`)).pass, false, 'copied open')
    assert.equal((await run(`/usr/bin/open -a '${join(evil, 'Evil.app')}'`)).pass, false, '/usr/bin/open')
    assert.equal((await run(`'${join(evil, 'lc')}' submit -l ${label} -- /bin/sh -c "cat '${tokenDir}/token' > '${leak}'"`)).pass, false, 'ad-hoc signed launchctl submit')
    assert.equal((await run(`/usr/bin/defaults write com.apple.hq-test-${rand()} x 1`)).pass, false, 'defaults write (cfprefsd)')
    await new Promise((r) => setTimeout(r, 3_000))
    assert.equal(existsSync(leak), false, 'no process outside the sandbox read the token')
  } finally {
    spawnSync('/bin/launchctl', ['remove', label], { stdio: 'ignore' })
  }
}
