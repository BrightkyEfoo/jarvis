import SwiftUI

/// The menu bar icon: what Jarvis is doing, at a glance.
struct StatusIcon: View {
    @ObservedObject var store: Store
    @Environment(\.openWindow) private var openWindow
    let onAppear: (OpenWindowAction) -> Void

    var body: some View {
        Image(systemName: symbol)
            .symbolRenderingMode(.hierarchical)
            .onAppear { onAppear(openWindow) }
    }

    private var symbol: String {
        if store.stopped { return "stop.circle.fill" }
        if !store.connected { return "circle.dashed" }
        if store.acting != nil { return "cursorarrow.click.2" }
        switch store.voice {
        case .listening, .transcribing: return "waveform.circle.fill"
        case .speaking: return "speaker.wave.2.circle.fill"
        case .confirming: return "questionmark.circle.fill"
        default: break
        }
        if store.thinking || store.voice == .thinking { return "ellipsis.circle.fill" }
        if !store.approvals.isEmpty { return "exclamationmark.circle.fill" }
        return "j.circle"
    }
}

struct MenuView: View {
    @EnvironmentObject var store: Store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Jarvis").font(.headline)
                Spacer()
                ConnectionPill()
            }
            Text(store.activity).font(.callout).lineLimit(2).foregroundStyle(.secondary)
            if let app = store.acting {
                Label("Jarvis pilote \(app) — ⌃⎋ pour tout arrêter", systemImage: "cursorarrow.click.2")
                    .font(.caption.weight(.semibold)).foregroundStyle(.orange)
            }

            if !store.approvals.isEmpty {
                Divider()
                Text("À valider").font(.subheadline.weight(.semibold))
                ForEach(store.approvals.prefix(3)) { a in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top) {
                            LevelBadge(level: a.level)
                            Text(Wording.fr(a.summary)).font(.caption).lineLimit(3)
                        }
                        HStack {
                            Spacer()
                            Button("Refuser") { store.deny(a) }.controlSize(.small)
                            if a.needsPin {
                                Button("PIN…") { openDashboard() }.controlSize(.small)
                            } else {
                                Button("Approuver") { store.approve(a, pin: nil) { _ in } }.controlSize(.small).buttonStyle(.borderedProminent)
                            }
                        }
                    }
                }
            }

            if let t = store.costs?.today {
                Divider()
                HStack {
                    Text("Aujourd'hui : \(t.turns) req · \(Fmt.usd(t.costUsd)) équiv.").font(.caption)
                    Spacer()
                    if let q = store.quota.first(where: { $0.window == "five_hour" }), let u = q.utilization {
                        Text("quota 5 h \(Int(u * 100)) %").font(.caption).foregroundStyle(u > 0.85 ? .red : .secondary)
                    }
                }
            }

            Divider()
            HStack {
                if store.stopped {
                    Button("Reprendre…") { openDashboard() }
                } else {
                    Button(role: .destructive) { store.stop() } label: { Label("STOP", systemImage: "stop.fill") }
                        .tint(.red)
                        .buttonStyle(.borderedProminent)
                }
                Spacer()
                Button("Tableau de bord") { openDashboard() }.keyboardShortcut("d")
            }
            HStack {
                Text("Parler : maintiens ⌥Espace · STOP : ⌃⎋").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Quitter") { NSApp.terminate(nil) }.controlSize(.small)
            }
            Signature(text: store.signature)
        }
        .padding(14)
        .frame(width: 340)
    }

    private func openDashboard() {
        openWindow(id: "dashboard")
        NSApp.activate(ignoringOtherApps: true)
    }
}
