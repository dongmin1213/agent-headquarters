// hq desk pet: the CEO and one small character per live worker, draggable anywhere. Reads the hq daemon (127.0.0.1).
// Click the CEO for decisions and new requests, a worker for its task. Menu bar: quota, teams, quit.
// Contract: docs/design/execution.md §14–§17, src/types.ts.
import AppKit
import UserNotifications

// MARK: - API models (mirror src/types.ts). Execution-phase fields are optional so an older daemon still works.
struct RunRecord: Decodable { let exitCode: Int?; let summary: String?; let endedAt: String? }
struct TeamView: Decodable { let enabled: Bool?; let kind: String?; let project: String?; let id: String; let name: String; let pack: String; let state: String; let bubble: String; let lastRun: RunRecord?; let nextRunAt: String? }
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
    var department: String? = nil
    var grade: String? = nil
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
    var situation: String? = nil; var cause: String? = nil; var causeConfirmed: Bool? = nil
    var recommendation: Recommendation? = nil; var optionHelp: [String: String]? = nil; var detailPath: String? = nil
    /// Irreversible options → inline confirm question; sent only after a second click.
    var confirm: [String: String]? = nil
    struct Recommendation: Decodable { let option: String; let reason: String }
    var key: String { "\(id)#\(revision ?? 0)" }
}
struct Snapshot: Decodable {
    let teams: [TeamView]; let approvals: [Approval]; let limit: Limit
    var requests: [RequestView]? = nil; var projects: [ProjectRef]? = nil
    var workers: [WorkerView]? = nil; var headline: Headline? = nil; var quota: QuotaView? = nil
    var decisions: [DecisionItem]? = nil
    var models: [String: String]? = nil
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

let petConfigPath = env["HQ_PET_CONFIG"] ?? (NSHomeDirectory() + "/.config/hq/pet.json")
/// Speech bubble font size from pet.json: 10 when the file or key is missing, or the value is unusable (8...24 only).
func bubbleFontSize(from data: Data?) -> CGFloat {
    let fallback: CGFloat = 10
    guard let data else { return fallback }
    guard let obj = try? JSONSerialization.jsonObject(with: data), let dict = obj as? [String: Any] else {
        log("pet.json: 올바른 JSON 객체가 아니어서 기본 글자 크기 10을 씁니다")
        return fallback
    }
    guard let raw = dict["bubbleFontSize"] else { return fallback }
    if let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, (8.0...24.0).contains(n.doubleValue) {
        return CGFloat(n.doubleValue)
    }
    log("pet.json: bubbleFontSize는 8~24 사이의 숫자여야 해서 기본 글자 크기 10을 씁니다")
    return fallback
}
let bubbleFont: CGFloat = bubbleFontSize(from: try? Data(contentsOf: URL(fileURLWithPath: petConfigPath)))

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
let workerSpritePool = ["psyduck", "mewtwo", "bulbasaur", "jigglypuff", "lapras", "gengar", "snorlax", "meowth", "squirtle", "charmander"]
func preferredSprite(_ w: WorkerView) -> String {
    if w.kind == "verify" { return "squirtle" }
    if w.kind == "review" { return "meowth" }
    return ["research": "psyduck", "direction": "mewtwo", "gameplay": "bulbasaur", "art": "jigglypuff", "level": "lapras", "qa": "gengar", "delivery": "snorlax"][w.department ?? ""] ?? (w.role == "collect" ? "psyduck" : "bulbasaur")
}
func professionName(_ w: WorkerView) -> String {
    if w.kind == "verify" { return "자동검증" }
    let role = ["research": "리서치", "direction": "게임기획", "gameplay": "게임개발", "art": "아트·사운드", "level": "레벨디자인", "qa": "QA", "delivery": "최종통합"][w.department ?? ""] ?? (w.role == "collect" ? "리서치" : "개발")
    return w.kind == "review" ? "\(role) 검토" : role
}
func workerBubble(_ w: WorkerView) -> String {
    let title = firstLine(w.title, max: 32)
    switch w.state {
    case "held": return "\(professionName(w)) · 재개 대기"
    case "blocked": return "\(professionName(w)) · 문제 해결 대기"
    case "reviewing": return "\(title) · 검토 중"
    case "verifying": return "\(title) · 검사 중"
    default: return "\(title) 중"
    }
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
        if t.kind == "game" { return character(CharSpec(file: "eevee", initial: "팀", rgb: (0.65, 0.45, 0.25))) }
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

enum Mood: Equatable { case idle, busy, attention, sleeping, blocked, error }
/// Everything that decides how a character looks; views are touched only when this changes.
struct Look: Equatable {
    var bubble = ""               // empty = no bubble
    var mood = Mood.idle
    var badge: String? = nil      // top-right (red count, or "zz")
    var hop = false
    var plate = ""                // name plate under the character
}

/// "<prefix> · <title> · <suffix>" cut to `limit` characters by shortening the title first.
func plateText(_ prefix: String, _ title: String, _ suffix: String, limit: Int = 34) -> String {
    let room = limit - prefix.count - suffix.count - 6
    let t = title.count <= room ? title : String(title.prefix(max(room - 1, 3))) + "…"
    let s = "\(prefix) · \(t) · \(suffix)"
    return s.count <= limit ? s : String(s.prefix(limit - 1)) + "…"
}

@MainActor final class Critter {
    enum Kind { case ceo, team, worker }
    let id: String
    let kind: Kind
    let view = DragImageView()
    let bubble = NSTextField(labelWithString: "")
    let badge = NSTextField(labelWithString: "")
    let plate = NSTextField(labelWithString: "")
    var x: CGFloat = 0
    var y: CGFloat = 0
    /// Row slot key; a dragged character remembers its position under this key.
    private(set) var posKey = ""
    private(set) var saved: NSPoint?
    var dragging = false
    var bubbleLift: CGFloat = 0
    var slotWidth: CGFloat = 120
    var look = Look()
    var hovered = false { didSet { if hovered != oldValue { updateAnimates() } } }
    var worker: WorkerView?
    var spriteName = ""
    var team: TeamView?
    let size: CGFloat = 40

    init(id: String, kind: Kind, image: NSImage, in content: NSView) {
        self.id = id; self.kind = kind
        view.image = image
        view.imageScaling = .scaleProportionallyUpOrDown
        view.animates = false
        view.wantsLayer = true
        view.layer?.magnificationFilter = .nearest
        for (f, pt) in [(bubble, bubbleFont), (badge, 9.0), (plate, 10.0)] {
            f.font = .systemFont(ofSize: pt, weight: f === badge ? .bold : .medium)
            f.wantsLayer = true; f.layer?.cornerRadius = f === plate ? 5 : 6
            f.drawsBackground = true; f.alignment = .center
            f.maximumNumberOfLines = 1; f.lineBreakMode = .byTruncatingTail
        }
        plate.backgroundColor = NSColor.black.withAlphaComponent(0.72); plate.textColor = .white
        badge.isHidden = true; bubble.isHidden = true
        content.addSubview(view); content.addSubview(bubble); content.addSubview(badge); content.addSubview(plate)
    }

    func setPosKey(_ k: String) {
        guard k != posKey else { return }
        posKey = k
        saved = (defaults.array(forKey: k) as? [Double]).flatMap { $0.count == 2 ? NSPoint(x: $0[0], y: $0[1]) : nil }
    }
    func forgetPosition() { posKey = ""; saved = nil }
    func move(dx: CGFloat, dy: CGFloat, bounds: NSRect) {
        x = min(max(0, x + dx), bounds.width - size)
        y = min(max(18, y + dy), bounds.height - size - 24)
    }
    func savePosition() { saved = NSPoint(x: x, y: y); defaults.set([Double(x), Double(y)], forKey: posKey) }

    func set(_ l: Look) {
        guard l != look else { return }
        let old = look; look = l
        if l.bubble != old.bubble { bubble.stringValue = l.bubble; bubble.isHidden = l.bubble.isEmpty }
        if l.plate != old.plate { plate.stringValue = l.plate; view.toolTip = l.plate }
        if l.mood != old.mood || l.bubble != old.bubble {
            let (bg, fg): (NSColor, NSColor) = switch l.mood {
                case .error: (.systemRed, .white)
                case .attention: (.systemYellow, .black)
                case .sleeping: (.systemGray, .white)
                case .blocked: (.systemOrange, .white)
                default: (NSColor.windowBackgroundColor.withAlphaComponent(0.92), .labelColor)
            }
            bubble.backgroundColor = bg; bubble.textColor = fg
            view.alphaValue = l.mood == .sleeping ? 0.5 : (l.mood == .blocked ? 0.75 : 1)
        }
        if l.badge != old.badge {
            badge.isHidden = l.badge == nil
            badge.stringValue = l.badge ?? ""
            badge.backgroundColor = l.badge == "zz" ? NSColor.systemGray.withAlphaComponent(0.85) : .systemRed
            badge.textColor = .white
        }
        if l.hop != old.hop { setHop(l.hop) }
        updateAnimates()
    }

    /// Only busy characters play their GIF: motion itself means "working", and still ones cost no CPU.
    func updateAnimates() {
        let a = look.mood == .busy || look.mood == .attention || (hovered && look.mood != .sleeping && look.mood != .blocked)
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

    func naturalPlateWidth() -> CGFloat { plate.fittingSize.width + 12 }
    private func centered(_ w: CGFloat, _ bounds: NSRect) -> CGFloat { min(max(0, x + size / 2 - w / 2), bounds.width - w) }
    func bubbleFrame(_ bounds: NSRect) -> NSRect {
        let w = min(bubble.fittingSize.width + 12, slotWidth)
        return NSRect(x: centered(w, bounds), y: y + size + 6, width: w, height: bubbleFont + 6)
    }

    func layout(_ bounds: NSRect) {
        let f = NSRect(x: x, y: y, width: size, height: size)
        if view.frame != f { view.frame = f; if look.hop { setHop(true) } }
        var bf = bubbleFrame(bounds); bf.origin.y += bubbleLift
        if bubble.frame != bf { bubble.frame = bf }
        let pw = min(naturalPlateWidth(), slotWidth)
        let pf = NSRect(x: centered(pw, bounds), y: y - 18, width: pw, height: 15)
        if plate.frame != pf { plate.frame = pf }
        if !badge.isHidden {
            let w = max(16, badge.fittingSize.width + 8)
            let r = NSRect(x: x + size - w / 2 - 2, y: y + size - 14, width: w, height: 14)
            if badge.frame != r { badge.frame = r }
        }
    }

    var hitRect: NSRect { (bubble.isHidden ? view.frame : view.frame.union(bubble.frame)).union(plate.frame) }
    func remove() { view.removeFromSuperview(); bubble.removeFromSuperview(); badge.removeFromSuperview(); plate.removeFromSuperview() }
}

func firstLine(_ s: String?, max: Int = 90) -> String {
    let l = (s ?? "").split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
    return l.count > max ? String(l.prefix(max)) + "…" : l
}

@MainActor enum Palette {
    static let panel = NSColor(calibratedRed: 0.985, green: 0.965, blue: 0.93, alpha: 1)
    static let card = NSColor(calibratedRed: 1, green: 0.996, blue: 0.985, alpha: 1)
    static let border = NSColor(calibratedRed: 0.89, green: 0.84, blue: 0.76, alpha: 1)
    static let text = NSColor(calibratedRed: 0.19, green: 0.15, blue: 0.11, alpha: 1)
    static let muted = NSColor(calibratedRed: 0.44, green: 0.38, blue: 0.31, alpha: 1)
    static let recBg = NSColor(calibratedRed: 1, green: 0.93, blue: 0.80, alpha: 1)
    static let rec = NSColor(calibratedRed: 0.52, green: 0.26, blue: 0.0, alpha: 1)
    static let alert = NSColor(calibratedRed: 0.84, green: 0.40, blue: 0.0, alpha: 1)
}

/// Rounded fill (+ optional hairline border), drawn in draw() so offscreen renders include it.
final class FillView: NSView {
    let fill: NSColor; let stroke: NSColor?; let radius: CGFloat
    init(fill: NSColor, stroke: NSColor?, radius: CGFloat) { self.fill = fill; self.stroke = stroke; self.radius = radius; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        fill.setFill(); p.fill()
        if let stroke { stroke.setStroke(); p.lineWidth = 1; p.stroke() }
    }
}

/// Quota bar: warm track, fill turns orange at 70% and red at 90%.
final class BarView: NSView {
    let fraction: Double
    init(fraction: Double) { self.fraction = min(max(fraction, 0), 1); super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.height / 2
        NSColor(calibratedRed: 0.90, green: 0.86, blue: 0.80, alpha: 1).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: r, yRadius: r).fill()
        let color: NSColor = fraction >= 0.9 ? .systemRed : (fraction >= 0.7 ? .systemOrange : .systemGreen)
        color.setFill()
        let w = max(bounds.height, bounds.width * fraction)
        if fraction > 0 { NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: w, height: bounds.height), xRadius: r, yRadius: r).fill() }
    }
}

/// Scroll container whose document starts at the top.
final class FlippedView: NSView { override var isFlipped: Bool { true } }

// MARK: - Overlay window + controller
@MainActor final class Pet: NSObject, NSPopoverDelegate, NSTextFieldDelegate {
    let panel: NSPanel
    var critters: [String: Critter] = [:]
    var lastActive: [String: Date] = [:]
    var workerOrder: [String] = []
    var teamOrder: [String] = []
    var rowSnapped = false
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

    func modelName(_ model: String) -> String {
        snapshot?.models?[model] ?? ["haiku": "Codex · 경량", "sonnet": "Codex · 표준", "opus": "Codex · 고성능"][model] ?? model
    }

    func apply(_ s: Snapshot, offline: Bool) {
        snapshot = s; self.offline = offline
        let content = panel.contentView!
        let reqs = s.requests ?? []
        let items = offline ? [] : (s.decisions ?? [])
        let needsYou = offline ? 0 : (s.decisions?.count ?? s.headline?.needsYou ?? 0)

        // CEO: bubble = "확인해 주세요 (N)" while decisions wait, else the headline, else none (§19).
        let active = reqs.first { ["thinking", "asking", "planned", "queued", "executing"].contains($0.status) } ?? reqs.first
        var ceoLook = Look(plate: "사장 · 구독 기본 모델")
        if offline { ceoLook.bubble = "hq 꺼짐"; ceoLook.mood = .sleeping }
        else {
            ceoLook.bubble = needsYou > 0 ? "확인해 주세요 (\(needsYou))" : (s.headline?.text ?? "")
            let working = ["thinking", "queued"].contains(active?.status ?? "")
            ceoLook.mood = needsYou > 0 ? .attention : (working ? .busy : .idle)
            ceoLook.badge = needsYou > 0 ? "\(needsYou)" : nil
            ceoLook.hop = needsYou > 0
        }
        let ceo = critters["ceo"] ?? {
            let c = Critter(id: "ceo", kind: .ceo, image: Sprites.character(characters["ceo"]!), in: content)
            wire(c); critters["ceo"] = c; return c
        }()
        ceo.set(ceoLook)

        // Workers: one per live attempt, in the daemon's order.
        let workers = offline ? [] : (s.workers ?? [])
        workerOrder = workers.map { "w:" + $0.attemptId }
        let live = Set(workerOrder)
        for (id, c) in critters where c.kind == .worker && !live.contains(id) { c.remove(); critters[id] = nil }
        var usedSprites = Set(critters.values.filter { $0.kind == .worker }.map(\.spriteName))
        for w in workers {
            let key = "w:" + w.attemptId
            let c = critters[key] ?? {
                let preferred = preferredSprite(w)
                let name = ([preferred] + workerSpritePool).first { !usedSprites.contains($0) } ?? preferred
                usedSprites.insert(name)
                let c = Critter(id: key, kind: .worker, image: Sprites.character(CharSpec(file: name, initial: String(professionName(w).prefix(1)), rgb: (0.25, 0.65, 0.55))), in: content)
                c.spriteName = name
                wire(c); critters[key] = c; return c
            }()
            c.worker = w
            var l = Look(bubble: workerBubble(w), mood: .busy)
            l.plate = "\(modelName(w.model)) · \(professionName(w))"
            if w.state == "held" { l.mood = .sleeping; l.badge = "zz" }
            if w.state == "blocked" { l.mood = .blocked }
            c.set(l)
        }

        // Teams (scheduler): only busy ones, lingering 5 minutes so a session doesn't flicker between turns.
        let showIdle = defaults.bool(forKey: "showIdle")
        let now = Date()
        for t in s.teams where t.state != "idle" { lastActive[t.id] = now }
        let teams = s.teams.filter { showIdle || $0.state != "idle" || now.timeIntervalSince(lastActive[$0.id] ?? .distantPast) < 300 }
        teamOrder = teams.map { "t:" + $0.id }
        let teamIds = Set(teamOrder)
        for (id, c) in critters where c.kind == .team && !teamIds.contains(id) { c.remove(); critters[id] = nil }
        for t in teams {
            let key = "t:" + t.id
            let c = critters[key] ?? {
                let c = Critter(id: key, kind: .team, image: Sprites.team(t), in: content)
                wire(c); critters[key] = c; return c
            }()
            c.team = t
            let icon: String = ["waiting": "✋ ", "sleeping": "💤 ", "error": "⚠️ "][t.state] ?? ""
            let mood: Mood = ["working": .busy, "waiting": .attention, "sleeping": .sleeping, "error": .error][t.state] ?? .idle
            c.set(Look(bubble: "\(icon)\(t.bubble)", mood: mood, hop: t.state == "waiting", plate: String(t.name.prefix(34))))
        }

        layoutAll()
        trackMouse()
        updateStatus(s, needsYou: needsYou)
        notifyNew(items)
        // Test hook: HQ_ROW_SNAPSHOT=<png> renders the character row offscreen once (works with the display asleep).
        if let path = env["HQ_ROW_SNAPSHOT"], !rowSnapped {
            rowSnapped = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.snapshotRow(path) }
        }
        // Test hook: HQ_OPEN=ceo|worker opens that popover once after the first snapshot (screenshots without clicking).
        // Test hooks: HQ_OPEN=ceo|worker|worker:<state> opens that panel once (HQ_TAB, HQ_FOCUS=<taskId>, HQ_PRESS=<kind>);
        // with HQ_SNAPSHOT the panel is rendered offscreen afterwards.
        if let which = env["HQ_OPEN"], !openedForTest {
            openedForTest = true
            let state = which.hasPrefix("worker:") ? String(which.dropFirst(7)) : nil
            let target = which == "ceo" ? ceo : which.hasPrefix("team:") ? critters["t:" + String(which.dropFirst(5))] : critters.values.first { $0.kind == .worker && (state == nil || $0.worker?.state == state) }
            if let target { DispatchQueue.main.async {
                if target.kind == .ceo { self.showCeo(for: target, tab: env["HQ_TAB"].flatMap { Int($0) }, focusTask: env["HQ_FOCUS"]) }
                else { self.showDetail(for: target) }
                if let reason = env["HQ_REJECT"], let i = self.shownDecisions.firstIndex(where: { $0.kind == "accept" }), let f = self.rejectFields[i] {
                    // HQ_REJECT=<reason>: open 반려 on the accept card, type the reason, press 반려 보내기.
                    let b = NSButton(); b.identifier = NSUserInterfaceItemIdentifier("\(i)"); self.rejectOpen(b)
                    let before = self.rejectSends[i]?.isEnabled ?? true
                    f.stringValue = reason; self.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: f))
                    log("reject send enabled: empty=\(before) typed=\(self.rejectSends[i]?.isEnabled ?? false)")
                    self.rejectSend(b)
                } else                 if let kind = env["HQ_PRESS"], let i = self.shownDecisions.firstIndex(where: { $0.kind == kind }) {
                    let b = NSButton(); b.identifier = NSUserInterfaceItemIdentifier("\(i)\u{1F}0"); self.decisionButton(b)
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.snapshotPopover() }
                }
            } }
        }
        if debug { log("apply workers=\(workers.count) decisions=\(items.count) offline=\(offline) critters=\(critters.count)") }
    }

    func wire(_ c: Critter) {
        c.view.onClick = { [weak self, weak c] in if let c { self?.showDetail(for: c) } }
        c.view.onDrag = { [weak self, weak c] dx, dy in
            guard let self, c != nil else { return }
            guard let anchor = self.critters["ceo"] else { return }
            self.popover?.close(); anchor.dragging = true
            anchor.move(dx: dx, dy: dy, bounds: self.panel.contentView!.bounds); self.layoutAll()
        }
        c.view.onDrop = { [weak self] in
            guard let anchor = self?.critters["ceo"] else { return }
            anchor.dragging = false; anchor.savePosition()
        }
        c.bubble.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(clicked(_:))))
    }

    /// CEO leftmost, then teams and their workers. Every character belongs to one anchored row.
    func rowOrder() -> [Critter] {
        ([critters["ceo"]] + teamOrder.map { critters[$0] } + workerOrder.map { critters[$0] }).compactMap { $0 }
    }

    /// One row anchored to Pikachu. Old per-worker saved coordinates never split the group.
    /// Dragging any character moves the whole row; clamp the row together at screen edges.
    func layoutAll() {
        let bounds = panel.contentView!.bounds
        let row = rowOrder()
        guard let anchor = row.first else { return }
        let margin: CGFloat = 16, gap: CGFloat = 10, rowY: CGFloat = 22
        var widths = row.map { max($0.naturalPlateWidth(), 120) }
        let gaps = gap * CGFloat(max(row.count - 1, 0))
        let total = widths.reduce(0, +) + gaps
        let avail = bounds.width - 2 * margin
        if total > avail { let scale = max(1, avail - gaps) / (total - gaps); widths = widths.map { $0 * scale } }
        anchor.setPosKey("row.ceo")
        let wantedX = anchor.dragging ? anchor.x : (anchor.saved?.x ?? (margin + widths[0] / 2 - anchor.size / 2))
        let wantedY = anchor.dragging ? anchor.y : (anchor.saved?.y ?? rowY)
        let groupWidth = widths.reduce(0, +) + gaps
        var left = min(max(margin, wantedX - widths[0] / 2 + anchor.size / 2), max(margin, bounds.width - margin - groupWidth))
        let y = min(max(18, wantedY), bounds.height - anchor.size - bubbleFont - 12)
        for (i, c) in row.enumerated() {
            c.slotWidth = widths[i]
            c.x = left + widths[i] / 2 - c.size / 2; c.y = y
            left += widths[i] + gap
        }
        // Bubbles that would overlap an earlier one (only possible after dragging) are lifted a row.
        var placed: [NSRect] = []
        for c in row {
            var lift: CGFloat = 0
            if !c.bubble.isHidden {
                var r = c.bubbleFrame(bounds)
                while placed.contains(where: { $0.insetBy(dx: -2, dy: 0).intersects(r) }) && lift < 100 { r.origin.y += bubbleFont + 9; lift += bubbleFont + 9 }
                placed.append(r)
            }
            c.bubbleLift = lift
            c.layout(bounds)
        }
    }

    func snapshotRow(_ path: String) {
        guard let v = panel.contentView else { return }
        let rect = NSRect(x: 0, y: 0, width: v.bounds.width, height: 170)
        guard let rep = v.bitmapImageRepForCachingDisplay(in: rect) else { return }
        v.cacheDisplay(in: rect, to: rep)
        let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: rep.pixelsWide, pixelsHigh: rep.pixelsHigh, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        out.size = rect.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
        NSColor(calibratedRed: 0.42, green: 0.5, blue: 0.6, alpha: 1).setFill(); NSRect(origin: .zero, size: rect.size).fill()
        rep.draw(in: NSRect(origin: .zero, size: rect.size), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
        try? out.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        log("row snapshot → \(path)")
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
                item.isEnabled = t.kind != "game" && t.enabled != false
                m.addItem(item)
                let toggle = NSMenuItem(title: "\(t.name) \(t.enabled == false ? "켜기" : "끄기")", action: #selector(toggleTeamMenu(_:)), keyEquivalent: "")
                toggle.target = self; toggle.representedObject = t.id; m.addItem(toggle)
            }
            let web = NSMenuItem(title: "사무실 열기 (웹 화면)", action: #selector(openWeb), keyEquivalent: "")
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

    // Panel = header / scrollable body / footer on a warm light background.
    static let panelWidth: CGFloat = 440
    static let innerWidth: CGFloat = 408     // panel minus 16pt sides
    static let cardText: CGFloat = 380       // card minus 14pt padding
    let maxBody: CGFloat = 470
    var panelView: NSView?
    var bodyStack: NSStackView?
    var bodyDoc: FlippedView?
    var bodyHeight: NSLayoutConstraint?
    var cardViews: [Int: NSView] = [:]

    func text(_ s: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, color: NSColor = Palette.text,
              width: CGFloat = Pet.innerWidth, mono: Bool = false) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: s)
        f.font = mono ? .monospacedSystemFont(ofSize: size - 1, weight: weight) : .systemFont(ofSize: size, weight: weight)
        f.textColor = color; f.preferredMaxLayoutWidth = width; f.isSelectable = false
        return f
    }

    func vstack(_ views: [NSView] = [], spacing: CGFloat = 8) -> NSStackView {
        let s = NSStackView(views: views); s.orientation = .vertical; s.alignment = .leading; s.spacing = spacing
        return s
    }

    func row(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView { let r = NSStackView(views: views); r.spacing = spacing; return r }

    /// Option buttons wrapped into rows (greedy, in order) so labels are never squeezed into "…".
    /// Only a single button wider than `maxWidth` gets its own row and may truncate at the tail.
    func buttonRows(_ buttons: [NSButton], maxWidth: CGFloat, spacing: CGFloat = 8) -> NSStackView {
        var rows: [[NSButton]] = []; var used: CGFloat = 0
        for b in buttons {
            let w = b.fittingSize.width
            if w > maxWidth {
                b.lineBreakMode = .byTruncatingTail
                b.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                b.widthAnchor.constraint(lessThanOrEqualToConstant: maxWidth).isActive = true
                rows.append([b]); used = maxWidth; continue
            }
            b.setContentCompressionResistancePriority(.required, for: .horizontal)
            if !rows.isEmpty, used + spacing + w <= maxWidth {
                rows[rows.count - 1].append(b); used += spacing + w
            } else { rows.append([b]); used = w }
        }
        return vstack(rows.map { row($0, spacing: spacing) }, spacing: spacing)
    }

    func button(_ title: String, _ action: Selector, _ id: String, primary: Bool = false) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.identifier = NSUserInterfaceItemIdentifier(id); b.isEnabled = !offline
        b.font = .systemFont(ofSize: 13)
        if primary { b.bezelColor = .controlAccentColor; b.keyEquivalent = "" }
        return b
    }

    func link(_ title: String, _ action: Selector, _ id: String) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.identifier = NSUserInterfaceItemIdentifier(id); b.isBordered = false
        b.attributedTitle = NSAttributedString(string: title, attributes: [.foregroundColor: NSColor.linkColor, .font: NSFont.systemFont(ofSize: 12.5, weight: .medium)])
        return b
    }

    /// Rounded filled box around a stack (cards, the recommendation block).
    func boxed(_ content: NSStackView, fill: NSColor, stroke: NSColor?, width: CGFloat, pad: CGFloat = 14, radius: CGFloat = 10) -> FillView {
        let box = FillView(fill: fill, stroke: stroke, radius: radius)
        content.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(content)
        NSLayoutConstraint.activate([
            box.widthAnchor.constraint(equalToConstant: width),
            content.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: pad),
            content.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor, constant: -pad),
            content.topAnchor.constraint(equalTo: box.topAnchor, constant: pad - 2),
            content.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -(pad - 2)),
        ])
        return box
    }

    func freeField(_ placeholder: String, _ action: Selector, _ id: String, width: CGFloat = Pet.cardText) -> NSTextField {
        let f = NSTextField(string: ""); f.placeholderString = placeholder; f.font = .systemFont(ofSize: 13)
        f.widthAnchor.constraint(equalToConstant: width).isActive = true
        f.identifier = NSUserInterfaceItemIdentifier(id); f.target = self; f.action = action; f.isEnabled = !offline
        return f
    }

    func footer() -> NSView {
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let r = row([button("사무실 열기", #selector(openWeb), ""), spacer, button("닫기", #selector(closePopover), "")])
        r.widthAnchor.constraint(equalToConstant: Pet.innerWidth).isActive = true
        return r
    }

    /// Shows a panel next to a character. The body scrolls when taller than `maxBody`.
    func openPanel(at c: Critter, header: [NSView], body: NSStackView, focus: NSView? = nil) {
        let doc = FlippedView(frame: .zero)
        doc.addSubview(body)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.autohidesScrollers = true; scroll.documentView = doc
        scroll.widthAnchor.constraint(equalToConstant: Pet.innerWidth).isActive = true
        let h = scroll.heightAnchor.constraint(equalToConstant: 100); h.isActive = true
        let root = vstack(header + [scroll, footer()], spacing: 12)
        root.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 14, right: 16)
        let panel = FillView(fill: Palette.panel, stroke: nil, radius: 0)
        root.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: panel.leadingAnchor), root.trailingAnchor.constraint(equalTo: panel.trailingAnchor),
                                     root.topAnchor.constraint(equalTo: panel.topAnchor), root.bottomAnchor.constraint(equalTo: panel.bottomAnchor),
                                     panel.widthAnchor.constraint(equalToConstant: Pet.panelWidth)])
        panelView = panel; bodyStack = body; bodyDoc = doc; bodyHeight = h
        relayoutBody()
        panel.frame.size = panel.fittingSize
        let vc = NSViewController(); vc.view = panel
        let p = NSPopover(); p.contentViewController = vc; p.behavior = .transient; p.delegate = self
        p.appearance = NSAppearance(named: .aqua)
        NSApp.activate()
        p.show(relativeTo: c.view.bounds, of: c.view, preferredEdge: .maxY)
        popover = p
        panel.window?.makeFirstResponder(focus)   // nil: no field grabs focus on open
    }

    /// Re-fits the body after its content changed (tab switch, inline error, reason field, activity loaded).
    func relayoutBody() {
        guard let body = bodyStack, let doc = bodyDoc, let panel = panelView else { return }
        body.translatesAutoresizingMaskIntoConstraints = true
        let fit = body.fittingSize
        let size = NSSize(width: Pet.innerWidth, height: fit.height)
        doc.setFrameSize(size); body.frame = NSRect(origin: .zero, size: size)
        bodyHeight?.constant = min(size.height, maxBody)
        panel.layoutSubtreeIfNeeded()
        if let p = popover, p.isShown { p.contentSize = panel.fittingSize }
    }
    func relayoutPopover() { relayoutBody() }

    func scrollBody(to v: NSView) {
        guard let doc = bodyDoc, let sv = doc.enclosingScrollView else { return }
        doc.layoutSubtreeIfNeeded()
        let r = v.convert(v.bounds, to: doc)
        sv.contentView.scroll(to: NSPoint(x: 0, y: max(0, min(r.minY - 6, doc.bounds.height - sv.contentView.bounds.height))))
        sv.reflectScrolledClipView(sv.contentView)
    }

    /// HQ_SNAPSHOT=<png>: renders the open panel (as seen) and its full body (`-full.png`) offscreen.
    func snapshotPopover() {
        guard let path = env["HQ_SNAPSHOT"] else { return }
        func write(_ v: NSView, _ p: String) {
            guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
            v.cacheDisplay(in: v.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: p))
        }
        if let panel = panelView { write(panel, path) }
        if let doc = bodyDoc { write(doc, path.replacingOccurrences(of: ".png", with: "-full.png")) }
        log("popover snapshot → \(path)")
    }

    @objc func closePopover() { popover?.close() }

    func showTeam(for c: Critter) {
        guard let t = c.team else { return }
        let header = [text(t.name, size: 15, weight: .bold), text(label(t.state), size: 12.5, color: Palette.muted)]
        let body = vstack([text(t.bubble)])
        if let r = t.lastRun, let sum = r.summary, !sum.isEmpty {
            body.addArrangedSubview(text("최근 실행 (종료 코드 \(r.exitCode.map(String.init) ?? "-"))", size: 12.5, weight: .semibold))
            body.addArrangedSubview(text(sum, size: 12, color: Palette.muted, mono: true))
        }
        for a in (snapshot?.approvals ?? []) where a.teamId == t.id {
            body.addArrangedSubview(text("승인 요청: \(a.title)", weight: .semibold))
            if !a.body.isEmpty { body.addArrangedSubview(text(a.body, size: 12.5, color: Palette.muted)) }
            body.addArrangedSubview(buttonRows(a.options.map { button($0, #selector(decide(_:)), "\(a.id)\u{1F}\($0)\u{1F}\(a.subjectHash)") }, maxWidth: Pet.innerWidth))
        }
        if !offline {
            if t.kind != "game" && t.enabled != false { body.addArrangedSubview(button("지금 실행", #selector(runTeam(_:)), t.id)) }
            if t.kind == "game" { body.addArrangedSubview(text("피카츄 → 새 요청에서 게임 프로젝트를 선택해 지시하세요.", size: 12)) }
            body.addArrangedSubview(button(t.enabled == false ? "팀 켜기" : "팀 끄기", #selector(toggleTeamButton(_:)), t.id))
        }
        openPanel(at: c, header: header, body: body)
    }

    func workerStateLabel(_ s: String) -> String {
        ["running": "작업 중", "verifying": "검증 중", "reviewing": "검토 중", "held": "한도 보류 (쉬는 중)", "blocked": "! 확인 필요"][s] ?? s
    }

    func showWorker(for c: Critter) {
        guard let w = c.worker else { return }
        let task = (snapshot?.requests ?? []).flatMap { $0.tasks ?? [] }.first { $0.id == w.taskId }
        let blocked = w.state == "blocked"
        let sub = text("\(modelName(w.model)) · \(professionName(w)) · \(workerStateLabel(w.state))", size: 12.5, weight: blocked ? .semibold : .regular, color: blocked ? Palette.alert : Palette.muted)
        let header = [text("\(w.project) · \(w.title)", size: 15, weight: .bold), sub]
        let body = vstack(spacing: 10)
        if blocked {
            body.addArrangedSubview(text("사장에게 보고했어요 · 결정은 사장 카드에서 해요", weight: .semibold, color: Palette.alert))
            body.addArrangedSubview(button("사장 카드 열기", #selector(openCeoCard(_:)), w.taskId, primary: true))
        }
        let kind = ["work": "구현", "review": "검토", "verify": "기계 검증"][w.kind] ?? w.kind
        body.addArrangedSubview(text("\(kind) · 시도 \(task?.attempts.map(String.init) ?? "-")회 · 시작 \(timeText(w.startedAt))", size: 12.5, color: Palette.muted))
        body.addArrangedSubview(text("최근 활동", size: 13, weight: .semibold))
        let activity = text("불러오는 중…", size: 12.5, color: Palette.text, mono: true)
        body.addArrangedSubview(boxed(vstack([activity]), fill: Palette.card, stroke: Palette.border, width: Pet.innerWidth, pad: 12, radius: 8))
        openPanel(at: c, header: header, body: body)
        loadActivity(w.attemptId, fallback: w.bubble, into: activity)
    }

    /// Last 5 lines of GET /api/attempts/:id/activity (pages through `next` when the log is long).
    func loadActivity(_ attemptId: String, fallback: String, into label: NSTextField) {
        Task { @MainActor in
            var after = 0; var lines: [String] = []; var ok = false
            for _ in 0..<20 {
                guard let url = URL(string: "api/attempts/\(seg(attemptId))/activity?after=\(after)", relativeTo: base),
                      let (data, resp) = try? await URLSession.shared.data(for: authed(url)),
                      (resp as? HTTPURLResponse)?.statusCode == 200,
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let arr = obj["lines"] as? [Any] else { break }
                ok = true
                lines += arr.compactMap { item -> String? in
                    if let s = item as? String { return s }
                    guard let o = item as? [String: Any], let t = o["text"] as? String else { return nil }
                    return (o["at"] as? String).map { "\(timeText($0))  \(t)" } ?? t
                }
                guard arr.count >= 500, let n = obj["next"] as? Int, n > after else { break }
                after = n
            }
            label.stringValue = !lines.isEmpty ? lines.suffix(5).joined(separator: "\n")
                : (ok ? "(아직 활동 기록이 없어요)" : (fallback.isEmpty ? "(활동을 불러오지 못했어요)" : fallback))
            relayoutBody()
            if env["HQ_SNAPSHOT"] != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.snapshotPopover() } }
        }
    }

    @objc func openCeoCard(_ b: NSButton) {
        guard let taskId = b.identifier?.rawValue, let ceo = critters["ceo"] else { return }
        popover?.close()
        showCeo(for: ceo, tab: 0, focusTask: taskId)
    }

    var requestInput: NSTextView?
    var projectPicker: NSPopUpButton?
    var rejectFields: [Int: NSTextField] = [:]
    var rejectSends: [Int: NSButton] = [:]
    /// "<card>\u{1F}<option>" → the hidden inline confirm row for an irreversible option.
    var confirmRows: [String: NSView] = [:]
    /// Card index → the hidden raw text behind "원문 보기".
    var rawViews: [Int: NSView] = [:]
    var rejectRows: [Int: NSView] = [:]
    var shownDecisions: [DecisionItem] = []
    var decisionErrors: [Int: NSTextField] = [:]
    var ceoTab = 0

    /// Chairman ↔ CEO: tabs 내 차례 N / 새 요청 / 사용량 (§19).
    func showCeo(for c: Critter, tab: Int? = nil, focusTask: String? = nil) {
        let items = offline ? [] : (snapshot?.decisions ?? [])
        ceoTab = tab ?? (items.isEmpty ? 1 : 0)
        var header: [NSView] = [text("사장", size: 15, weight: .bold)]
        if offline { header.append(text("hq 데몬이 꺼져 있어요. 켜진 뒤에 요청할 수 있어요.", size: 12.5, color: Palette.alert)) }
        else if let h = snapshot?.headline, !h.text.isEmpty { header.append(text(h.text, size: 12.5, color: Palette.muted)) }
        let seg = NSSegmentedControl(labels: ["내 차례 \(items.count)", "새 요청", "사용량"], trackingMode: .selectOne, target: self, action: #selector(tabChanged(_:)))
        seg.segmentDistribution = .fillEqually; seg.font = .systemFont(ofSize: 13)
        seg.widthAnchor.constraint(equalToConstant: Pet.innerWidth).isActive = true
        seg.selectedSegment = ceoTab
        header.append(seg)
        let body = ceoBody(ceoTab)
        openPanel(at: c, header: header, body: body, focus: ceoTab == 1 ? requestInput : nil)
        if let focusTask, let i = shownDecisions.firstIndex(where: { $0.taskId == focusTask || $0.id == focusTask }), let card = cardViews[i] {
            scrollBody(to: card)
        }
    }

    @objc func tabChanged(_ s: NSSegmentedControl) {
        ceoTab = s.selectedSegment
        guard let doc = bodyDoc else { return }
        bodyStack?.removeFromSuperview()
        let body = ceoBody(ceoTab)
        doc.addSubview(body); bodyStack = body
        relayoutBody()
        doc.enclosingScrollView?.contentView.scroll(to: .zero)
        if ceoTab == 1, let tv = requestInput { tv.window?.makeFirstResponder(tv) }
    }

    func ceoBody(_ tab: Int) -> NSStackView {
        switch tab {
        case 0: return decisionsBody()
        case 1: return requestBody()
        default: return usageBody()
        }
    }

    /// Inline confirm question for an irreversible option (daemon's `confirm`; same fallback rule as the web page).
    func confirmQuestion(_ d: DecisionItem, _ o: String) -> String? {
        if let q = d.confirm?[o], !q.isEmpty { return q }
        if (d.kind == "blocked" && o == "stop") || o == "요청 중단" { return "정말 중단할까요? · 되돌릴 수 없어요" }
        if d.kind == "merge" && o == "병합" { return "대상 브랜치에 병합할까요?" }
        return nil
    }

    func optionLabel(_ d: DecisionItem, _ o: String) -> String { d.kind == "blocked" ? (Pet.blockedLabels[o] ?? o) : o }

    /// 내 차례: one card per DecisionItem in the daemon's order.
    func decisionsBody() -> NSStackView {
        let items = offline ? [] : (snapshot?.decisions ?? [])
        shownDecisions = items; decisionErrors = [:]; rejectFields = [:]; rejectSends = [:]; rejectRows = [:]; cardViews = [:]; confirmRows = [:]; rawViews = [:]
        let body = vstack(spacing: 12)
        if items.isEmpty { body.addArrangedSubview(text("지금 하실 결정은 없어요.", color: Palette.muted)); return body }
        for (i, d) in items.enumerated() {
            let card = vstack(spacing: 8)
            if let chip = Pet.kindLabels[d.kind] { card.addArrangedSubview(text(chip, size: 11.5, weight: .semibold, color: Palette.muted)) }
            card.addArrangedSubview(text(d.title ?? d.kind, size: 14, weight: .bold, width: Pet.cardText))
            let situation = (d.situation?.isEmpty == false ? d.situation : d.detail) ?? ""
            if !situation.isEmpty { card.addArrangedSubview(text(situation, width: Pet.cardText)) }
            if let cause = d.cause, !cause.isEmpty {
                let t = text("", size: 12.5, color: Palette.muted, width: Pet.cardText)
                let s = NSMutableAttributedString(string: d.causeConfirmed == true ? "원인(확인됨) " : "원인(추정) ",
                                                  attributes: [.font: NSFont.systemFont(ofSize: 12.5, weight: .semibold), .foregroundColor: Palette.text])
                s.append(NSAttributedString(string: cause, attributes: [.font: NSFont.systemFont(ofSize: 12.5), .foregroundColor: Palette.muted]))
                t.attributedStringValue = s
                card.addArrangedSubview(t)
            }
            let opts = d.options ?? []
            if let rec = d.recommendation, opts.contains(rec.option) {
                let r = text("추천 · \(optionLabel(d, rec.option)). \(rec.reason)", size: 13, weight: .bold, color: Palette.rec, width: Pet.cardText - 24)
                card.addArrangedSubview(boxed(vstack([r]), fill: Palette.recBg, stroke: nil, width: Pet.cardText, pad: 12, radius: 8))
            }
            let help = opts.compactMap { o in d.optionHelp?[o].map { "· \(optionLabel(d, o)): \($0)" } }
            if !help.isEmpty { card.addArrangedSubview(vstack(help.map { text($0, size: 12.5, color: Palette.muted, width: Pet.cardText) }, spacing: 3)) }
            var buttons: [NSButton] = []
            for (j, o) in opts.enumerated() {
                if d.kind == "accept" && o == "반려" { buttons.append(button("반려…", #selector(rejectOpen(_:)), "\(i)")); continue }
                buttons.append(button(optionLabel(d, o), #selector(decisionButton(_:)), "\(i)\u{1F}\(j)", primary: d.recommendation?.option == o))
            }
            if !buttons.isEmpty { card.addArrangedSubview(buttonRows(buttons, maxWidth: Pet.cardText)) }
            // Irreversible options: a hidden inline question with the real send button (no dialogs).
            for (j, o) in opts.enumerated() {
                guard let q = confirmQuestion(d, o) else { continue }
                let yes = button(optionLabel(d, o), #selector(confirmYes(_:)), "\(i)\u{1F}\(j)")
                yes.bezelColor = .systemRed
                let no = button("아니요", #selector(confirmNo(_:)), "\(i)\u{1F}\(j)")
                let r = vstack([text(q, size: 12.5, weight: .semibold, color: .systemRed, width: Pet.cardText), row([yes, no])], spacing: 6)
                r.isHidden = true; confirmRows["\(i)\u{1F}\(j)"] = r
                card.addArrangedSubview(r)
            }
            if d.kind == "ceo_question" || d.kind == "worker_question" {
                card.addArrangedSubview(freeField("직접 답하기 (엔터)", #selector(decisionFree(_:)), "\(i)"))
            }
            if d.kind == "accept" {
                // 반려 never decides the accept approval: it posts /reject with a required reason (§12).
                let reason = freeField("반려 사유 (필수)", #selector(rejectSubmit(_:)), "\(i)", width: Pet.cardText - 100)
                reason.delegate = self; rejectFields[i] = reason
                let send = button("반려 보내기", #selector(rejectSend(_:)), "\(i)"); send.isEnabled = false
                rejectSends[i] = send
                let r = row([reason, send]); r.isHidden = true; rejectRows[i] = r
                card.addArrangedSubview(r)
            }
            let err = text("", size: 12.5, weight: .medium, color: .systemRed, width: Pet.cardText); err.isHidden = true; decisionErrors[i] = err
            card.addArrangedSubview(err)
            // Raw text (program output, full team card body) stays folded behind 원문 보기.
            if let raw = d.detail, !raw.isEmpty, d.situation?.isEmpty == false {
                card.addArrangedSubview(link("원문 보기", #selector(toggleRaw(_:)), "\(i)"))
                let rv = text(String(raw.prefix(3000)), size: 11.5, color: Palette.muted, width: Pet.cardText)
                rv.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
                rv.isHidden = true; rawViews[i] = rv
                card.addArrangedSubview(rv)
            }
            if d.detailPath != nil { card.addArrangedSubview(link("웹에서 자세히 보기 ›", #selector(openDetail(_:)), "\(i)")) }
            let box = boxed(card, fill: Palette.card, stroke: Palette.border, width: Pet.innerWidth)
            cardViews[i] = box
            body.addArrangedSubview(box)
        }
        return body
    }

    /// 새 요청: input, project picker, 최근 결과.
    func requestBody() -> NSStackView {
        let body = vstack(spacing: 10)
        body.addArrangedSubview(text("새 요청 (⌘↩ 보내기)", weight: .semibold))
        let scroll = NSTextView.scrollableTextView()
        scroll.widthAnchor.constraint(equalToConstant: Pet.innerWidth).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: 90).isActive = true
        let tv = scroll.documentView as! NSTextView
        tv.font = .systemFont(ofSize: 13); tv.isRichText = false; tv.allowsUndo = true; tv.textContainerInset = NSSize(width: 4, height: 6)
        requestInput = tv
        let picker = NSPopUpButton(frame: .zero, pullsDown: false)
        for p in snapshot?.projects ?? [] { picker.addItem(withTitle: p.name); picker.lastItem?.representedObject = p.id }
        projectPicker = picker
        let send = NSButton(title: "사장에게 보내기", target: self, action: #selector(sendRequest))
        send.keyEquivalent = "\r"; send.keyEquivalentModifierMask = [.command]; send.isEnabled = !offline; send.font = .systemFont(ofSize: 13)
        body.addArrangedSubview(scroll)
        body.addArrangedSubview(row([picker, send]))
        let done: Set<String> = ["merged", "accepted", "failed", "cancelled", "blocked"]
        let recent = (snapshot?.requests ?? []).filter { done.contains($0.status) }.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }.prefix(3)
        if !offline && !recent.isEmpty {
            body.addArrangedSubview(text("최근 결과", weight: .semibold))
            for r in recent {
                let bad = ["failed", "blocked", "cancelled"].contains(r.status)
                let line = vstack([text("[\(statusLabel(r.status))] \(firstLine(r.text, max: 50))", size: 13, weight: .medium, color: bad ? Palette.alert : Palette.text, width: Pet.cardText)], spacing: 3)
                if let n = r.note, !n.isEmpty { line.addArrangedSubview(text(firstLine(n, max: 120), size: 12.5, color: Palette.muted, width: Pet.cardText)) }
                body.addArrangedSubview(boxed(line, fill: Palette.card, stroke: Palette.border, width: Pet.innerWidth, pad: 12, radius: 8))
            }
        }
        return body
    }

    /// 사용량: every quota window with a bar, %, reset time; then the mode.
    func usageBody() -> NSStackView {
        let body = vstack(spacing: 12)
        guard !offline, let q = snapshot?.quota else { body.addArrangedSubview(text("아직 사용량 관측이 없어요.", color: Palette.muted)); return body }
        for w in q.allWindows {
            let name = ["five_hour": "5시간", "seven_day": "7일", "seven_day_opus": "7일 (Opus)", "seven_day_sonnet": "7일 (Sonnet)"][w.name] ?? w.name
            let v = vstack(spacing: 5)
            v.addArrangedSubview(text("\(name)  \(pct(w.utilization) ?? "-")", size: 13, weight: .semibold))
            let bar = BarView(fraction: w.utilization.map { $0 <= 1 ? $0 : $0 / 100 } ?? 0)
            bar.widthAnchor.constraint(equalToConstant: Pet.innerWidth).isActive = true
            bar.heightAnchor.constraint(equalToConstant: 8).isActive = true
            v.addArrangedSubview(bar)
            v.addArrangedSubview(text("리셋 \(timeText(w.resetsAt))", size: 12, color: Palette.muted))
            body.addArrangedSubview(v)
        }
        let mode = ["normal": "보통", "save": "절약 (동시 1)", "hold": "보류 (쉬는 중)", "unobserved": "관측 전 (하나씩 실행)"][q.mode ?? ""] ?? (q.mode ?? "-")
        body.addArrangedSubview(text("모드: \(mode)", weight: .semibold))
        if let at = q.observedAt { body.addArrangedSubview(text("관측 \(timeText(at))", size: 12, color: Palette.muted)) }
        return body
    }

    func statusLabel(_ s: String) -> String {
        ["queued": "대기", "thinking": "검토 중", "asking": "질문", "planned": "계획 승인 대기", "approved": "승인됨", "rejected": "반려됨",
         "failed": "실패", "executing": "실행 중", "awaiting_acceptance": "수락 대기", "accepted": "수락됨", "merging": "병합 중",
         "merged": "병합됨", "blocked": "막힘", "cancelled": "중단됨", "expired": "만료"][s] ?? s
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
    /// Blocked-card options are the wire values retry | release | skip | stop; labels are fixed here.
    /// Glossary copy: must match src/glossary.ts BLOCKED_LABELS (test/unit/glossary.test.ts).
    static let blockedLabels = ["retry": "한 번 더", "release": "끝난 것으로 보고 진행", "skip": "이 작업 건너뛰기", "stop": "요청 중단"]
    /// Small label above a 내 차례 card; kinds without one (and unknown kinds) render without it.
    /// Glossary copy: must match src/glossary.ts KIND_LABELS (test/unit/glossary.test.ts).
    static let kindLabels = [
        "system": "로그인 필요",
        "plan": "계획 승인",
        "ceo_question": "사장 질문",
        "worker_question": "작업자 질문",
        "revise": "지시서 수정안",
        "blocked": "막힘",
        "integration": "통합 문제",
        "accept": "결과 수락",
        "merge": "병합 승인",
        "team": "팀 결정",
    ]

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
        if let id = b.identifier?.rawValue, let r = confirmRows[id], confirmQuestion(d, o) != nil {
            r.isHidden = false; relayoutPopover(); return   // first click only asks
        }
        send(d, o, index: i)
    }
    @objc func confirmYes(_ b: NSButton) {
        guard let (i, d, o) = decisionAt(b), let o, let id = b.identifier?.rawValue, confirmRows[id]?.isHidden == false else { return }
        confirmRows[id]?.isHidden = true
        send(d, o, index: i)
    }
    @objc func confirmNo(_ b: NSButton) {
        guard let id = b.identifier?.rawValue else { return }
        confirmRows[id]?.isHidden = true; relayoutPopover()
    }
    @objc func toggleRaw(_ b: NSButton) {
        guard let (i, _, _) = decisionAt(b), let v = rawViews[i] else { return }
        v.isHidden.toggle()
        let title = v.isHidden ? "원문 보기" : "원문 접기"
        b.attributedTitle = NSAttributedString(string: title, attributes: [.foregroundColor: NSColor.linkColor, .font: NSFont.systemFont(ofSize: 12.5, weight: .medium)])
        relayoutPopover()
    }
    func send(_ d: DecisionItem, _ o: String, index i: Int) {
        if d.kind == "blocked" {
            post("api/tasks/\(seg(d.taskId ?? d.id))/decide", body: ["decision": o, "revision": d.revision ?? 0], decision: i)
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
        default:   // plan, accept, merge, revise, integration, team: approval-backed
            post("api/approvals/\(seg(d.id))", body: ["decision": a, "subjectHash": d.subjectHash ?? ""], decision: i)
        }
    }
    @objc func rejectOpen(_ b: NSButton) {
        guard let (i, _, _) = decisionAt(b), let r = rejectRows[i], let f = rejectFields[i] else { return }
        r.isHidden = false; relayoutPopover()
        f.window?.makeFirstResponder(f)
    }
    /// The send button stays disabled until a reason is typed.
    func controlTextDidChange(_ n: Notification) {
        guard let f = n.object as? NSTextField, let i = f.identifier.flatMap({ Int($0.rawValue) }), rejectFields[i] === f else { return }
        rejectSends[i]?.isEnabled = !offline && !f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    @objc func rejectSend(_ b: NSButton) {
        guard let (i, _, _) = decisionAt(b), let f = rejectFields[i] else { return }
        rejectSubmit(f)
    }
    @objc func rejectSubmit(_ f: NSTextField) {
        let reason = f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty, let (i, d, _) = decisionAt(f) else { return }
        post("api/requests/\(seg(d.requestId ?? ""))/reject", body: ["reason": reason, "subjectHash": d.subjectHash ?? ""], decision: i)
    }
    @objc func decide(_ b: NSButton) {   // team approvals (team popover)
        guard let p = parts(b, 3) else { return }
        post("api/approvals/\(seg(p[0]))", body: ["decision": p[1], "subjectHash": p[2]]); popover?.close()
    }
    func toggleTeam(_ id: String) {
        guard let t = snapshot?.teams.first(where: { $0.id == id }) else { return }
        post("api/teams/\(seg(id))/enabled", body: ["enabled": t.enabled == false]); popover?.close()
    }
    @objc func toggleTeamMenu(_ m: NSMenuItem) { if let id = m.representedObject as? String { toggleTeam(id) } }
    @objc func toggleTeamButton(_ b: NSButton) { if let id = b.identifier?.rawValue { toggleTeam(id) } }
    @objc func runTeam(_ b: NSButton) {
        guard let id = b.identifier?.rawValue else { return }
        post("api/teams/\(seg(id))/run", body: [:]); popover?.close()
    }
    @objc func runFromMenu(_ m: NSMenuItem) { if let id = m.representedObject as? String { post("api/teams/\(seg(id))/run", body: [:]) } }

    /// "사무실 열기" / "원문 보기": one-time login code from the daemon, opened in the browser (§16).
    /// For a detail link the login fragment is kept and detailPath's fragment is appended: #code=<c>&request=…&task=…
    @objc func openWeb() { openOffice(detailPath: nil) }
    @objc func openDetail(_ b: NSButton) {
        guard let (_, d, _) = decisionAt(b) else { return }
        openOffice(detailPath: d.detailPath)
    }
    func openOffice(detailPath: String?) {
        guard !offline else { return }
        popover?.close()
        var req = authed(URL(string: "api/ui-code", relativeTo: base)!)
        req.httpMethod = "POST"; req.httpBody = Data("{}".utf8); req.setValue("application/json", forHTTPHeaderField: "content-type")
        Task { @MainActor in
            guard let (data, _) = try? await URLSession.shared.data(for: req),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  var s = obj["url"] as? String else { log("ui-code failed"); return }
            if let dp = detailPath, let h = dp.firstIndex(of: "#") {
                let frag = String(dp[dp.index(after: h)...])
                if !frag.isEmpty { s += (s.contains("#") ? "&" : "#") + frag }
            }
            guard let url = URL(string: s, relativeTo: base) else { return }
            if debug { log("open \(url.absoluteString)") }
            NSWorkspace.shared.open(url.absoluteURL)
        }
    }

    /// Back to the row: forget every dragged position.
    @objc func resetPositions() {
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix("pos.") || k.hasPrefix("row.") { defaults.removeObject(forKey: k) }
        for c in critters.values { c.forgetPosition() }
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
                    // Only the daemon's Korean `error` sentence is shown; the status code and raw body go to the log.
                    let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    let text = (obj?["error"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    failure = text?.isEmpty == false ? text! : (code >= 500 ? "hq에서 문제가 생겼어요 · hq logs로 원문을 확인할 수 있어요" : "요청을 처리하지 못했어요")
                    log("POST \(path) → \(code): \(String(data: data, encoding: .utf8) ?? "")")
                }
            } catch { failure = "hq에 연결하지 못했어요" }
            if let i = decision {
                if let failure, let label = decisionErrors[i] {
                    label.stringValue = failure; label.isHidden = false; relayoutPopover()
                    snapshotPopover()
                } else if failure == nil { popover?.close() }
            }
            refresh()
        }
    }
}

// Standard AppKit key equivalents route to the focused text view or text field's field editor.
// The status item's menu alone does not provide the application's editing commands.
@MainActor func installEditingMenu(_ app: NSApplication) {
    let main = NSMenu()
    let appItem = NSMenuItem(); main.addItem(appItem)
    let appMenu = NSMenu(title: "HQ"); appItem.submenu = appMenu
    appMenu.addItem(withTitle: "HQ 펫 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    let editItem = NSMenuItem(); main.addItem(editItem)
    let edit = NSMenu(title: "편집"); editItem.submenu = edit
    edit.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "다시 실행", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: "잘라내기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "전체 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    app.mainMenu = main
}

// MARK: - Start
if env["HQ_PET_PRINT_CONFIG"] == "1" {
    print("bubbleFontSize=\(Double(bubbleFont))")
    exit(0)
}
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
installEditingMenu(app)
let pet = MainActor.assumeIsolated { Pet() }
app.run()
