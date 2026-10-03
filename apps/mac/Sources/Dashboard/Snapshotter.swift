import AppKit
import SwiftUI

/// `--snapshot <dir>`: renders each dashboard section with demo data to PNG, from the app's own
/// view hierarchy (no screen capture, no permission). Used to review the UI without a daemon.
enum Snapshotter {
    static func run(directory: String) {
        let store = DemoData.store()
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let sections: [DashboardSection] = DashboardSection.allCases
        render(sections, index: 0, store: store, directory: directory)
    }

    private static var window: NSWindow?

    private static func render(_ sections: [DashboardSection], index: Int, store: Store, directory: String) {
        guard index < sections.count else {
            renderMenu(store: store, directory: directory)
            return
        }
        let section = sections[index]
        let view = DashboardView(section: section).environmentObject(store).frame(width: 1180, height: 760)
        show(view, size: NSSize(width: 1180, height: 760))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            save(to: "\(directory)/\(index + 1)-\(section.rawValue).png")
            render(sections, index: index + 1, store: store, directory: directory)
        }
    }

    private static func renderMenu(store: Store, directory: String) {
        show(MenuView().environmentObject(store).fixedSize().background(.regularMaterial), size: NSSize(width: 340, height: 460))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            save(to: "\(directory)/9-menu.png")
            renderIslands(store: store, directory: directory, index: 0)
        }
    }

    /// The island in each of its states, over a wallpaper-like backdrop.
    private static var demoApprovals: [Approval] = []

    private static func renderIslands(store: Store, directory: String, index: Int) {
        if index == 0 { demoApprovals = store.approvals }
        let approvals = demoApprovals
        let scenes: [(String, (Store) -> Void)] = [
            ("listening", { $0.approvals = []; $0.voice = .listening; $0.heard = "Bon, Jarvis, qu'est-ce que j'ai à relire ce matin ?" }),
            ("thinking", { $0.voice = .thinking; $0.activity = "Outil : review_queue" }),
            ("speaking", { $0.voice = .speaking; $0.said = "Trois PR t'attendent. La plus ancienne touche les migrations." }),
            ("acting", { $0.voice = .idle; $0.acting = "Arc" }),
            ("approval", { $0.acting = nil; $0.approvals = approvals }),
            ("approval-pin", { $0.approvals = Array(approvals.dropFirst()) }),
            ("workers", { $0.approvals = []; $0.thinking = false }),
            ("stopped", { $0.status?.stop = "STOP (barre de menus)" }),
        ]
        guard index < scenes.count else {
            print("✔ snapshots in \(directory)")
            exit(0)
        }
        let (name, apply) = scenes[index]
        apply(store)
        let island = IslandView(notch: CGSize(width: 185, height: 32), onStop: {}, onSize: { _ in })
            .environmentObject(store)
        let backdrop = LinearGradient(colors: [Color(red: 0.16, green: 0.32, blue: 0.62), Color(red: 0.93, green: 0.55, blue: 0.36)],
                                      startPoint: .topLeading, endPoint: .bottomTrailing)
        show(ZStack(alignment: .top) { backdrop; island }.frame(width: 560, height: 220), size: NSSize(width: 560, height: 220))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            save(to: "\(directory)/island-\(index + 1)-\(name).png")
            renderIslands(store: store, directory: directory, index: index + 1)
        }
    }

    private static func show<V: View>(_ view: V, size: NSSize) {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: size)
        let w = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = host
        w.backgroundColor = .windowBackgroundColor // a real window has a background; offscreen ones do not
        w.setFrameOrigin(NSPoint(x: -20_000, y: -20_000)) // never visible on Brightky's screen
        w.orderFrontRegardless()
        window = w
    }

    private static func save(to path: String) {
        guard let view = window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        if let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: path)) }
    }
}

/// Plausible data for previews and snapshots (no real mail, no real people).
enum DemoData {
    static func store() -> Store {
        let s = Store(socketPath: nil)
        let now = Date()
        let iso = { (d: Date) in ISO8601DateFormatter().string(from: d) }
        func row(_ seq: Int, _ minutesAgo: Double, _ event: String, _ tool: String?, _ level: Int?, _ verdict: String?, _ outcome: String?, _ rule: String?, _ summary: String?, approval: String? = nil) -> AuditRow {
            AuditRow(seq: seq, ts: iso(now.addingTimeInterval(-minutesAgo * 60)), event: event, tool: tool, level: level, rule: rule, verdict: verdict,
                     trigger: "voice", origin: "user", tainted: false, approval: approval, outcome: outcome, durationMs: 12,
                     data: summary.map { .object(["summary": .string($0)]) })
        }
        let usage = { (turns: Int, cost: Double) in
            UsageSummary(since: iso(now), turns: turns, costUsd: cost, avgTtftMs: 820,
                         byModel: ["claude-sonnet-5-5": ModelUsageLine(turns: turns - 2, inputTokens: 18_200, outputTokens: 4_100, cacheReadTokens: 212_000, costUsd: cost * 0.7),
                                   "claude-opus-5-5": ModelUsageLine(turns: 2, inputTokens: 6_100, outputTokens: 2_300, cacheReadTokens: 40_000, costUsd: cost * 0.3)])
        }
        let days: [DayUsage] = (0..<30).map { i in
            let d = Calendar.current.date(byAdding: .day, value: i - 29, to: now)!
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            return DayUsage(day: f.string(from: d), turns: (i * 7) % 23 + 3, costUsd: Double((i * 13) % 17 + 2) / 40)
        }
        s.apply(Snapshot(
            status: DaemonStatus(stop: nil, devMode: false, policy: .init(sha256: "8181e5742575", sealed: true), brain: "ready",
                                 session: .init(id: "3fa9c1d2", tainted: true), startedAt: iso(now.addingTimeInterval(-7200)), quotaWarning: nil),
            pendingApprovals: [
                Approval(id: "a1", tool: "mail_send", level: 2, rule: "mail.send", summary: "Send from perso to client@example.com — \"Devis\": Bonjour, je valide le devis. Brightky",
                         reason: "sends a mail on behalf of Brightky", needsPin: false, tainted: true, externalDestinations: [], expiresAt: (now.timeIntervalSince1970 + 110) * 1000),
                Approval(id: "a2", tool: "fs_trash", level: 3, rule: "fs.trash.root", summary: "Move to Trash: ~/jarvis-work/old-build",
                         reason: "moves to the Trash", needsPin: true, tainted: false, externalDestinations: [], expiresAt: (now.timeIntervalSince1970 + 90) * 1000),
            ],
            audit: [
                row(12, 1, "intent", "mail_send", 2, "confirm", nil, "mail.send", "Send from perso to client@example.com — \"Devis\""),
                row(11, 2, "result", "mail_draft", 1, nil, "ok", "mail.draft", nil),
                row(10, 2, "intent", "mail_draft", 1, "allow", nil, "mail.draft", "Draft (perso) to client@example.com — \"Devis\""),
                row(9, 4, "result", "briefing", 0, nil, "ok", "briefing", nil),
                row(8, 4, "intent", "briefing", 0, "allow", nil, "briefing", "Morning briefing"),
                row(7, 9, "intent", "shell_run", 4, "deny", nil, "shell.deny.rm", "Run: rm -rf ~/jarvis-work"),
                row(6, 15, "approval", "outbox_send", 2, nil, "approved", nil, nil, approval: "voice"),
                row(5, 20, "intent", "app_open", 1, "allow", nil, "macos.app.allowlisted", "Open Visual Studio Code on ~/jarvis-work/CodeVault"),
                row(4, 31, "llm", nil, nil, nil, "success", nil, nil),
                row(3, 40, "intent", "web_research", 0, "allow", nil, "research.web", "Web research (quick): Tauri vs Electron"),
            ],
            costs: Costs(today: usage(14, 0.31), week: usage(83, 1.92), month: usage(212, 4.85)),
            daily: days,
            quota: [
                QuotaWindow(window: "five_hour", utilization: 0.42, status: "allowed", resetsAt: iso(now.addingTimeInterval(3 * 3600)),
                            forecast: QuotaForecastInfo(utilization: 0.42, resetsAt: nil, fullAt: iso(now.addingTimeInterval(2.4 * 3600)), perHour: 0.24)),
                QuotaWindow(window: "seven_day", utilization: 0.18, status: "allowed", resetsAt: iso(now.addingTimeInterval(4 * 86400)), forecast: nil),
            ],
            forecast: Forecast(monthCostUsd: 9.4, turnsPerDay: 17),
            mail: [MailAccount(id: "perso", type: "gmail", email: "brightkyefoo@gmail.com", connected: true, missing: nil, test: "ok (410 ms)"),
                   MailAccount(id: "scriptify", type: "imap", email: "pro@example.cm", connected: false, missing: "jarvis mail add scriptify", test: nil)],
            forges: [ForgeAccount(id: "github", connected: true, connect: "jarvis github connect"),
                     ForgeAccount(id: "gitlab", connected: false, connect: "jarvis gitlab connect"),
                     ForgeAccount(id: "trello", connected: true, connect: "jarvis trello connect")],
            workers: [WorkerTask(id: "3fa9c1d2", repo: "BrightkyEfoo/codevault", title: "Ajoute le mode sombre", status: "running", step: "implémentation", prUrl: nil, error: nil, createdAt: iso(now)),
                      WorkerTask(id: "8b21e0aa", repo: "acme/app", title: "Corrige le délai de connexion", status: "done", step: "PR ouverte", prUrl: "https://github.com/acme/app/pull/41", error: nil, createdAt: iso(now))],
            memory: MemoryInfo(facts: [Fact(id: 3, kind: "preference", text: "Ton des mails : pro et direct", source: "jarvis", createdAt: iso(now)),
                                       Fact(id: 2, kind: "project", text: "CodeVault : Next.js, déployé sur Coolify", source: "jarvis", createdAt: iso(now))],
                               notesDir: NSHomeDirectory() + "/Jarvis/memory"),
            tools: [ToolInfo(name: "briefing", description: "Morning briefing in one call"), ToolInfo(name: "mail_send", description: "Send a draft (N2)")],
            signature: "fait avec ❤️ par Brightky Efo'o — https://brightkyefoo.cm"))
        s.upcoming = [CalendarItem(id: "e1", title: "Démo client", start: iso(now.addingTimeInterval(5400)), end: iso(now.addingTimeInterval(9000)),
                                   allDay: false, location: nil, attendees: 3, hasVideoLink: true)]
        s.connected = true
        s.voice = .idle
        s.activity = "Répondu sonnet-5-5 · 1er mot 780 ms"
        s.voiceEngine = "Parakeet v3 (local) · fr: Fabien — posé, en: Charles — deep"
        s.actuatorConnected = true
        return s
    }
}
