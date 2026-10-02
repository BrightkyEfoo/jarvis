import Foundation
import SwiftUI

/// Everything the dashboard and the menu bar show, kept live from jarvisd.
/// Main-thread only: DaemonLink delivers on the main queue.
final class Store: ObservableObject {
    enum VoiceState: String { case off, idle, listening, transcribing, thinking, speaking, confirming }

    @Published var connected = false
    @Published var status: DaemonStatus?
    @Published var approvals: [Approval] = []
    @Published var audit: [AuditRow] = []
    @Published var costs: Costs?
    @Published var daily: [DayUsage] = []
    @Published var quota: [QuotaWindow] = []
    @Published var forecast: Forecast?
    @Published var mail: [MailAccount] = []
    @Published var forges: [ForgeAccount] = []
    @Published var facts: [Fact] = []
    @Published var notesDir = ""
    @Published var tools: [ToolInfo] = []
    @Published var upcoming: [CalendarItem] = []
    @Published var upcomingNote: String?
    @Published var activity = "En veille"
    @Published var thinking = false
    @Published var voice = VoiceState.off
    /// App Jarvis is driving right now (browser, Notes, any app), nil when its hands are idle.
    @Published var acting: String?
    @Published var actuatorConnected = false
    /// Recogniser and voices in use (system until the neural models are loaded).
    @Published var voiceEngine = ""
    @Published var lastError: String?
    @Published var signature = "fait avec ❤️ par Brightky Efo'o"
    @Published var auditExhausted = false

    private let link: DaemonLink?
    private let watchLink: DaemonLink?
    private var refreshQueued = false

    init(socketPath: String?) {
        link = socketPath.map { DaemonLink(path: $0) }
        watchLink = socketPath.map { DaemonLink(path: $0) }
    }

    var stopped: Bool { status?.stop != nil }

    // MARK: - Lifecycle

    func start() {
        guard link != nil else { return }
        refresh()
        startWatch()
        loadUpcoming()
        scheduleTick()
    }

    private func scheduleTick() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            self?.refresh()
            self?.loadUpcomingIfStale()
            self?.scheduleTick()
        }
    }

    private var upcomingLoadedAt = Date.distantPast
    private func loadUpcomingIfStale() {
        if Date().timeIntervalSince(upcomingLoadedAt) > 600 { loadUpcoming() }
    }

    func refresh() {
        link?.request(["cmd": "dashboard"]) { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(value):
                guard let s = DaemonLink.decode(Snapshot.self, value) else {
                    self.lastError = "réponse inattendue de jarvisd"
                    return
                }
                self.apply(s)
                self.connected = true
                self.lastError = nil
            case let .failure(e):
                self.connected = false
                self.lastError = e.localizedDescription
            }
        }
    }

    /// Coalesces bursts (a turn produces many audit rows) into one refresh.
    private func refreshSoon() {
        guard !refreshQueued else { return }
        refreshQueued = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.refreshQueued = false
            self?.refresh()
        }
    }

    func apply(_ s: Snapshot) {
        status = s.status
        approvals = s.pendingApprovals
        if audit.isEmpty || audit.first?.seq != s.audit.first?.seq { audit = s.audit }
        costs = s.costs
        daily = s.daily
        quota = s.quota
        forecast = s.forecast
        mail = s.mail
        forges = s.forges ?? []
        facts = s.memory.facts
        notesDir = s.memory.notesDir
        tools = s.tools
        signature = s.signature
    }

    private func startWatch() {
        watchLink?.request(["cmd": "watch"], onEvent: { [weak self] msg in self?.handle(msg) }, done: { [weak self] _ in
            // Stream ended (daemon restarted): retry in a few seconds.
            self?.connected = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.refresh()
                self?.startWatch()
            }
        })
    }

    private func handle(_ msg: DaemonLink.Message) {
        switch msg["type"] as? String {
        case "event":
            guard let event = msg["event"] as? [String: Any] else { return }
            switch event["kind"] as? String {
            case "audit":
                if let row = DaemonLink.decode(AuditRow.self, event["record"]) {
                    audit.insert(row, at: 0)
                    if audit.count > 1000 { audit.removeLast(audit.count - 1000) }
                }
            case "activity":
                if let a = event["activity"] as? [String: Any] { applyActivity(a) }
            case "hello":
                connected = true
            default:
                break
            }
        case "approval":
            if let a = DaemonLink.decode(Approval.self, msg["request"]), !approvals.contains(where: { $0.id == a.id }) {
                approvals.append(a)
            }
        case "approval_resolved":
            if let id = msg["approvalId"] as? String { approvals.removeAll { $0.id == id } }
        default:
            break
        }
    }

    private func applyActivity(_ a: [String: Any]) {
        switch a["kind"] as? String {
        case "turn_start":
            thinking = true
            activity = "Réfléchit : « \(a["preview"] as? String ?? "") »"
        case "tool":
            activity = "Outil : \(a["name"] as? String ?? "?")"
        case "turn_end":
            thinking = false
            let ttft = (a["ttftMs"] as? Double).map { " · 1er mot \(Int($0)) ms" } ?? ""
            let model = (a["model"] as? String)?.replacingOccurrences(of: "claude-", with: "") ?? ""
            activity = (a["ok"] as? Bool ?? false) ? "Répondu \(model)\(ttft)" : "Tour interrompu ou en erreur"
            refreshSoon()
        case "stop":
            activity = "STOP : \(a["reason"] as? String ?? "")"
            refresh()
        case "resume":
            activity = "Reprise"
            refresh()
        case "quota":
            refreshSoon()
        default:
            break
        }
    }

    // MARK: - Actions (same commands as the CLI, channel "hud")

    func stop() {
        link?.request(["cmd": "stop", "reason": "STOP depuis le tableau de bord"]) { [weak self] _ in self?.refresh() }
    }

    func resume(pin: String, completion: @escaping (String?) -> Void) {
        link?.request(["cmd": "resume", "pin": pin]) { [weak self] r in
            if case let .failure(e) = r { completion(e.localizedDescription) } else { completion(nil) }
            self?.refresh()
        }
    }

    func approve(_ a: Approval, pin: String?, completion: @escaping (String?) -> Void) {
        var body: DaemonLink.Message = ["cmd": "approve", "approvalId": a.id, "channel": "hud"]
        if let pin, !pin.isEmpty { body["pin"] = pin }
        link?.request(body) { r in
            if case let .failure(e) = r { completion(e.localizedDescription) } else { completion(nil) }
        }
    }

    func deny(_ a: Approval) {
        link?.request(["cmd": "deny", "approvalId": a.id, "channel": "hud"])
    }

    func forget(_ f: Fact) {
        link?.request(["cmd": "memory_forget", "factId": f.id]) { [weak self] _ in self?.refresh() }
    }

    func newSession() {
        link?.request(["cmd": "new_session"]) { [weak self] _ in
            self?.activity = "Nouvelle conversation"
            self?.refresh()
        }
    }

    func testMail() {
        link?.request(["cmd": "mail_status", "test": true]) { [weak self] r in
            if case let .success(v) = r, let accounts = DaemonLink.decode([MailAccount].self, v) { self?.mail = accounts }
        }
    }

    func loadMoreAudit() {
        guard let last = audit.last?.seq, !auditExhausted else { return }
        link?.request(["cmd": "audit_query", "limit": 200, "beforeSeq": last]) { [weak self] r in
            guard let self, case let .success(v) = r, let rows = DaemonLink.decode([AuditRow].self, v) else { return }
            if rows.isEmpty { self.auditExhausted = true }
            self.audit.append(contentsOf: rows)
        }
    }

    func loadUpcoming() {
        upcomingLoadedAt = Date()
        link?.request(["cmd": "upcoming"]) { [weak self] r in
            guard let self, case let .success(v) = r, let dict = v as? [String: Any] else { return }
            self.upcoming = DaemonLink.decode([CalendarItem].self, dict["events"]) ?? []
            self.upcomingNote = dict["note"] as? String
        }
    }
}
