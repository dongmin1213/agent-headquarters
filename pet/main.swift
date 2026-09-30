// hq desk pet: the CEO and one small character per live worker, draggable anywhere. Reads the hq daemon (127.0.0.1).
// Click the CEO for decisions and new requests, a worker for its task. Menu bar: quota, teams, quit.
// Contract: docs/design/execution.md §14–§17, src/types.ts.
import AppKit
import UserNotifications

// MARK: - API models (mirror src/types.ts). Execution-phase fields are optional so an older daemon still works.
struct RunRecord: Decodable { let exitCode: Int?; let summary: String?; let endedAt: String? }
struct TeamView: Decodable { let id: String; let name: String; let pack: String; let state: String; let bubble: String; let lastRun: RunRecord?; let nextRunAt: String? }
struct Approval: Decodable { let id: String; let teamId: String; let title: String; let body: String; let options: [String]; let subjectHash: String; let expiresAt: String }
struct RequestQuestion: Decodable { let id: String; let question: String; let options: [String]; let `default`: String; let reason: String; let answer: String? }
struct PlanTaskView: Decodable { let id: String; let title: String; let project: String; let role: String; let grade: String; let model: String }
struct PlanView: Decodable { let summary: String; let assumptions: [String]; let tasks: [PlanTaskView] }
struct TaskQuestion: Decodable { var id: String? = nil; let question: String; var options: [String]? = nil; var `default`: String? = nil }
struct TaskView: Decodable {
    let id: String; let requestId: String; let title: String; let model: String; let status: String
    var key: String? = nil; var project: String? = nil; var attempts: Int? = nil; var currentAttemptId: String? = nil
    var lastActivity: String? = nil; var questions: [TaskQuestion]? = nil; var note: String? = nil
}
struct RequestView: Decodable {
    let id: String; let project: String; let text: String; let status: String; let note: String?
    let questions: [RequestQuestion]; let plan: PlanView?
    var tasks: [TaskView]? = nil; var updatedAt: String? = nil
}
struct ProjectRef: Decodable { let id: String; let name: String }
struct WorkerView: Decodable, Equatable {
    let attemptId: String; let taskId: String; let requestId: String; let title: String; let project: String
    let role: String; let model: String; let kind: String; let state: String; let bubble: String; let startedAt: String
}
struct Headline: Decodable { let text: String; let needsYou: Int }
struct QuotaWindow: Decodable { let name: String; var utilization: Double? = nil; var resetsAt: String? = nil; var status: String? = nil }
struct QuotaView: Decodable {
    var windows: [QuotaWindow]? = nil
    var fiveHour: Double? = nil; var sevenDay: Double? = nil; var fiveHourResetsAt: String? = nil; var sevenDayResetsAt: String? = nil
    var mode: String? = nil; var observedAt: String? = nil
    /// Every window to show: `windows` (v2), else the fixed 5h/7d pair (v1 daemon).
    var allWindows: [QuotaWindow] {
        if let w = windows { return w }
        var out: [QuotaWindow] = []
        if fiveHour != nil || fiveHourResetsAt != nil { out.append(QuotaWindow(name: "five_hour", utilization: fiveHour, resetsAt: fiveHourResetsAt)) }
        if sevenDay != nil || sevenDayResetsAt != nil { out.append(QuotaWindow(name: "seven_day", utilization: sevenDay, resetsAt: sevenDayResetsAt)) }
        return out
    }
}
/// Everything the chairman can act on, already ordered by the daemon (execution.md §17).
struct DecisionItem: Decodable {
    let kind: String; let id: String
    var revision: Int? = nil; var requestId: String? = nil; var taskId: String? = nil
    var title: String? = nil; var detail: String? = nil; var options: [String]? = nil; var subjectHash: String? = nil
    var key: String { "\(id)#\(revision ?? 0)" }
}
struct Snapshot: Decodable {
    let teams: [TeamView]; let approvals: [Approval]; let limit: Limit
    var requests: [RequestView]? = nil; var projects: [ProjectRef]? = nil
    var workers: [WorkerView]? = nil; var headline: Headline? = nil; var quota: QuotaView? = nil
    var decisions: [DecisionItem]? = nil
    struct Limit: Decodable { let blockedUntil: String? }
}

// MARK: - Environment
let env = ProcessInfo.processInfo.environment
let base = URL(string: env["HQ_URL"] ?? "http://127.0.0.1:7777")!
let tokenPath = env["HQ_TOKEN_FILE"] ?? (NSHomeDirectory() + "/.config/hq/token")
let packsDir = URL(fileURLWithPath: env["HQ_PACKS"] ?? (Bundle.main.resourcePath.map { $0 + "/packs" } ?? "packs"))
/// Separate defaults suite for tests so a second instance does not move the real pet's characters.
let defaults: UserDefaults = env["HQ_DEFAULTS_SUITE"].flatMap { UserDefaults(suiteName: $0) } ?? .standard
let debug = env["HQ_DEBUG"] != nil
func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func authed(_ url: URL, timeout: TimeInterval = 3) -> URLRequest {
    var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    let token = (try? String(contentsOfFile: tokenPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    return r
}
/// Path segment encoding: task ids contain "/" ("<requestId>/<taskKey>").
func seg(_ s: String) -> String {
    var allowed = CharacterSet.urlPathAllowed; allowed.remove("/")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}

// MARK: - Characters (one mapping table)
struct CharSpec: Sendable { let file: String; let initial: String; let rgb: (Double, Double, Double) }
let characters: [String: CharSpec] = [
    "ceo": CharSpec(file: "pikachu", initial: "C", rgb: (0.96, 0.78, 0.15)),
    "haiku": CharSpec(file: "squirtle", initial: "H", rgb: (0.25, 0.55, 0.95)),
    "sonnet": CharSpec(file: "bulbasaur", initial: "S", rgb: (0.25, 0.70, 0.45)),
    "opus": CharSpec(file: "charmander", initial: "O", rgb: (0.95, 0.45, 0.20)),
]
func charSpec(model: String) -> CharSpec {
    let m = model.lowercased()
    if m == "hq" { return CharSpec(file: "", initial: "hq", rgb: (0.45, 0.47, 0.55)) }   // hq's own acceptance checks
    for k in ["haiku", "sonnet", "opus"] where m.contains(k) { return characters[k]! }
    return CharSpec(file: "", initial: String(model.prefix(1)).uppercased(), rgb: (0.55, 0.55, 0.6))
}

@MainActor enum Sprites {
    /// Colored rounded square with an initial, used whenever a sprite file is missing (never an empty image).
    static func placeholder(_ initial: String, _ rgb: (Double, Double, Double)) -> NSImage {
        let size = NSSize(width: 40, height: 40)
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 80, pixelsHigh: 80, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor(calibratedRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 3, y: 3, width: 34, height: 34), xRadius: 9, yRadius: 9).fill()
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: initial.count > 1 ? 16 : 20, weight: .bold), .foregroundColor: NSColor.white]
        let t = NSAttributedString(string: initial.isEmpty ? "?" : initial, attributes: attrs)
        let ts = t.size()
        t.draw(at: NSPoint(x: (40 - ts.width) / 2, y: (40 - ts.height) / 2))
        NSGraphicsContext.restoreGraphicsState()
        let img = NSImage(size: size); img.addRepresentation(rep)
        return img
    }
    static func load(pack: String, file: String) -> NSImage? {
        guard !file.isEmpty else { return nil }
        let dir = packsDir.appendingPathComponent(pack).appendingPathComponent("pool")
        for ext in ["gif", "png"] { if let i = NSImage(contentsOf: dir.appendingPathComponent("\(file).\(ext)")) { return i } }
        return nil
    }
    static func character(_ spec: CharSpec) -> NSImage { load(pack: "pokemon", file: spec.file) ?? placeholder(spec.initial, spec.rgb) }
    /// Teams keep a stable pick from their pack.
    static func team(_ t: TeamView) -> NSImage {
        let dir = packsDir.appendingPathComponent(t.pack).appendingPathComponent("pool")
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".gif") || $0.hasSuffix(".png") }.sorted()
        var h: UInt32 = 2166136261; for b in t.id.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
        if !files.isEmpty, let i = NSImage(contentsOf: dir.appendingPathComponent(files[Int(h % UInt32(files.count))])) { return i }
        return placeholder(String(t.name.prefix(1)), (0.5, 0.5, 0.55))
    }
}

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

enum Mood: Equatable { case idle, busy, attention, sleeping, error }
/// Everything that decides how a character looks; views are touched only when this changes.
struct Look: Equatable {
    var bubble = ""
    var mood = Mood.idle
    var badge: String? = nil      // top-right (red count, or "zz")
    var tag: String? = nil        // top-left ("검토")
    var hop = false
    var bubbleMax: CGFloat = 200
}

@MainActor final class Critter {
    enum Kind { case ceo, team, worker }
    let id: String
    let kind: Kind
    let posKey: String
    let view = DragImageView()
    let bubble = NSTextField(labelWithString: "")
    let badge = NSTextField(labelWithString: "")
    let tag = NSTextField(labelWithString: "")
    var x: CGFloat
    var y: CGFloat
    var bubbleLift: CGFloat = 0
    var look = Look()
    var hovered = false { didSet { if hovered != oldValue { updateAnimates() } } }
    var worker: WorkerView?
    var team: TeamView?
    var slot = -1
    let size: CGFloat = 40

    init(id: String, kind: Kind, posKey: String, image: NSImage, in content: NSView, defaultPos: NSPoint) {
        self.id = id; self.kind = kind; self.posKey = posKey
        let saved = defaults.array(forKey: posKey) as? [Double]
        let b = content.bounds
        x = min(max(0, saved.map { CGFloat($0[0]) } ?? defaultPos.x), b.width - size)
        y = min(max(0, saved.map { CGFloat($0[1]) } ?? defaultPos.y), b.height - size - 24)
        view.image = image
        view.imageScaling = .scaleProportionallyUpOrDown
        view.animates = false
        view.wantsLayer = true
        view.layer?.magnificationFilter = .nearest
        for (f, pt) in [(bubble, 10.0), (badge, 9.0), (tag, 8.5)] {
            f.font = .systemFont(ofSize: pt, weight: f === bubble ? .medium : .bold)
            f.wantsLayer = true; f.layer?.cornerRadius = 6
            f.drawsBackground = true; f.alignment = .center
            f.maximumNumberOfLines = 1; f.lineBreakMode = .byTruncatingTail
        }
        badge.isHidden = true; tag.isHidden = true
        content.addSubview(view); content.addSubview(bubble); content.addSubview(badge); content.addSubview(tag)
    }

    func move(dx: CGFloat, dy: CGFloat, bounds: NSRect) {
        x = min(max(0, x + dx), bounds.width - size)
        y = min(max(0, y + dy), bounds.height - size - 24)
    }
    func savePosition() { defaults.set([Double(x), Double(y)], forKey: posKey) }

    func set(_ l: Look) {
        guard l != look else { return }
        let old = look; look = l
        if l.bubble != old.bubble { bubble.stringValue = l.bubble; view.toolTip = l.bubble }
        if l.mood != old.mood || l.bubble != old.bubble {
            let (bg, fg): (NSColor, NSColor) = switch l.mood {
                case .error: (.systemRed, .white)
                case .attention: (.systemYellow, .black)
                case .sleeping: (.systemGray, .white)
                default: (NSColor.windowBackgroundColor.withAlphaComponent(0.92), .labelColor)
            }
            bubble.backgroundColor = bg; bubble.textColor = fg
            view.alphaValue = l.mood == .sleeping ? 0.5 : 1
        }
        if l.badge != old.badge {
            badge.isHidden = l.badge == nil
            badge.stringValue = l.badge ?? ""
            let zz = l.badge == "zz"
            badge.backgroundColor = zz ? NSColor.systemGray.withAlphaComponent(0.85) : .systemRed
            badge.textColor = .white
        }
        if l.tag != old.tag {
            tag.isHidden = l.tag == nil; tag.stringValue = l.tag ?? ""
            tag.backgroundColor = .systemIndigo; tag.textColor = .white
        }
        if l.hop != old.hop { setHop(l.hop) }
        updateAnimates()
    }

    /// Only busy characters play their GIF: motion itself means "working", and still ones cost no CPU.
    func updateAnimates() {
        let a = look.mood == .busy || look.mood == .attention || (hovered && look.mood != .sleeping)
        if view.animates != a { view.animates = a }
    }

    /// Gentle hop done by Core Animation (render server), so it costs the app no timer.
    func setHop(_ on: Bool) {
        guard let layer = view.layer else { return }
        layer.removeAnimation(forKey: "hop")
        guard on else { return }
        let a = CABasicAnimation(keyPath: "transform.translation.y")
        a.fromValue = 0; a.toValue = 5; a.duration = 0.32
        a.autoreverses = true; a.repeatCount = .infinity
        a.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(a, forKey: "hop")
    }

    func bubbleWidth() -> CGFloat { min(bubble.fittingSize.width + 12, look.bubbleMax) }
    func baseBubbleFrame() -> NSRect {
        let bw = bubbleWidth()
        return NSRect(x: max(0, x + size / 2 - bw / 2), y: y + size + 4, width: bw, height: 16)
    }

    func layout() {
        let f = NSRect(x: x, y: y, width: size, height: size)
        if view.frame != f { view.frame = f; if look.hop { setHop(true) } }
        var bf = baseBubbleFrame(); bf.origin.y += bubbleLift
        if bubble.frame != bf { bubble.frame = bf }
        if !badge.isHidden {
            let w = max(16, badge.fittingSize.width + 8)
            let r = NSRect(x: x + size - w / 2 - 2, y: y + size - 10, width: w, height: 14)
            if badge.frame != r { badge.frame = r }
        }
        if !tag.isHidden {
            let w = tag.fittingSize.width + 8
            let r = NSRect(x: x - 4, y: y - 2, width: w, height: 13)
            if tag.frame != r { tag.frame = r }
        }
    }

    var hitRect: NSRect { view.frame.union(bubble.frame) }
    func remove() { view.removeFromSuperview(); bubble.removeFromSuperview(); badge.removeFromSuperview(); tag.removeFromSuperview() }
}

func firstLine(_ s: String?, max: Int = 90) -> String {
    let l = (s ?? "").split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
    return l.count > max ? String(l.prefix(max)) + "…" : l
}

/// Scroll container whose document starts at the top.
final class FlippedView: NSView { override var isFlipped: Bool { true } }

// MARK: - Overlay window + controller
@MainActor final class Pet: NSObject, NSPopoverDelegate {
    let panel: NSPanel
    var critters: [String: Critter] = [:]
    var lastActive: [String: Date] = [:]
    var slots: [String: Int] = [:]          // attemptId → slot index (positions are remembered per slot)
    var snapshot: Snapshot?
    var lastData: Data?
    var offline = false
    var sseUp = false
    var lastFetch = Date.distantPast
    var fetching = false
    var refetch = false
    let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var popover: NSPopover?
    var knownDecisions: Set<String>? = nil
    var notifyOK = false
    var openedForTest = false

    override init() {
        let f = NSScreen.main!.visibleFrame
        panel = NSPanel(contentRect: f, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.orderFrontRegardless()
        status.button?.title = "hq"
        rebuildMenu()

        // Click-through except over a character: driven by mouse events, not a frame timer.
        NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { _ in MainActor.assumeIsolated { self.trackMouse() } }
        NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .leftMouseUp]) { e in MainActor.assumeIsolated { self.trackMouse() }; return e }
        // Poll often only while the event stream is down; with SSE up, events trigger refreshes and polling is a slow safety net.
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in MainActor.assumeIsolated {
            if !self.sseUp || Date().timeIntervalSince(self.lastFetch) > 20 { self.refresh() }
        } }
        setupNotifications()
        refresh()
        listen()
    }

    func trackMouse() {
        let p = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        var over = DragImageView.dragging
        for c in critters.values {
            c.hovered = c.view.frame.insetBy(dx: -4, dy: -4).contains(p)
            if c.hitRect.insetBy(dx: -4, dy: -4).contains(p) { over = true }
        }
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
    }

    // MARK: data
    func refresh() {
        if fetching { refetch = true; return }
        fetching = true; lastFetch = Date()
        Task { @MainActor in
            defer { fetching = false; if refetch { refetch = false; refresh() } }
            do {
                let (data, resp) = try await URLSession.shared.data(for: authed(base.appendingPathComponent("api/state")))
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
                if data == lastData && !offline { return }   // unchanged: touch nothing
                let s = try JSONDecoder().decode(Snapshot.self, from: data)
                lastData = data
                apply(s, offline: false)
            } catch {
                if debug { log("refresh failed: \(error)") }
                if offline && snapshot != nil { return }
                lastData = nil
                apply(Snapshot(teams: [], approvals: [], limit: .init(blockedUntil: nil)), offline: true)
            }
        }
    }

    /// Server-sent events: any non-heartbeat event triggers a snapshot re-fetch (the snapshot is the source of truth).
    func listen() {
        Task { @MainActor in
            while true {
                do {
                    var req = authed(base.appendingPathComponent("api/events"), timeout: 35)
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, resp) = try await URLSession.shared.bytes(for: req)
                    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    sseUp = true
                    if debug { log("sse connected") }
                    refresh()
                    var event = ""
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") { event = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
                        else if line.hasPrefix("data:") { if event != "heartbeat" { refresh() }; event = "" }
                    }
                } catch { if debug { log("sse: \(error)") } }
                sseUp = false
                refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func apply(_ s: Snapshot, offline: Bool) {
        snapshot = s; self.offline = offline
        let content = panel.contentView!
        let reqs = s.requests ?? []
        let items = offline ? [] : (s.decisions ?? [])
        let needsYou = offline ? 0 : (s.decisions?.count ?? s.headline?.needsYou ?? 0)

        // CEO
        let active = reqs.first { ["thinking", "asking", "planned", "queued", "executing"].contains($0.status) } ?? reqs.first
        var ceoLook = Look(bubbleMax: 280)
        if offline { ceoLook.bubble = "hq 꺼짐"; ceoLook.mood = .sleeping }
        else {
            if let h = s.headline, !h.text.isEmpty { ceoLook.bubble = h.text }
            else {
                ceoLook.bubble = switch active?.status {
                    case "thinking": "검토 중"; case "queued": "대기열"; case "asking": "질문 있어요"; case "planned": "계획 승인 요청"
                    case "failed": "실패: \(active?.note ?? "")"; case "approved": "계획 승인됨"; case "rejected": "계획 반려됨"
                    default: "요청하려면 클릭" }
            }
            let working = ["thinking", "queued"].contains(active?.status ?? "")
            ceoLook.mood = needsYou > 0 ? .attention : (working ? .busy : (active?.status == "failed" && s.headline == nil ? .error : .idle))
            ceoLook.badge = needsYou > 0 ? "\(needsYou)" : nil
            ceoLook.hop = needsYou > 0
        }
        let ceo = critters["ceo"] ?? {
            let c = Critter(id: "ceo", kind: .ceo, posKey: "pos.ceo", image: Sprites.character(characters["ceo"]!), in: content, defaultPos: NSPoint(x: 40, y: 4))
            wire(c); critters["ceo"] = c; return c
        }()
        ceo.set(ceoLook)

        // Workers: one per live attempt, in a row next to the CEO. Slots are reused so remembered positions stick.
        let workers = offline ? [] : (s.workers ?? [])
        let live = Set(workers.map { "w:" + $0.attemptId })
        for (id, c) in critters where c.kind == .worker && !live.contains(id) {
            c.remove(); critters[id] = nil; slots[String(id.dropFirst(2))] = nil
        }
        for w in workers {
            let key = "w:" + w.attemptId
            let c: Critter
            if let e = critters[key] { c = e } else {
                let used = Set(slots.values)
                let slot = (0...).first { !used.contains($0) }!
                slots[w.attemptId] = slot
                let def = NSPoint(x: ceo.x + 110 * CGFloat(slot + 1), y: ceo.y)
                c = Critter(id: key, kind: .worker, posKey: "pos.worker.\(slot)", image: Sprites.character(charSpec(model: w.model)), in: content, defaultPos: def)
                c.slot = slot
                wire(c); critters[key] = c
            }
            c.worker = w
            var l = Look(bubble: w.bubble.isEmpty ? w.title : w.bubble, bubbleMax: 150)
            if w.state == "held" { l.mood = .sleeping; l.badge = "zz" } else { l.mood = .busy }
            if w.kind == "review" { l.tag = "검토" }
            c.set(l)
        }

        // Teams (scheduler): only busy ones, lingering 5 minutes so a session doesn't flicker between turns.
        let showIdle = defaults.bool(forKey: "showIdle")
        let now = Date()
        for t in s.teams where t.state != "idle" { lastActive[t.id] = now }
        let teams = s.teams.filter { showIdle || $0.state != "idle" || now.timeIntervalSince(lastActive[$0.id] ?? .distantPast) < 300 }
        let teamIds = Set(teams.map { "t:" + $0.id })
        for (id, c) in critters where c.kind == .team && !teamIds.contains(id) { c.remove(); critters[id] = nil }
        for (i, t) in teams.enumerated() {
            let key = "t:" + t.id
            let c = critters[key] ?? {
                let c = Critter(id: key, kind: .team, posKey: "pos." + t.id, image: Sprites.team(t), in: content,
                                defaultPos: NSPoint(x: 40 + (panel.frame.width - 120) * CGFloat(i + 1) / CGFloat(teams.count + 1), y: 4))
                wire(c); critters[key] = c; return c
            }()
            c.team = t
            let icon: String = ["waiting": "✋ ", "sleeping": "💤 ", "error": "⚠️ "][t.state] ?? ""
            let mood: Mood = ["working": .busy, "waiting": .attention, "sleeping": .sleeping, "error": .error][t.state] ?? .idle
            c.set(Look(bubble: "\(icon)\(t.name) · \(t.bubble)", mood: mood, hop: t.state == "waiting"))
        }

        layoutAll()
        trackMouse()
        updateStatus(s, needsYou: needsYou)
        notifyNew(items)
        // Test hook: HQ_OPEN=ceo|worker opens that popover once after the first snapshot (screenshots without clicking).
        if let which = env["HQ_OPEN"], !openedForTest {
            openedForTest = true
            let target = which == "ceo" ? ceo : critters.values.first { $0.kind == .worker && $0.look.mood == .busy }
            if let target { DispatchQueue.main.async {
                self.showDetail(for: target)
                // HQ_PRESS=<kind>: press that decision's first option (exercises the POST / inline-error path).
                if let kind = env["HQ_PRESS"], let i = self.shownDecisions.firstIndex(where: { $0.kind == kind }) {
                    let b = NSButton(); b.identifier = NSUserInterfaceItemIdentifier("\(i)\u{1F}0"); self.decisionButton(b)
                }
                // HQ_SCROLL=<points>: scroll a long popover down (screenshots of the lower part).
                if let y = env["HQ_SCROLL"].flatMap(Double.init), let sv = self.popoverDoc?.enclosingScrollView {
                    sv.contentView.scroll(to: NSPoint(x: 0, y: y)); sv.reflectScrolledClipView(sv.contentView)
                }
            } }
        }
        if debug { log("apply workers=\(workers.count) decisions=\(items.count) offline=\(offline) critters=\(critters.count)") }
    }

    func wire(_ c: Critter) {
        c.view.onClick = { [weak self, weak c] in if let c { self?.showDetail(for: c) } }
        c.view.onDrag = { [weak self, weak c] dx, dy in
            guard let self, let c else { return }
            self.popover?.close(); c.move(dx: dx, dy: dy, bounds: self.panel.contentView!.bounds); self.layoutAll()
        }
        c.view.onDrop = { [weak c] in c?.savePosition() }
        c.bubble.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(clicked(_:))))
    }

    /// Places everything; a bubble that would overlap an earlier one is lifted a row.
    func layoutAll() {
        var placed: [NSRect] = []
        for c in critters.values.sorted(by: { ($0.kind == .ceo ? 0 : 1, $0.x) < ($1.kind == .ceo ? 0 : 1, $1.x) }) {
            var r = c.baseBubbleFrame(); var lift: CGFloat = 0
            while placed.contains(where: { $0.insetBy(dx: -2, dy: 0).intersects(r) }) && lift < 100 { r.origin.y += 19; lift += 19 }
            placed.append(r)
            c.bubbleLift = lift
            c.layout()
        }
    }

    // MARK: menu bar
    func pct(_ v: Double?) -> String? { v.map { "\(Int(($0 <= 1 ? $0 * 100 : $0).rounded()))%" } }

    func updateStatus(_ s: Snapshot, needsYou: Int) {
        var t = "hq"
        if offline { t = "hq 꺼짐" }
        else {
            if let p = pct(s.quota?.allWindows.compactMap(\.utilization).max()) { t += " \(p)" }
            if needsYou > 0 { t += " · \(needsYou)" }
        }
        if status.button?.title != t { status.button?.title = t }
        rebuildMenu()
    }

    func timeText(_ iso: String?) -> String {
        guard let iso else { return "-" }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        let out = DateFormatter(); out.locale = Locale(identifier: "ko_KR")
        out.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm" : "M/d HH:mm"
        return out.string(from: d)
    }

    func rebuildMenu() {
        let m = NSMenu()
        if offline { m.addItem(withTitle: "hq 데몬에 연결할 수 없음", action: nil, keyEquivalent: "") }
        if !offline, let h = snapshot?.headline, !h.text.isEmpty { m.addItem(withTitle: h.text, action: nil, keyEquivalent: "") }
        if !offline, let q = snapshot?.quota {
            for w in q.allWindows {
                let name = ["five_hour": "5시간", "seven_day": "7일", "seven_day_opus": "7일 (Opus)", "seven_day_sonnet": "7일 (Sonnet)"][w.name] ?? w.name
                m.addItem(withTitle: "\(name) 사용: \(pct(w.utilization) ?? "-") · 리셋 \(timeText(w.resetsAt))", action: nil, keyEquivalent: "")
            }
            let mode = ["normal": "보통", "save": "절약 (동시 1)", "hold": "보류 (쉬는 중)", "unobserved": "관측 전 (하나씩 실행)"][q.mode ?? ""] ?? (q.mode ?? "-")
            m.addItem(withTitle: "모드: \(mode)", action: nil, keyEquivalent: "")
        }
        if !offline {
            m.addItem(.separator())
            for t in snapshot?.teams ?? [] {
                let item = NSMenuItem(title: "\(t.name): \(label(t.state)) — \(t.bubble)", action: #selector(runFromMenu(_:)), keyEquivalent: "")
                item.target = self; item.representedObject = t.id; item.toolTip = "클릭하면 지금 실행"
                m.addItem(item)
            }
            let web = NSMenuItem(title: "자세히 보기 (웹 화면)", action: #selector(openWeb), keyEquivalent: "")
            web.target = self; m.addItem(web)
        }
        m.addItem(.separator())
        let reset = NSMenuItem(title: "위치 초기화", action: #selector(resetPositions), keyEquivalent: "")
        reset.target = self; m.addItem(reset)
        let idle = NSMenuItem(title: "쉬는 캐릭터도 보기", action: #selector(toggleIdle), keyEquivalent: "")
        idle.target = self; idle.state = defaults.bool(forKey: "showIdle") ? .on : .off
        m.addItem(idle)
        m.addItem(withTitle: "펫 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = m
        if debug { log("menu: " + m.items.map(\.title).filter { !$0.isEmpty }.joined(separator: " | ")) }
    }

    // MARK: notifications
    func setupNotifications() {
        guard env["HQ_NO_NOTIFY"] == nil, Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Task { @MainActor in self.notifyOK = granted }
        }
    }

    /// One notification per decision item the first time it appears (items present at launch are not announced).
    /// Dedupe key is id + revision (§17): a revised brief is a new decision.
    func notifyNew(_ items: [DecisionItem]) {
        guard !offline else { return }
        let keys = Set(items.map(\.key))
        defer { knownDecisions = (knownDecisions ?? []).union(keys) }
        guard let known = knownDecisions, notifyOK else { return }
        for d in items where !known.contains(d.key) {
            let c = UNMutableNotificationContent()
            c.title = "회장님 결정 필요"; c.body = d.title ?? d.kind; c.subtitle = firstLine(d.detail)
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: d.key, content: c, trigger: nil)) { _ in }
        }
    }

    // MARK: popovers
    @objc func clicked(_ g: NSClickGestureRecognizer) {
        guard let v = g.view, let c = critters.values.first(where: { $0.view === v || $0.bubble === v }) else { return }
        showDetail(for: c)
    }

    func showDetail(for c: Critter) {
        popover?.close()
        switch c.kind {
        case .ceo: showCeo(for: c)
        case .worker: showWorker(for: c)
        case .team: showTeam(for: c)
        }
    }

    func vstack() -> NSStackView {
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        return stack
    }

    func present(_ stack: NSStackView, at c: Critter, maxHeight: CGFloat = 560, focus: NSView? = nil) {
        let fit = stack.fittingSize
        let vc = NSViewController()
        popoverStack = stack; popoverDoc = nil
        if fit.height > maxHeight {
            let doc = FlippedView(frame: NSRect(origin: .zero, size: fit))
            popoverDoc = doc
            stack.frame = doc.bounds; stack.autoresizingMask = [.width]
            doc.addSubview(stack)
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: fit.width + 16, height: maxHeight))
            scroll.hasVerticalScroller = true; scroll.drawsBackground = false; scroll.documentView = doc
            vc.view = scroll
        } else {
            stack.frame.size = fit; vc.view = stack
        }
        let p = NSPopover(); p.contentViewController = vc; p.behavior = .transient; p.delegate = self
        NSApp.activate()
        p.show(relativeTo: c.view.bounds, of: c.view, preferredEdge: .maxY)
        popover = p
        if let focus { vc.view.window?.makeFirstResponder(focus) }
    }

    var popoverStack: NSStackView?
    var popoverDoc: FlippedView?
    /// Re-fits the open popover after content changed (inline error, reason field shown).
    func relayoutPopover() {
        guard let stack = popoverStack, let p = popover else { return }
        let fit = stack.fittingSize
        if let doc = popoverDoc { doc.setFrameSize(fit); stack.frame = doc.bounds }
        else { stack.setFrameSize(fit); p.contentSize = fit }
    }

    func heading(_ s: String, size: CGFloat = 13) -> NSTextField {
        let t = NSTextField(labelWithString: s); t.font = .boldSystemFont(ofSize: size)
        t.lineBreakMode = .byTruncatingTail; t.preferredMaxLayoutWidth = 380
        return t
    }

    func button(_ title: String, _ action: Selector, _ id: String) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.identifier = NSUserInterfaceItemIdentifier(id); b.isEnabled = !offline
        return b
    }

    func row(_ views: [NSView]) -> NSStackView { let r = NSStackView(views: views); r.spacing = 6; return r }

    func showTeam(for c: Critter) {
        guard let t = c.team else { return }
        let stack = vstack()
        stack.addArrangedSubview(heading("\(t.name) — \(label(t.state))"))
        stack.addArrangedSubview(wrap(t.bubble))
        if let r = t.lastRun, let sum = r.summary, !sum.isEmpty { stack.addArrangedSubview(wrap("최근 실행 (종료 코드 \(r.exitCode.map(String.init) ?? "-")):\n" + sum, mono: true)) }
        for a in (snapshot?.approvals ?? []) where a.teamId == t.id {
            stack.addArrangedSubview(heading("승인 요청: \(a.title)", size: 12))
            if !a.body.isEmpty { stack.addArrangedSubview(wrap(a.body)) }
            stack.addArrangedSubview(row(a.options.map { button($0, #selector(decide(_:)), "\(a.id)\u{1F}\($0)\u{1F}\(a.subjectHash)") }))
        }
        if !offline { stack.addArrangedSubview(button("지금 실행", #selector(runTeam(_:)), t.id)) }
        present(stack, at: c)
    }

    func showWorker(for c: Critter) {
        guard let w = c.worker else { return }
        let task = (snapshot?.requests ?? []).flatMap { $0.tasks ?? [] }.first { $0.id == w.taskId }
        let stack = vstack()
        stack.addArrangedSubview(heading(w.title))
        let kind = ["work": "구현", "review": "검토", "verify": "검증"][w.kind] ?? w.kind
        let state = ["running": "작업 중", "verifying": "검증 중", "reviewing": "검토 중", "held": "한도 보류 (쉬는 중)"][w.state] ?? w.state
        stack.addArrangedSubview(wrap("모델 \(w.model) · \(kind) · \(state)\n프로젝트 \(w.project) · 시도 \(task?.attempts.map(String.init) ?? "-")회 · 시작 \(timeText(w.startedAt))"))
        let activity = w.bubble.isEmpty ? (task?.lastActivity ?? "") : w.bubble
        if !activity.isEmpty { stack.addArrangedSubview(wrap("최근 활동: \(activity)", mono: true)) }
        stack.addArrangedSubview(button("자세히 보기", #selector(openWeb), ""))
        present(stack, at: c)
    }

    var requestInput: NSTextView?
    var projectPicker: NSPopUpButton?
    var rejectFields: [Int: NSTextField] = [:]
    var shownDecisions: [DecisionItem] = []
    var decisionErrors: [Int: NSTextField] = [:]

    /// Chairman ↔ CEO: headline, every decision item, and the new-request box.
    func showCeo(for c: Critter) {
        let stack = vstack()
        rejectFields = [:]
        let top = row([heading("사장에게 지시"), button("자세히 보기", #selector(openWeb), "")])
        stack.addArrangedSubview(top)
        if offline { stack.addArrangedSubview(wrap("hq 데몬이 꺼져 있어요. 켜진 뒤에 요청할 수 있어요.")) }
        else if let h = snapshot?.headline, !h.text.isEmpty { stack.addArrangedSubview(wrap(h.text, color: .labelColor)) }

        let items = offline ? [] : (snapshot?.decisions ?? [])
        shownDecisions = items; decisionErrors = [:]
        if !items.isEmpty {
            stack.addArrangedSubview(separator())
            stack.addArrangedSubview(heading("회장님 결정 \(items.count)건", size: 12))
        }
        // Rendered in the daemon's order; each kind posts to its own endpoint (§15).
        for (i, d) in items.enumerated() {
            let t = heading("• " + (d.title ?? d.kind), size: 12); t.font = .systemFont(ofSize: 12, weight: .semibold)
            stack.addArrangedSubview(t)
            if let detail = d.detail, !detail.isEmpty { stack.addArrangedSubview(wrap(detail)) }
            let opts = d.options ?? []
            var buttons: [NSView] = []
            for (j, o) in opts.enumerated() {
                if d.kind == "accept" && o == "반려" { buttons.append(button("반려…", #selector(rejectOpen(_:)), "\(i)")); continue }
                let title = d.kind == "blocked" ? (["retry": "한 번 더", "skip": "이 작업 건너뛰기", "stop": "요청 중단"][o] ?? o) : o
                let b = button(title, #selector(decisionButton(_:)), "\(i)\u{1F}\(j)")
                if d.kind == "blocked" && blockedDecision(o, at: j) == nil { b.isEnabled = false; b.toolTip = "알 수 없는 선택지" }
                buttons.append(b)
            }
            if ["accept", "merge", "integration"].contains(d.kind) { buttons.append(button("자세히 보기", #selector(openWeb), "")) }
            if !buttons.isEmpty { stack.addArrangedSubview(row(buttons)) }
            if d.kind == "ceo_question" || d.kind == "worker_question" {
                stack.addArrangedSubview(freeField("직접 답하기 (엔터)", #selector(decisionFree(_:)), "\(i)"))
            }
            if d.kind == "accept" {
                let reason = freeField("반려 사유 (엔터로 반려)", #selector(rejectSubmit(_:)), "\(i)")
                reason.isHidden = true; rejectFields[i] = reason
                stack.addArrangedSubview(reason)
            }
            let err = wrap("", color: .systemRed); err.isHidden = true; decisionErrors[i] = err
            stack.addArrangedSubview(err)
        }

        // Recent results: finished or stopped requests keep their outcome here (§19).
        let done: Set<String> = ["merged", "accepted", "failed", "cancelled", "blocked"]
        let recent = (snapshot?.requests ?? []).filter { done.contains($0.status) }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }.prefix(3)
        if !offline && !recent.isEmpty {
            stack.addArrangedSubview(separator())
            stack.addArrangedSubview(heading("최근 결과", size: 12))
            for r in recent {
                let note = r.note.map { firstLine($0) }.flatMap { $0.isEmpty ? nil : " — \($0)" } ?? ""
                let h = NSTextField(labelWithString: "[\(statusLabel(r.status))] \(firstLine(r.text, max: 50))\(note)")
                h.font = .systemFont(ofSize: 11)
                h.textColor = ["failed", "blocked"].contains(r.status) ? .systemRed : .secondaryLabelColor
                h.lineBreakMode = .byTruncatingTail
                h.widthAnchor.constraint(lessThanOrEqualToConstant: 380).isActive = true
                stack.addArrangedSubview(h)
            }
        }

        stack.addArrangedSubview(separator())
        let picker = NSPopUpButton(frame: .zero, pullsDown: false)
        for p in snapshot?.projects ?? [] { picker.addItem(withTitle: p.name); picker.lastItem?.representedObject = p.id }
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
        stack.addArrangedSubview(NSTextField(labelWithString: "새 요청 (⌘↩ 보내기)"))
        stack.addArrangedSubview(scroll)
        stack.addArrangedSubview(row([picker, send]))
        present(stack, at: c, focus: items.isEmpty ? tv : nil)
    }

    func separator() -> NSBox {
        let sep = NSBox(); sep.boxType = .separator; sep.widthAnchor.constraint(equalToConstant: 380).isActive = true
        return sep
    }

    func freeField(_ placeholder: String, _ action: Selector, _ id: String) -> NSTextField {
        let f = NSTextField(string: ""); f.placeholderString = placeholder
        f.widthAnchor.constraint(equalToConstant: 360).isActive = true
        f.identifier = NSUserInterfaceItemIdentifier(id); f.target = self; f.action = action; f.isEnabled = !offline
        return f
    }

    func statusLabel(_ s: String) -> String {
        ["queued": "대기", "thinking": "검토 중", "asking": "질문", "planned": "계획 승인 대기", "approved": "승인됨", "rejected": "반려됨",
         "failed": "실패", "executing": "실행 중", "awaiting_acceptance": "수락 대기", "accepted": "수락됨", "merging": "병합 중",
         "merged": "병합됨", "blocked": "막힘", "cancelled": "중단됨"][s] ?? s
    }

    func wrap(_ s: String, mono: Bool = false, color: NSColor = .secondaryLabelColor) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: s)
        f.preferredMaxLayoutWidth = 370
        f.font = mono ? .monospacedSystemFont(ofSize: 11, weight: .regular) : .systemFont(ofSize: 12)
        f.textColor = color
        return f
    }

    func label(_ state: String) -> String {
        ["working": "작업 중", "idle": "대기", "waiting": "승인 대기", "sleeping": "쉬는 중", "error": "오류"][state] ?? state
    }

    // MARK: actions
    func parts(_ v: NSView, _ n: Int) -> [String]? {
        guard !offline, let raw = v.identifier?.rawValue else { return nil }
        let p = raw.split(separator: "\u{1F}", maxSplits: n - 1, omittingEmptySubsequences: false).map(String.init)
        return p.count == n ? p : nil
    }

    @objc func sendRequest() {
        guard !offline, let text = requestInput?.string.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
        let project = projectPicker?.selectedItem?.representedObject as? String ?? ""
        post("api/requests", body: ["text": text, "project": project]); popover?.close()
    }
    /// Blocked-card option → decision value. Accepts the raw values or the Korean labels from the design doc.
    func blockedDecision(_ label: String, at i: Int) -> String? {
        let l = label.lowercased()
        if ["retry", "skip", "stop"].contains(l) { return l }
        if l.contains("한 번 더") || l.contains("다시") || l.contains("재시도") { return "retry" }
        if l.contains("건너") || l.contains("취소하고 계속") { return "skip" }
        if l.contains("중단") { return "stop" }
        return nil
    }

    func decisionAt(_ v: NSView) -> (Int, DecisionItem, String?)? {
        guard !offline, let raw = v.identifier?.rawValue else { return nil }
        let p = raw.split(separator: "\u{1F}", maxSplits: 1).map(String.init)
        guard let i = Int(p[0]), i < shownDecisions.count else { return nil }
        let d = shownDecisions[i]
        guard p.count == 2 else { return (i, d, nil) }
        guard let j = Int(p[1]), let opts = d.options, j < opts.count else { return nil }
        return (i, d, opts[j])
    }

    @objc func decisionButton(_ b: NSButton) {
        guard let (i, d, o) = decisionAt(b), let o else { return }
        if d.kind == "blocked" {
            guard let decision = blockedDecision(o, at: 0) else { return }
            post("api/tasks/\(seg(d.taskId ?? d.id))/decide", body: ["decision": decision, "revision": d.revision ?? 0], decision: i)
        } else { answer(d, o, index: i) }
    }
    @objc func decisionFree(_ f: NSTextField) {
        let text = f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let (i, d, _) = decisionAt(f) else { return }
        answer(d, text, index: i)
    }
    func answer(_ d: DecisionItem, _ a: String, index i: Int) {
        switch d.kind {
        case "ceo_question":
            post("api/requests/\(seg(d.requestId ?? ""))/answer", body: ["questionId": d.id, "answer": a], decision: i)
        case "worker_question":
            post("api/tasks/\(seg(d.taskId ?? ""))/answer", body: ["questionId": d.id, "answer": a, "revision": d.revision ?? 0], decision: i)
        default:   // plan, accept, merge, revise, integration: approval-backed
            post("api/approvals/\(seg(d.id))", body: ["decision": a, "subjectHash": d.subjectHash ?? ""], decision: i)
        }
    }
    @objc func rejectOpen(_ b: NSButton) {
        guard let (i, _, _) = decisionAt(b), let f = rejectFields[i] else { return }
        f.isHidden = false; relayoutPopover()
        f.window?.makeFirstResponder(f)
    }
    @objc func rejectSubmit(_ f: NSTextField) {
        let reason = f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty, let (i, d, _) = decisionAt(f) else { return }
        post("api/requests/\(seg(d.requestId ?? ""))/reject", body: ["reason": reason], decision: i)
    }
    @objc func decide(_ b: NSButton) {   // team approvals (team popover)
        guard let p = parts(b, 3) else { return }
        post("api/approvals/\(seg(p[0]))", body: ["decision": p[1], "subjectHash": p[2]]); popover?.close()
    }
    @objc func runTeam(_ b: NSButton) {
        guard let id = b.identifier?.rawValue else { return }
        post("api/teams/\(seg(id))/run", body: [:]); popover?.close()
    }
    @objc func runFromMenu(_ m: NSMenuItem) { if let id = m.representedObject as? String { post("api/teams/\(seg(id))/run", body: [:]) } }

    /// "자세히 보기": one-time login code from the daemon, opened in the browser (§15).
    @objc func openWeb() {
        guard !offline else { return }
        popover?.close()
        var req = authed(URL(string: "api/ui-code", relativeTo: base)!)
        req.httpMethod = "POST"; req.httpBody = Data("{}".utf8); req.setValue("application/json", forHTTPHeaderField: "content-type")
        Task { @MainActor in
            guard let (data, _) = try? await URLSession.shared.data(for: req),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let s = obj["url"] as? String, let url = URL(string: s, relativeTo: base) else { log("ui-code failed"); return }
            NSWorkspace.shared.open(url.absoluteURL)
        }
    }

    @objc func resetPositions() {
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix("pos.") { defaults.removeObject(forKey: k) }
        let w = panel.frame.width
        let ordered = critters.values.sorted { ($0.kind == .ceo ? -1 : $0.slot, $0.id) < ($1.kind == .ceo ? -1 : $1.slot, $1.id) }
        for (i, c) in ordered.enumerated() { c.x = min(40 + CGFloat(i) * 110, w - 60); c.y = 4 }
        layoutAll()
    }

    @objc func toggleIdle() {
        defaults.set(!defaults.bool(forKey: "showIdle"), forKey: "showIdle")
        if let s = snapshot { apply(s, offline: offline) }
    }

    /// POST; for a decision the popover stays open until the daemon answers. A refusal (409: stale revision,
    /// wrong state) shows the daemon's Korean reason under that item and the state is re-fetched.
    func post(_ path: String, body: [String: Any], decision: Int? = nil) {
        var req = authed(URL(string: path, relativeTo: base)!)
        req.httpMethod = "POST"; req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        Task { @MainActor in
            var failure: String? = nil
            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if code >= 400 {
                    let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    let text = (obj?["error"] ?? obj?["reason"] ?? obj?["message"]) as? String
                        ?? String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    failure = (text?.isEmpty == false ? text! : "요청이 거절됐어요") + (code == 409 ? "" : " (HTTP \(code))")
                    log("POST \(path) → \(code): \(failure!)")
                }
            } catch { failure = "hq에 연결하지 못했어요" }
            if let i = decision {
                if let failure, let label = decisionErrors[i] {
                    label.stringValue = failure; label.isHidden = false; relayoutPopover()
                } else if failure == nil { popover?.close() }
            }
            refresh()
        }
    }
}

// MARK: - Start
// Single instance: a second copy would draw a second set of characters over the first.
if env["HQ_ALLOW_SECOND_INSTANCE"] != "1", let bid = Bundle.main.bundleIdentifier {
    let me = ProcessInfo.processInfo.processIdentifier
    if NSRunningApplication.runningApplications(withBundleIdentifier: bid).contains(where: { $0.processIdentifier != me }) {
        log("hqpet already running; exiting (set HQ_ALLOW_SECOND_INSTANCE=1 to override)")
        exit(0)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let pet = MainActor.assumeIsolated { Pet() }
app.run()
