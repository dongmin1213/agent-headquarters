// hq desk pet: shows each team and Claude session as a small character you can drag anywhere. Reads the hq daemon (127.0.0.1).
// Click a character for details and approval buttons. Menu bar icon: run teams, quit.
import AppKit

// MARK: - API models (mirror hq/src/types.ts)
struct RunRecord: Decodable { let exitCode: Int?; let summary: String?; let endedAt: String? }
struct TeamView: Decodable { let id: String; let name: String; let pack: String; let state: String; let bubble: String; let lastRun: RunRecord?; let nextRunAt: String? }
struct Approval: Decodable { let id: String; let teamId: String; let title: String; let body: String; let options: [String]; let subjectHash: String; let expiresAt: String }
struct RequestQuestion: Decodable { let id: String; let question: String; let options: [String]; let `default`: String; let reason: String; let answer: String? }
struct PlanTaskView: Decodable { let id: String; let title: String; let project: String; let role: String; let grade: String; let model: String }
struct PlanView: Decodable { let summary: String; let assumptions: [String]; let tasks: [PlanTaskView] }
struct RequestView: Decodable { let id: String; let project: String; let text: String; let status: String; let note: String?; let questions: [RequestQuestion]; let plan: PlanView? }
struct ProjectRef: Decodable { let id: String; let name: String }
struct Snapshot: Decodable {
    let teams: [TeamView]; let approvals: [Approval]; let limit: Limit
    var requests: [RequestView]? = nil; var projects: [ProjectRef]? = nil
    struct Limit: Decodable { let blockedUntil: String? }
}

let base = URL(string: ProcessInfo.processInfo.environment["HQ_URL"] ?? "http://127.0.0.1:7777")!
let tokenPath = ProcessInfo.processInfo.environment["HQ_TOKEN_FILE"] ?? (NSHomeDirectory() + "/.config/hq/token")
func authed(_ url: URL) -> URLRequest {
    var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
    let token = (try? String(contentsOfFile: tokenPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    return r
}
let packsDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HQ_PACKS"] ?? (Bundle.main.resourcePath.map { $0 + "/packs" } ?? "packs"))

// MARK: - One character on screen
/// Image view that tells a click (no movement) apart from a drag, and moves its character while dragging.
@MainActor final class DragImageView: NSImageView {
    var onClick: (() -> Void)?
    var onDrag: ((CGFloat, CGFloat) -> Void)?
    var onDrop: (() -> Void)?
    static var dragging = false
    private var last: NSPoint = .zero
    private var moved: CGFloat = 0
    override func mouseDown(with e: NSEvent) { last = NSEvent.mouseLocation; moved = 0; DragImageView.dragging = true }
    override func mouseDragged(with e: NSEvent) {
        let p = NSEvent.mouseLocation
        let dx = p.x - last.x, dy = p.y - last.y
        moved += abs(dx) + abs(dy); last = p
        if moved > 3 { onDrag?(dx, dy) }
    }
    override func mouseUp(with e: NSEvent) { DragImageView.dragging = false; if moved > 3 { onDrop?() } else { onClick?() } }
}

@MainActor final class Critter {
    let id: String
    let view = DragImageView()
    let bubble = NSTextField(labelWithString: "")
    var x: CGFloat
    var y: CGFloat
    var phase: CGFloat = 0
    var team: TeamView
    var hovered = false
    let size: CGFloat = 40

    init(team: TeamView, in content: NSView, defaultX: CGFloat) {
        id = team.id; self.team = team
        let saved = UserDefaults.standard.array(forKey: "pos." + team.id) as? [Double]
        let b = content.bounds
        x = min(max(0, saved.map { CGFloat($0[0]) } ?? defaultX), b.width - 40)
        y = min(max(0, saved.map { CGFloat($0[1]) } ?? 4), b.height - 64)
        view.image = team.id == "ceo" ? Critter.named(pack: "pokemon", file: "pikachu.gif") : Critter.sprite(pack: team.pack, key: team.id)
        view.imageScaling = .scaleProportionallyUpOrDown
        view.animates = false
        view.wantsLayer = true
        view.layer?.magnificationFilter = .nearest
        bubble.font = .systemFont(ofSize: 10, weight: .medium)
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = 6
        bubble.drawsBackground = true
        bubble.alignment = .center
        bubble.maximumNumberOfLines = 1
        bubble.lineBreakMode = .byTruncatingTail
        content.addSubview(view); content.addSubview(bubble)
    }

    static func named(pack: String, file: String) -> NSImage? {
        NSImage(contentsOf: packsDir.appendingPathComponent(pack).appendingPathComponent("pool").appendingPathComponent(file)) ?? sprite(pack: pack, key: file)
    }

    static func sprite(pack: String, key: String) -> NSImage? {
        let dir = packsDir.appendingPathComponent(pack).appendingPathComponent("pool")
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".gif") || $0.hasSuffix(".png") }.sorted()
        guard !files.isEmpty else { return NSImage(systemSymbolName: "questionmark.circle", accessibilityDescription: nil) }
        var h: UInt32 = 2166136261; for b in key.utf8 { h = (h ^ UInt32(b)) &* 16777619 }  // stable pick per team
        return NSImage(contentsOf: dir.appendingPathComponent(files[Int(h % UInt32(files.count))]))
    }

    func move(dx: CGFloat, dy: CGFloat, bounds: NSRect) {
        x = min(max(0, x + dx), bounds.width - size)
        y = min(max(0, y + dy), bounds.height - size - 24)
    }

    func savePosition() { UserDefaults.standard.set([Double(x), Double(y)], forKey: "pos." + id) }

    /// Characters stay where they are put; only a waiting team hops a little to get attention.
    func layout() {
        phase += 0.25
        let hop: CGFloat = team.state == "waiting" ? (abs(sin(phase)) * 5).rounded() : 0
        let f = NSRect(x: x, y: y + hop, width: size, height: size)
        if view.frame != f { view.frame = f }
        // Only busy characters animate: motion itself means "working", and idle ones cost no CPU.
        let animate = team.state == "working" || team.state == "waiting" || hovered
        if view.animates != animate { view.animates = animate }
        let alpha: CGFloat = team.state == "sleeping" ? 0.6 : 1
        if view.alphaValue != alpha { view.alphaValue = alpha }

        let icon: String = ["waiting": "✋ ", "sleeping": "💤 ", "error": "⚠️ "][team.state] ?? ""
        let text = "\(icon)\(team.name) · \(team.bubble)"
        // Quiet sessions stay tidy: no bubble while idle unless hovered.
        let hidden = false
        if bubble.isHidden != hidden { bubble.isHidden = hidden }
        if bubble.stringValue != text { bubble.stringValue = text; view.toolTip = text; bubble.sizeToFit() }
        let bw = min(bubble.fittingSize.width + 12, 220)
        let bf = NSRect(x: max(0, x + size / 2 - bw / 2), y: y + size + 4, width: bw, height: 16)
        if bubble.frame != bf { bubble.frame = bf }
        let (bg, fg): (NSColor, NSColor) = switch team.state {
            case "error": (.systemRed, .white)
            case "waiting": (.systemYellow, .black)
            case "sleeping": (.systemGray, .white)
            default: (NSColor.windowBackgroundColor.withAlphaComponent(0.92), .labelColor)
        }
        if bubble.backgroundColor != bg { bubble.backgroundColor = bg }
        if bubble.textColor != fg { bubble.textColor = fg }
    }

    var hitRect: NSRect { bubble.isHidden ? view.frame : view.frame.union(bubble.frame) }
    func remove() { view.removeFromSuperview(); bubble.removeFromSuperview() }
}

// MARK: - Overlay window + controller
@MainActor final class Pet: NSObject, NSPopoverDelegate {
    let panel: NSPanel
    var critters: [String: Critter] = [:]
    var lastActive: [String: Date] = [:]
    var snapshot: Snapshot?
    var offline = false
    let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var popover: NSPopover?

    override init() {
        let f = NSScreen.main!.visibleFrame
        panel = NSPanel(contentRect: f, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.orderFrontRegardless()
        status.button?.title = "🏢"
        rebuildMenu()

        Timer.scheduledTimer(withTimeInterval: 1.0 / 12, repeats: true) { _ in MainActor.assumeIsolated { self.frame() } }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in MainActor.assumeIsolated { self.refresh() } }
        refresh()
    }

    func frame() {
        for c in critters.values { c.layout() }
        // Click-through everywhere except on a character or its bubble.
        let p = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        var over = DragImageView.dragging  // keep receiving events for the whole drag
        for c in critters.values { let h = c.view.frame.insetBy(dx: -4, dy: -4).contains(p); if c.hovered != h { c.hovered = h }; if c.hitRect.insetBy(dx: -4, dy: -4).contains(p) { over = true } }
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
    }

    func refresh() {
        Task { @MainActor in
            do {
                let (data, resp) = try await URLSession.shared.data(for: authed(base.appendingPathComponent("api/state")))
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
                apply(try JSONDecoder().decode(Snapshot.self, from: data), offline: false)
            } catch {
                FileHandle.standardError.write("refresh failed: \(error)\n".data(using: .utf8)!)
                apply(Snapshot(teams: [TeamView(id: "hq", name: "본부", pack: "digimon", state: "sleeping", bubble: "연결 끊김 (hq 데몬 꺼짐) — 승인 불가", lastRun: nil, nextRunAt: nil)], approvals: [], limit: .init(blockedUntil: nil)), offline: true)
            }
        }
    }

    func apply(_ s: Snapshot, offline: Bool) {
        snapshot = s; self.offline = offline
        if ProcessInfo.processInfo.environment["HQ_DEBUG"] != nil { FileHandle.standardError.write("apply teams=\(s.teams.count) offline=\(offline) critters=\(critters.count)\n".data(using: .utf8)!) }
        let content = panel.contentView!
        let reqs = s.requests ?? []
        let active = reqs.first { ["thinking", "asking", "planned", "queued"].contains($0.status) } ?? reqs.first
        let ceoState: String = switch active?.status { case "thinking", "queued": "working"; case "asking", "planned": "waiting"; case "failed": "error"; default: "idle" }
        let ceoBubble: String = switch active?.status {
            case "thinking": "검토 중"; case "queued": "대기열"; case "asking": "질문 있어요"; case "planned": "계획 승인 요청"
            case "failed": "실패: \(active?.note ?? "")"; case "approved": "계획 승인됨"; case "rejected": "계획 반려됨"
            default: "요청하려면 클릭" }
        let ceo = TeamView(id: "ceo", name: "사장", pack: "pokemon", state: offline ? "sleeping" : ceoState, bubble: offline ? "hq 꺼짐" : ceoBubble, lastRun: nil, nextRunAt: nil)
        // Only characters that are doing something or need the chairman are shown; the CEO is always there.
        let showIdle = UserDefaults.standard.bool(forKey: "showIdle")
        // Stay visible for 5 minutes after the last activity so a session doesn't flicker between turns.
        let now = Date()
        for t in s.teams where t.state != "idle" { lastActive[t.id] = now }
        let busy: (TeamView) -> Bool = { showIdle || $0.state != "idle" || now.timeIntervalSince(self.lastActive[$0.id] ?? .distantPast) < 300 }
        let all = [ceo] + s.teams.filter(busy)
        let ids = Set(all.map(\.id))
        for (id, c) in critters where !ids.contains(id) { c.remove(); critters[id] = nil }
        for (i, t) in all.enumerated() {
            if let c = critters[t.id] { c.team = t }
            else {
                let c = Critter(team: t, in: content, defaultX: 40 + (panel.frame.width - 120) * CGFloat(i) / CGFloat(max(all.count, 1)))
                c.view.onClick = { [weak self, weak c] in if let c { self?.showDetail(for: c) } }
                c.view.onDrag = { [weak self, weak c] dx, dy in if let self, let c { self.popover?.close(); c.move(dx: dx, dy: dy, bounds: self.panel.contentView!.bounds); c.layout() } }
                c.view.onDrop = { [weak c] in c?.savePosition() }
                c.bubble.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(clicked(_:))))
                critters[t.id] = c
            }
        }
        let waiting = s.approvals.count
        status.button?.title = waiting > 0 ? "🏢 \(waiting)" : (offline ? "🏢 ⏸" : "🏢")
        rebuildMenu()
    }

    @objc func clicked(_ g: NSClickGestureRecognizer) {
        guard let v = g.view, let c = critters.values.first(where: { $0.view === v || $0.bubble === v }) else { return }
        showDetail(for: c)
    }

    func showDetail(for c: Critter) {
        popover?.close()
        if c.id == "ceo" { showCeo(for: c); return }
        let t = c.team
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        let title = NSTextField(labelWithString: "\(t.name) — \(label(t.state))"); title.font = .boldSystemFont(ofSize: 13)
        stack.addArrangedSubview(title)
        stack.addArrangedSubview(wrap(t.bubble))
        if let r = t.lastRun, let sum = r.summary, !sum.isEmpty { stack.addArrangedSubview(wrap("최근 실행 (종료 코드 \(r.exitCode.map(String.init) ?? "-")):\n" + sum, mono: true)) }
        for a in (snapshot?.approvals ?? []) where a.teamId == t.id {
            let h = NSTextField(labelWithString: "승인 요청: \(a.title)"); h.font = .boldSystemFont(ofSize: 12)
            stack.addArrangedSubview(h)
            if !a.body.isEmpty { stack.addArrangedSubview(wrap(a.body)) }
            let row = NSStackView(); row.spacing = 6
            for opt in a.options {
                let b = NSButton(title: opt, target: self, action: #selector(decide(_:)))
                b.identifier = NSUserInterfaceItemIdentifier("\(a.id)\u{1F}\(opt)\u{1F}\(a.subjectHash)")
                b.isEnabled = !offline
                row.addArrangedSubview(b)
            }
            stack.addArrangedSubview(row)
        }
        if !offline {
            let run = NSButton(title: "지금 실행", target: self, action: #selector(runTeam(_:)))
            run.identifier = NSUserInterfaceItemIdentifier(t.id)
            stack.addArrangedSubview(run)
        }
        let vc = NSViewController(); vc.view = stack
        stack.frame.size = stack.fittingSize
        let p = NSPopover(); p.contentViewController = vc; p.behavior = .transient; p.delegate = self
        NSApp.activate()
        p.show(relativeTo: c.view.bounds, of: c.view, preferredEdge: .maxY)
        popover = p
    }

    var requestInput: NSTextView?
    var projectPicker: NSPopUpButton?
    var freeAnswers: [String: NSTextField] = [:]

    /// Chairman → CEO: new request box, open questions with option buttons, plan approval.
    func showCeo(for c: Critter) {
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        let title = NSTextField(labelWithString: "사장에게 지시"); title.font = .boldSystemFont(ofSize: 13)
        stack.addArrangedSubview(title)
        if offline { stack.addArrangedSubview(wrap("hq 데몬이 꺼져 있어요. 켜진 뒤에 요청할 수 있어요.")) }

        for r in (snapshot?.requests ?? []).prefix(3) {
            let head = NSTextField(labelWithString: "[\(statusLabel(r.status))] \(r.text)")
            head.font = .systemFont(ofSize: 12, weight: .semibold); head.lineBreakMode = .byTruncatingTail
            head.preferredMaxLayoutWidth = 380
            stack.addArrangedSubview(head)
            if let n = r.note, !n.isEmpty, r.status == "failed" { stack.addArrangedSubview(wrap(n)) }
            if r.status == "asking" {
                for q in r.questions where q.answer == nil {
                    stack.addArrangedSubview(wrap("Q. \(q.question)\n(\(q.reason))"))
                    let row = NSStackView(); row.spacing = 6
                    for o in q.options {
                        let b = NSButton(title: o == q.default ? "\(o) (추천)" : o, target: self, action: #selector(answerQ(_:)))
                        b.identifier = NSUserInterfaceItemIdentifier("\(r.id)\u{1F}\(q.id)\u{1F}\(o)"); b.isEnabled = !offline
                        row.addArrangedSubview(b)
                    }
                    stack.addArrangedSubview(row)
                    let free = NSTextField(string: ""); free.placeholderString = "직접 답하기 (엔터)"
                    free.frame.size.width = 360; free.identifier = NSUserInterfaceItemIdentifier("\(r.id)\u{1F}\(q.id)")
                    free.target = self; free.action = #selector(answerFree(_:))
                    stack.addArrangedSubview(free)
                }
            }
            if r.status == "planned", let plan = r.plan {
                stack.addArrangedSubview(wrap(plan.summary))
                stack.addArrangedSubview(wrap(plan.tasks.map { "• \($0.id) [\($0.grade)·\($0.model)] \($0.title)" }.joined(separator: "\n"), mono: true))
                if let a = snapshot?.approvals.first(where: { $0.id == "plan:" + r.id }) {
                    let row = NSStackView(); row.spacing = 6
                    for opt in a.options {
                        let b = NSButton(title: opt, target: self, action: #selector(decide(_:)))
                        b.identifier = NSUserInterfaceItemIdentifier("\(a.id)\u{1F}\(opt)\u{1F}\(a.subjectHash)"); b.isEnabled = !offline
                        row.addArrangedSubview(b)
                    }
                    stack.addArrangedSubview(row)
                }
            }
        }

        let sep = NSBox(); sep.boxType = .separator; sep.widthAnchor.constraint(equalToConstant: 380).isActive = true
        stack.addArrangedSubview(sep)
        let projects = snapshot?.projects ?? []
        let picker = NSPopUpButton(frame: .zero, pullsDown: false)
        for p in projects { picker.addItem(withTitle: p.name); picker.lastItem?.representedObject = p.id }
        projectPicker = picker
        let scroll = NSTextView.scrollableTextView()
        scroll.frame = NSRect(x: 0, y: 0, width: 380, height: 70)
        scroll.widthAnchor.constraint(equalToConstant: 380).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: 70).isActive = true
        let tv = scroll.documentView as! NSTextView
        tv.font = .systemFont(ofSize: 12); tv.isRichText = false
        requestInput = tv
        let send = NSButton(title: "사장에게 보내기", target: self, action: #selector(sendRequest))
        send.keyEquivalent = "\r"; send.keyEquivalentModifierMask = [.command]; send.isEnabled = !offline
        let row = NSStackView(); row.spacing = 8; row.addArrangedSubview(picker); row.addArrangedSubview(send)
        stack.addArrangedSubview(NSTextField(labelWithString: "새 요청 (⌘↩ 보내기)"))
        stack.addArrangedSubview(scroll)
        stack.addArrangedSubview(row)

        let vc = NSViewController(); vc.view = stack
        stack.frame.size = stack.fittingSize
        let p = NSPopover(); p.contentViewController = vc; p.behavior = .transient; p.delegate = self
        NSApp.activate()
        p.show(relativeTo: c.view.bounds, of: c.view, preferredEdge: .maxY)
        popover = p
        p.contentViewController?.view.window?.makeFirstResponder(tv)
    }

    func statusLabel(_ s: String) -> String {
        ["queued": "대기", "thinking": "검토 중", "asking": "질문", "planned": "계획 승인 대기", "approved": "승인됨", "rejected": "반려됨", "failed": "실패"][s] ?? s
    }

    @objc func sendRequest() {
        guard !offline, let text = requestInput?.string.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
        let project = projectPicker?.selectedItem?.representedObject as? String ?? ""
        post("api/requests", body: ["text": text, "project": project]); popover?.close()
    }

    @objc func answerQ(_ b: NSButton) {
        guard !offline, let raw = b.identifier?.rawValue else { return }
        let parts = raw.split(separator: "\u{1F}", maxSplits: 2).map(String.init)
        guard parts.count == 3 else { return }
        post("api/requests/\(parts[0])/answer", body: ["questionId": parts[1], "answer": parts[2]]); popover?.close()
    }

    @objc func answerFree(_ f: NSTextField) {
        let text = f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !offline, !text.isEmpty, let raw = f.identifier?.rawValue else { return }
        let parts = raw.split(separator: "\u{1F}", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return }
        post("api/requests/\(parts[0])/answer", body: ["questionId": parts[1], "answer": text]); popover?.close()
    }

    func wrap(_ s: String, mono: Bool = false) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: s)
        f.preferredMaxLayoutWidth = 340
        f.font = mono ? .monospacedSystemFont(ofSize: 11, weight: .regular) : .systemFont(ofSize: 12)
        f.textColor = .secondaryLabelColor
        return f
    }

    func label(_ state: String) -> String {
        ["working": "작업 중", "idle": "대기", "waiting": "승인 대기", "sleeping": "쉬는 중", "error": "오류"][state] ?? state
    }

    @objc func decide(_ b: NSButton) {
        guard let raw = b.identifier?.rawValue else { return }
        let parts = raw.split(separator: "\u{1F}", maxSplits: 2).map(String.init)
        guard parts.count == 3, !offline else { return }
        post("api/approvals/\(parts[0].addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? parts[0])", body: ["decision": parts[1], "subjectHash": parts[2]])
        popover?.close()
    }

    @objc func runTeam(_ b: NSButton) {
        guard let id = b.identifier?.rawValue else { return }
        post("api/teams/\(id)/run", body: [:]); popover?.close()
    }

    @objc func resetPositions() {
        let d = UserDefaults.standard
        for k in d.dictionaryRepresentation().keys where k.hasPrefix("pos.") { d.removeObject(forKey: k) }
        let w = panel.frame.width
        for (i, c) in critters.values.sorted(by: { $0.id < $1.id }).enumerated() { c.x = 40 + CGFloat(i) * 70; c.y = 4; if c.x > w - 60 { c.x = w - 60 }; c.layout() }
    }

    @objc func toggleIdle() {
        UserDefaults.standard.set(!UserDefaults.standard.bool(forKey: "showIdle"), forKey: "showIdle")
        if let s = snapshot { apply(s, offline: offline) }
    }

    @objc func runFromMenu(_ m: NSMenuItem) { if let id = m.representedObject as? String { post("api/teams/\(id)/run", body: [:]) } }

    func post(_ path: String, body: [String: String]) {
        var req = authed(URL(string: path, relativeTo: base)!)
        req.httpMethod = "POST"; req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        Task { @MainActor in _ = try? await URLSession.shared.data(for: req); refresh() }
    }

    func rebuildMenu() {
        let m = NSMenu()
        if offline { m.addItem(withTitle: "hq 데몬에 연결할 수 없음", action: nil, keyEquivalent: "") }
        for t in snapshot?.teams ?? [] where !offline {
            let item = NSMenuItem(title: "\(t.name): \(label(t.state)) — \(t.bubble)", action: #selector(runFromMenu(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = t.id; item.toolTip = "클릭하면 지금 실행"
            m.addItem(item)
        }
        m.addItem(.separator())
        let reset = NSMenuItem(title: "위치 초기화", action: #selector(resetPositions), keyEquivalent: "")
        reset.target = self; m.addItem(reset)
        let idle = NSMenuItem(title: "쉬는 캐릭터도 보기", action: #selector(toggleIdle), keyEquivalent: "")
        idle.target = self; idle.state = UserDefaults.standard.bool(forKey: "showIdle") ? .on : .off
        m.addItem(idle)
        m.addItem(withTitle: "펫 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = m
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let pet = MainActor.assumeIsolated { Pet() }
app.run()
