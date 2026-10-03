import AppKit
import Combine
import SwiftUI

/// The Jarvis island: a black capsule that comes out of the notch (or sits under the menu bar on a
/// screen without one) whenever Jarvis listens, thinks, speaks, drives the Mac, needs a decision,
/// is stopped, or has workers running. Nothing shows when Jarvis is idle.
final class IslandController {
    private let store: Store
    private let panel: IslandPanel
    private let host: NSHostingView<AnyView>
    private var size = CGSize(width: 300, height: 60)
    private var bag: Set<AnyCancellable> = []
    private var visible = false

    init(store: Store, onStop: @escaping () -> Void) {
        self.store = store
        panel = IslandPanel(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 60),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        // Above the menu bar, so the capsule can merge with the notch.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true

        let geometry = Self.geometry()
        host = NSHostingView(rootView: AnyView(EmptyView()))
        host.rootView = AnyView(
            IslandView(notch: geometry.notch, onStop: onStop) { [weak self] s in self?.resize(s) }
                .environmentObject(store)
        )
        panel.contentView = host

        // Re-evaluate on every store change (after it is applied) and when screens change.
        store.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.update() }
            .store(in: &bag)
        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .sink { [weak self] _ in self?.place() }
            .store(in: &bag)
        update()
    }

    private var mode: IslandMode {
        IslandMode.from(
            stopped: store.stopped,
            approvalIds: store.approvals.map(\.id),
            acting: store.acting,
            voice: store.voice.rawValue,
            thinking: store.thinking,
            activeWorkers: store.workers.filter { IslandMode.isActive(workerStatus: $0.status) }.count
        )
    }

    private func update() {
        let show = mode != .hidden
        if show == visible { return }
        visible = show
        if show {
            place()
            panel.orderFrontRegardless()
        } else {
            panel.orderOut(nil)
        }
    }

    private func resize(_ s: CGSize) {
        guard s.width > 1, s.height > 1, s != size else { return }
        size = s
        place()
    }

    /// Top centre of the screen with the menu bar: flush with the top edge under a notch, just
    /// below the menu bar otherwise.
    private func place() {
        let g = Self.geometry()
        let top = g.notch.height > 0 ? g.screen.frame.maxY : g.screen.visibleFrame.maxY
        panel.setFrame(
            NSRect(x: g.screen.frame.midX - size.width / 2, y: top - size.height, width: size.width, height: size.height),
            display: true
        )
    }

    static func geometry() -> (screen: NSScreen, notch: CGSize) {
        guard let screen = NSScreen.screens.first else { return (NSScreen.main!, .zero) }
        let inset = screen.safeAreaInsets.top
        guard inset > 0 else { return (screen, .zero) }
        let left = screen.auxiliaryTopLeftArea?.width ?? 0, right = screen.auxiliaryTopRightArea?.width ?? 0
        let width = screen.frame.width - left - right
        return (screen, CGSize(width: width > 80 && width < 400 ? width : 200, height: inset))
    }
}

/// Never activates Jarvis.app, but can take the keyboard for a PIN.
final class IslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private struct IslandSize: PreferenceKey {
    static let defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

struct IslandView: View {
    @EnvironmentObject var store: Store
    let notch: CGSize
    let onStop: () -> Void
    let onSize: (CGSize) -> Void
    @State private var expanded = false

    private var mode: IslandMode {
        IslandMode.from(
            stopped: store.stopped,
            approvalIds: store.approvals.map(\.id),
            acting: store.acting,
            voice: store.voice.rawValue,
            thinking: store.thinking,
            activeWorkers: activeWorkers.count
        )
    }

    private var activeWorkers: [WorkerTask] { store.workers.filter { IslandMode.isActive(workerStatus: $0.status) } }

    var body: some View {
        VStack(spacing: 0) {
            if notch.height > 0 { Color.clear.frame(height: notch.height) }
            content
                .padding(.horizontal, 16)
                .padding(.top, notch.height > 0 ? 6 : 10)
                .padding(.bottom, 12)
        }
        .frame(minWidth: max(notch.width + 40, 220), alignment: .top)
        .fixedSize()
        .foregroundStyle(.white)
        .background(
            UnevenRoundedRectangle(
                topLeadingRadius: notch.height > 0 ? 0 : 18,
                bottomLeadingRadius: 22,
                bottomTrailingRadius: 22,
                topTrailingRadius: notch.height > 0 ? 0 : 18
            )
            .fill(Color.black)
        )
        .background(GeometryReader { g in Color.clear.preference(key: IslandSize.self, value: g.size) })
        .onPreferenceChange(IslandSize.self) { onSize($0) }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: mode)
        .environment(\.colorScheme, .dark)
    }

    @ViewBuilder private var content: some View {
        switch mode {
        case .hidden:
            EmptyView()
        case .stopped:
            VStack(alignment: .leading, spacing: 8) {
                Label("Jarvis est à l'arrêt (STOP)", systemImage: "stop.circle.fill")
                    .font(.headline).foregroundStyle(.red)
                if let why = store.status?.stop { Text(why).font(.caption).foregroundStyle(.secondary) }
                ResumeForm()
            }
            .frame(width: 360, alignment: .leading)
        case let .approval(id):
            if let a = store.approvals.first(where: { $0.id == id }) {
                IslandApproval(approval: a, more: store.approvals.count - 1, voiceAsking: store.voice == .confirming)
            }
        case let .acting(app):
            HStack(spacing: 10) {
                Circle().fill(Color.orange).frame(width: 9, height: 9)
                    .shadow(color: .orange, radius: 4)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Jarvis pilote \(app)").font(.callout.weight(.semibold))
                    Text("⌃⎋ ou STOP pour tout arrêter").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                Button(action: onStop) { Label("STOP", systemImage: "stop.fill") }
                    .buttonStyle(IslandButton(color: .red))
            }
            .frame(width: 340)
        case .listening:
            HStack(spacing: 12) {
                LevelBars(source: { AudioMeter.shared.mic }, tint: .white)
                Text(store.heard.isEmpty ? "J'écoute…" : store.heard)
                    .font(.callout).lineLimit(2).frame(width: 260, alignment: .leading)
            }
        case .thinking:
            HStack(spacing: 12) {
                Breathing()
                Text(thinkingLabel).font(.callout).lineLimit(1).frame(width: 260, alignment: .leading)
            }
        case .speaking:
            HStack(spacing: 12) {
                LevelBars(source: { AudioMeter.shared.out }, tint: .cyan)
                Text(store.said).font(.callout).lineLimit(2).frame(width: 260, alignment: .leading)
            }
        case let .workers(count):
            VStack(alignment: .leading, spacing: 8) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "gearshape.2.fill").foregroundStyle(.green)
                        Text(count == 1 ? "1 worker en cours" : "\(count) workers en cours").font(.caption.weight(.semibold))
                        Spacer(minLength: 8)
                        QuotaChips(quota: store.quota)
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2)
                    }
                }
                .buttonStyle(.plain)
                if expanded {
                    ForEach(activeWorkers) { w in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(w.title).font(.caption.weight(.medium)).lineLimit(1)
                            Text("\(w.repo) · \(w.step)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
            .frame(width: expanded ? 360 : 300, alignment: .leading)
        }
    }

    private var thinkingLabel: String {
        if store.activity.hasPrefix("Outil : ") { return "Je consulte \(Self.what(String(store.activity.dropFirst(8))))…" }
        return store.heard.isEmpty ? "Je réfléchis…" : "« \(store.heard) »"
    }

    /// Tool name → what Brightky would call it.
    static func what(_ tool: String) -> String {
        let t = tool.replacingOccurrences(of: "mcp__jarvis__", with: "")
        let words: [(String, String)] = [
            ("mail", "tes mails"), ("calendar", "ton agenda"), ("forge", "GitHub et GitLab"), ("review", "ta file de revue"),
            ("pr_", "la PR"), ("issue", "les issues"), ("trello", "Trello"), ("worker", "les workers"), ("browser", "le navigateur"),
            ("screen", "l'écran"), ("window", "les fenêtres"), ("app_", "les apps"), ("apps", "les apps"), ("notes", "tes notes"),
            ("reminders", "tes rappels"), ("web", "le web"), ("youtube", "YouTube"), ("memory", "ma mémoire"), ("fs_", "tes fichiers"),
            ("shell", "le terminal"), ("brief", "ta journée"), ("system", "le Mac"),
        ]
        return words.first { t.hasPrefix($0.0) || t.contains($0.0) }?.1 ?? t
    }
}

/// Coloured buttons that stay coloured in a panel that never takes focus.
private struct IslandButton: ButtonStyle {
    let color: Color
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(color.opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.35)))
            .foregroundStyle(.white.opacity(enabled ? 1 : 0.6))
    }
}

/// A decision waiting for Brightky: what, how sensitive, where the request came from.
private struct IslandApproval: View {
    @EnvironmentObject var store: Store
    let approval: Approval
    let more: Int
    let voiceAsking: Bool
    @State private var pin = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                LevelBadge(level: approval.level)
                Text(Wording.fr(approval.summary)).font(.callout.weight(.semibold)).lineLimit(4)
            }
            if approval.tainted {
                Label("Contenu externe lu dans cette conversation", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            if !approval.externalDestinations.isEmpty {
                Label("Destinataire issu d'un contenu externe", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack {
                if voiceAsking { Text("Dis « oui » ou « non »").font(.caption).foregroundStyle(.secondary) }
                if more > 0 { Text("+\(more) en attente").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if approval.needsPin {
                    SecureField("PIN", text: $pin).frame(width: 90).textFieldStyle(.roundedBorder).onSubmit(approve)
                }
                Button("Refuser") { store.deny(approval) }.buttonStyle(IslandButton(color: Color.white.opacity(0.18)))
                Button("Approuver", action: approve)
                    .buttonStyle(IslandButton(color: .blue))
                    .disabled(busy || (approval.needsPin && pin.count < 6))
            }
            if let error { Text(error).font(.caption).foregroundStyle(.yellow) }
        }
        .frame(width: 400, alignment: .leading)
    }

    private func approve() {
        guard !busy, !approval.needsPin || pin.count >= 6 else { return }
        busy = true
        store.approve(approval, pin: approval.needsPin ? pin : nil) { e in
            busy = false
            error = e.map(ResumeForm.french)
            if e == nil { pin = "" }
        }
    }
}

/// Ten bars driven by a real audio level (microphone or Jarvis's voice).
private struct LevelBars: View {
    let source: () -> Float
    let tint: Color
    private let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { t in
            let level = CGFloat(source())
            let phase = t.date.timeIntervalSinceReferenceDate * 7
            HStack(spacing: 2.5) {
                ForEach(0..<10, id: \.self) { i in
                    let wobble = 0.55 + 0.45 * abs(sin(phase + Double(i) * 0.9))
                    Capsule()
                        .fill(tint)
                        .frame(width: 3, height: 4 + 18 * level * CGFloat(wobble))
                }
            }
            .frame(width: 52, height: 24)
        }
    }
}

/// A slow breathing dot while Jarvis thinks.
private struct Breathing: View {
    @State private var on = false

    var body: some View {
        Circle()
            .fill(Color.white)
            .frame(width: 10, height: 10)
            .scaleEffect(on ? 1 : 0.6)
            .opacity(on ? 1 : 0.5)
            .frame(width: 52, height: 24)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { on = true }
            }
    }
}

/// The real scarce resource: the Max 5x quota, 5 h and 7 day windows.
private struct QuotaChips: View {
    let quota: [QuotaWindow]

    var body: some View {
        HStack(spacing: 6) {
            chip("5 h", quota.first { $0.window == "five_hour" }?.utilization)
            chip("7 j", quota.first { $0.window == "seven_day" }?.utilization)
        }
    }

    @ViewBuilder private func chip(_ label: String, _ u: Double?) -> some View {
        if let u {
            Text("\(label) \(Int(u * 100)) %")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(u > 0.85 ? .red : u > 0.6 ? .orange : .green)
        }
    }
}
