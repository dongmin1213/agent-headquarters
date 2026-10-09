import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('open CEO status refresh removes a recovered failure without replacing draft, selection or project', { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hqpet-refresh-'))
  try {
    const source = readFileSync('pet/main.swift', 'utf8').split('// MARK: - Start')[0]
    const exercise = `
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
MainActor.assumeIsolated {
    func require(_ condition: Bool, _ message: String) { if !condition { print("FAIL: " + message); exit(1) } }
    let pet = Pet()
    func state(_ status: String, _ headline: String) -> Snapshot {
        let json: [String: Any] = ["teams": [], "approvals": [], "decisions": [], "limit": [:],
          "projects": [["id": "game", "name": "게임개발팀"]],
          "headline": ["text": headline, "needsYou": 0],
          "requests": [["id": "req-test", "project": "game", "text": "대표 플레이 재구성", "status": status,
                         "note": "검사 경로 수정 필요", "questions": [], "updatedAt": "2026-10-09T07:19:51Z"]]]
        do { return try JSONDecoder().decode(Snapshot.self, from: JSONSerialization.data(withJSONObject: json)) }
        catch { print("FAIL: fixture decode: " + String(describing: error)); exit(1) }
    }
    pet.snapshot = state("blocked", "막혔어요")
    pet.ceoTab = 1
    let headline = pet.text("막혔어요")
    let tabs = NSSegmentedControl(labels: ["내 차례 0", "새 요청", "사용량"], trackingMode: .selectOne, target: nil, action: nil)
    tabs.selectedSegment = 1
    pet.ceoHeadlineField = headline
    pet.ceoTabs = tabs
    let body = pet.requestBody()
    let input = pet.requestInput!
    input.string = "작성 중인 새 지시"
    input.setSelectedRange(NSRange(location: 3, length: 2))
    let picker = pet.projectPicker!
    require(pet.recentResultsStack!.arrangedSubviews.count == 2, "initial failure visible")
    pet.snapshot = state("executing", "대표 플레이 재구성 구현 중")
    pet.refreshCeoStatus()
    require(headline.stringValue == "대표 플레이 재구성 구현 중", "headline follows recovery")
    require(pet.recentResultsStack!.arrangedSubviews.isEmpty, "old blocked result removed")
    require(pet.requestInput === input && input.string == "작성 중인 새 지시", "draft preserved")
    require(input.selectedRange() == NSRange(location: 3, length: 2), "selection preserved")
    require(pet.projectPicker === picker && picker.selectedItem?.representedObject as? String == "game", "project preserved")
    require(tabs.selectedSegment == 1, "tab preserved")
    pet.offline = true
    pet.refreshCeoStatus()
    require(headline.stringValue.contains("데몬이 꺼져"), "offline shown")
    withExtendedLifetime(body) {}
    print("PASS: recovery display and input preservation")
}
`
    writeFileSync(join(dir, 'main.swift'), source + exercise)
    const build = spawnSync('swiftc', ['-swift-version', '6', join(dir, 'main.swift'), '-o', join(dir, 'check')], { encoding: 'utf8', timeout: 90_000 })
    assert.equal(build.status, 0, build.stderr)
    const run = spawnSync(join(dir, 'check'), [], { encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: dir, HQ_URL: 'http://127.0.0.1:1', HQ_ALLOW_SECOND_INSTANCE: '1' } })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /PASS: recovery display and input preservation/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
