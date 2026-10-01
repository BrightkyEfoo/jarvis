import Charts
import SwiftUI

enum DashboardSection: String, CaseIterable, Identifiable {
    case overview, activity, approvals, costs, forecast, memory, accounts, settings
    var id: Self { self }

    var title: String {
        switch self {
        case .overview: return "Vue d'ensemble"
        case .activity: return "Activité"
        case .approvals: return "Validations"
        case .costs: return "Coûts & quota"
        case .forecast: return "Prévisions"
        case .memory: return "Mémoire"
        case .accounts: return "Comptes"
        case .settings: return "Réglages"
        }
    }

    var icon: String {
        switch self {
        case .overview: return "gauge.with.dots.needle.33percent"
        case .activity: return "list.bullet.rectangle"
        case .approvals: return "checkmark.shield"
        case .costs: return "chart.bar.xaxis"
        case .forecast: return "calendar.badge.clock"
        case .memory: return "brain"
        case .accounts: return "person.crop.circle.badge.checkmark"
        case .settings: return "gearshape"
        }
    }
}

struct DashboardView: View {
    @EnvironmentObject var store: Store
    @State var section: DashboardSection? = .overview

    var body: some View {
        NavigationSplitView {
            List(DashboardSection.allCases, selection: $section) { s in
                Label(s.title, systemImage: s.icon)
                    .badge(s == .approvals ? store.approvals.count : 0)
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 6) {
                    ConnectionPill()
                    Signature(text: store.signature)
                }
                .padding(12)
            }
        } detail: {
            VStack(spacing: 0) {
                if store.stopped { StopBanner() }
                SectionView(section: section ?? .overview)
            }
        }
        .frame(minWidth: 980, minHeight: 640)
    }
}

struct SectionView: View {
    let section: DashboardSection

    var body: some View {
        switch section {
        case .overview: OverviewView()
        case .activity: ActivityView()
        case .approvals: ApprovalsView()
        case .costs: CostsView()
        case .forecast: ForecastView()
        case .memory: MemoryView()
        case .accounts: AccountsView()
        case .settings: SettingsView()
        }
    }
}

struct ConnectionPill: View {
    @EnvironmentObject var store: Store

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(store.connected ? (store.stopped ? .red : .green) : .gray).frame(width: 8, height: 8)
            Text(store.connected ? (store.stopped ? "STOP" : "jarvisd connecté") : "jarvisd hors ligne")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct StopBanner: View {
    @EnvironmentObject var store: Store
    @State private var pin = ""
    @State private var error: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "stop.circle.fill").font(.title2)
            VStack(alignment: .leading) {
                Text("Jarvis est à l'arrêt (STOP)").font(.headline)
                Text(store.status?.stop ?? "").font(.caption)
                if let error { Text(error).font(.caption).foregroundStyle(.yellow) }
            }
            Spacer()
            SecureField("PIN", text: $pin).frame(width: 110).textFieldStyle(.roundedBorder)
            Button("Reprendre") {
                store.resume(pin: pin) { e in
                    error = e
                    if e == nil { pin = "" }
                }
            }
            .disabled(pin.count < 6)
        }
        .padding(12)
        .foregroundStyle(.white)
        .background(.red.gradient)
    }
}

// MARK: - Overview

struct OverviewView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
                Card(title: "État", systemImage: "power") {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(store.stopped ? "À l'arrêt" : store.connected ? "Actif" : "Hors ligne")
                                .font(.title2.weight(.semibold))
                            Text(policyLine).font(.caption).foregroundStyle(.secondary)
                            if store.status?.session?.tainted == true {
                                Label("Contenu externe dans la conversation", systemImage: "exclamationmark.triangle")
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        }
                        Spacer()
                        if !store.stopped {
                            Button(role: .destructive) { store.stop() } label: {
                                Label("STOP", systemImage: "stop.fill").frame(minWidth: 80)
                            }
                            .controlSize(.large)
                            .buttonStyle(.borderedProminent)
                            .tint(.red)
                            .keyboardShortcut(".", modifiers: .command)
                        }
                    }
                }
                Card(title: "En direct", systemImage: "waveform") {
                    Text(store.activity).lineLimit(2)
                    Text("Voix : \(voiceLabel)").font(.caption).foregroundStyle(.secondary)
                }
                Card(title: "Validations en attente", systemImage: "checkmark.shield") {
                    if store.approvals.isEmpty {
                        Text("Rien à valider").foregroundStyle(.secondary)
                    } else {
                        ForEach(store.approvals.prefix(3)) { a in
                            HStack(alignment: .top) {
                                LevelBadge(level: a.level)
                                Text(Wording.fr(a.summary)).lineLimit(2).font(.callout)
                            }
                        }
                        Text("Voir l'onglet Validations").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Card(title: "Aujourd'hui", systemImage: "sun.max") {
                    if let t = store.costs?.today {
                        HStack(alignment: .firstTextBaseline, spacing: 18) {
                            stat("\(t.turns)", "requêtes")
                            stat(Fmt.usd(t.costUsd), "équivalent API")
                            stat(t.avgTtftMs.map { "\(Int($0)) ms" } ?? "—", "1er mot moyen")
                        }
                        Text("Payé : abonnement Max, 0 € en plus").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Card(title: "Quota de l'abonnement", systemImage: "chart.bar") {
                    if store.quota.isEmpty {
                        Text("Pas encore de mesure (arrive avec la première requête)").foregroundStyle(.secondary)
                    }
                    ForEach(store.quota) { QuotaRow(q: $0) }
                }
                Card(title: "À venir", systemImage: "calendar") {
                    if store.upcoming.isEmpty {
                        Text(store.upcomingNote ?? "Rien d'ici demain soir").foregroundStyle(.secondary)
                    }
                    ForEach(store.upcoming.prefix(4)) { e in
                        HStack {
                            Text(ISO.parse(e.start).map { Fmt.when($0) } ?? e.start)
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            Text(e.title).lineLimit(1)
                        }
                    }
                }
            }
            .padding(16)

            Card(title: "Dernières actions", systemImage: "clock.arrow.circlepath") {
                ForEach(store.audit.prefix(10)) { AuditLine(row: $0) }
            }
            .padding([.horizontal, .bottom], 16)
        }
        .navigationTitle("Vue d'ensemble")
    }

    private var policyLine: String {
        guard let s = store.status else { return "" }
        return "Politique \(s.policy.sealed ? "scellée" : "non scellée (dev)") · \(s.policy.sha256)"
    }

    private var voiceLabel: String {
        switch store.voice {
        case .off: return "désactivée"
        case .idle: return "prête (maintiens ⌥Espace)"
        case .listening: return "écoute…"
        case .transcribing: return "transcription…"
        case .thinking: return "réfléchit…"
        case .speaking: return "parle"
        case .confirming: return "attend ta confirmation"
        }
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading) {
            Text(value).font(.title3.weight(.semibold).monospacedDigit())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct AuditLine: View {
    let row: AuditRow

    var body: some View {
        HStack(spacing: 8) {
            Text(Fmt.when(row.date)).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
            LevelBadge(level: row.level)
            Text(row.headline).lineLimit(1)
            Spacer()
            VerdictText(row: row).font(.caption)
        }
    }
}

// MARK: - Activity

struct ActivityView: View {
    @EnvironmentObject var store: Store
    @State private var filter = "all"
    @State private var onlyRefused = false
    @State private var search = ""

    private var rows: [AuditRow] {
        store.audit.filter { r in
            (filter == "all" || r.event == filter)
                && (!onlyRefused || r.verdict == "deny" || r.outcome == "refused")
                && (search.isEmpty || r.headline.localizedCaseInsensitiveContains(search) || (r.tool ?? "").contains(search) || (r.rule ?? "").contains(search))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Type", selection: $filter) {
                    Text("Tout").tag("all")
                    Text("Intentions").tag("intent")
                    Text("Résultats").tag("result")
                    Text("Validations").tag("approval")
                    Text("Modèle").tag("llm")
                    Text("Système").tag("system")
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 520)
                Toggle("Refus seulement", isOn: $onlyRefused)
                Spacer()
                TextField("Rechercher", text: $search).textFieldStyle(.roundedBorder).frame(width: 200)
            }
            .padding(12)
            Table(rows) {
                TableColumn("Heure") { Text(Fmt.when($0.date)).monospacedDigit() }.width(min: 60, ideal: 110)
                TableColumn("Type") { Text($0.eventLabel) }.width(80)
                TableColumn("Niv.") { LevelBadge(level: $0.level) }.width(40)
                TableColumn("Outil") { Text($0.tool ?? "—") }.width(110)
                TableColumn("Décision") { VerdictText(row: $0) }.width(130)
                TableColumn("Détail") { Text($0.headline).help($0.rule ?? "") }
                TableColumn("Règle") { Text($0.rule ?? "").foregroundStyle(.secondary) }.width(min: 90, ideal: 140)
            }
            HStack {
                Text("\(rows.count) entrées · journal chaîné par hash (jarvis audit verify)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Charger plus") { store.loadMoreAudit() }.disabled(store.auditExhausted)
            }
            .padding(10)
        }
        .navigationTitle("Activité")
    }
}

// MARK: - Approvals

struct ApprovalsView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if store.approvals.isEmpty {
                    ContentUnavailableView("Rien à valider", systemImage: "checkmark.shield", description: Text("Les actions qui parlent en ton nom (N2) ou sensibles (N3) apparaîtront ici."))
                        .frame(maxWidth: .infinity, minHeight: 220)
                }
                ForEach(store.approvals) { ApprovalCard(approval: $0) }
                Card(title: "Historique des validations", systemImage: "clock") {
                    ForEach(store.audit.filter { $0.event == "approval" }.prefix(30)) { AuditLine(row: $0) }
                }
            }
            .padding(16)
        }
        .navigationTitle("Validations")
    }
}

struct ApprovalCard: View {
    @EnvironmentObject var store: Store
    let approval: Approval
    @State private var pin = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                LevelBadge(level: approval.level)
                Text(approval.tool).font(.headline)
                Spacer()
                Text("expire à \(Fmt.time.string(from: Date(timeIntervalSince1970: approval.expiresAt / 1000)))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(Wording.fr(approval.summary)).textSelection(.enabled)
            Text("\(approval.reason) · règle \(approval.rule)").font(.caption).foregroundStyle(.secondary)
            if approval.tainted {
                Label("La conversation contient du contenu externe (mail, web…)", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            }
            if !approval.externalDestinations.isEmpty {
                Label("Destination trouvée dans un contenu externe : \(approval.externalDestinations.joined(separator: ", "))", systemImage: "exclamationmark.octagon")
                    .foregroundStyle(.red)
            }
            if let error { Text(error).foregroundStyle(.red).font(.caption) }
            HStack {
                Spacer()
                Button("Refuser", role: .destructive) { store.deny(approval) }
                if approval.needsPin {
                    SecureField("PIN", text: $pin).frame(width: 110).textFieldStyle(.roundedBorder)
                }
                Button(approval.needsPin ? "Approuver avec le PIN" : "Approuver") {
                    store.approve(approval, pin: approval.needsPin ? pin : nil) { e in error = e }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(approval.needsPin && pin.count < 6)
            }
        }
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(approval.level >= 3 ? .red.opacity(0.5) : .orange.opacity(0.4)))
    }
}

// MARK: - Costs

struct CostsView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let c = store.costs {
                    HStack(spacing: 16) {
                        tile("Aujourd'hui", c.today)
                        tile("7 jours", c.week)
                        tile("Ce mois", c.month)
                    }
                }
                Card(title: "Consommation par jour (équivalent API, 30 jours)", systemImage: "chart.bar.xaxis") {
                    Chart(store.daily) { d in
                        BarMark(x: .value("Jour", Fmt.dayOfMonth.date(from: d.day) ?? .now, unit: .day), y: .value("USD", d.costUsd))
                            .foregroundStyle(.tint)
                    }
                    .chartXAxis {
                        AxisMarks(values: .stride(by: .day, count: 5)) { _ in
                            AxisGridLine()
                            AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                        }
                    }
                    .frame(height: 220)
                    Text("Équivalent au tarif API : tu ne paies que ton abonnement.").font(.caption).foregroundStyle(.secondary)
                }
                Card(title: "Par modèle (ce mois)", systemImage: "cpu") {
                    ForEach(Array((store.costs?.month.byModel ?? [:]).sorted { $0.value.costUsd > $1.value.costUsd }), id: \.key) { model, u in
                        HStack {
                            Text(model.replacingOccurrences(of: "claude-", with: "")).frame(width: 140, alignment: .leading)
                            Text("\(u.turns) req").frame(width: 70, alignment: .trailing)
                            Text("\(Fmt.tokens(u.inputTokens + u.cacheReadTokens)) in (\(Fmt.tokens(u.cacheReadTokens)) cache)").frame(width: 200, alignment: .trailing)
                            Text("\(Fmt.tokens(u.outputTokens)) out").frame(width: 90, alignment: .trailing)
                            Spacer()
                            Text(Fmt.usd(u.costUsd)).monospacedDigit()
                        }
                        .font(.callout.monospacedDigit())
                    }
                }
                Card(title: "Quota de l'abonnement", systemImage: "gauge") {
                    if store.quota.isEmpty { Text("Pas encore de mesure").foregroundStyle(.secondary) }
                    ForEach(store.quota) { QuotaRow(q: $0) }
                }
            }
            .padding(16)
        }
        .navigationTitle("Coûts & quota")
    }

    private func tile(_ title: String, _ u: UsageSummary) -> some View {
        Card(title: title, systemImage: "sum") {
            Text(Fmt.usd(u.costUsd)).font(.title.weight(.semibold).monospacedDigit())
            Text("\(u.turns) requêtes · \(u.avgTtftMs.map { "1er mot \(Int($0)) ms" } ?? "—")").font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Forecast

struct ForecastView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Card(title: "Quota : à ce rythme", systemImage: "speedometer") {
                    if store.quota.isEmpty { Text("Pas encore de mesure").foregroundStyle(.secondary) }
                    ForEach(store.quota) { QuotaRow(q: $0) }
                }
                Card(title: "Projection du mois", systemImage: "chart.line.uptrend.xyaxis") {
                    if let f = store.forecast {
                        Text("\(Fmt.usd(f.monthCostUsd)) d'équivalent API d'ici la fin du mois").font(.title3)
                        Text(String(format: "%.0f requêtes par jour en moyenne · couvert par l'abonnement", f.turnsPerDay))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Card(title: "Agenda (aujourd'hui et demain)", systemImage: "calendar") {
                    if store.upcoming.isEmpty { Text(store.upcomingNote ?? "Rien de prévu").foregroundStyle(.secondary) }
                    ForEach(store.upcoming) { e in
                        HStack(alignment: .top) {
                            Text(e.allDay ? "journée" : (ISO.parse(e.start).map { Fmt.when($0) } ?? ""))
                                .font(.callout.monospacedDigit()).foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
                            VStack(alignment: .leading) {
                                Text(e.title)
                                Text([e.attendees > 0 ? "\(e.attendees) participant(s)" : nil, e.hasVideoLink ? "visio" : nil, e.location]
                                    .compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button("Actualiser") { store.loadUpcoming() }.controlSize(.small)
                }
                Card(title: "Travail en file", systemImage: "hammer") {
                    Text(store.approvals.isEmpty ? "Aucune action en attente de ta validation." : "\(store.approvals.count) action(s) attendent ta validation.")
                    Text("Workers de code (Sprint 6) et mode nuit (Sprint 11) apparaîtront ici.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(16)
        }
        .navigationTitle("Prévisions")
    }
}

// MARK: - Memory, accounts, settings

struct MemoryView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        List {
            Section {
                ForEach(store.facts) { f in
                    HStack(alignment: .top) {
                        Text(f.kind).font(.caption).padding(.horizontal, 6).background(.quaternary, in: Capsule())
                        if f.source == "external" {
                            Text("externe").font(.caption).foregroundStyle(.orange)
                        }
                        Text(f.text).textSelection(.enabled)
                        Spacer()
                        Button("Oublier") { store.forget(f) }.controlSize(.small)
                    }
                }
            } header: {
                HStack {
                    Text("Ce que Jarvis retient (\(store.facts.count))")
                    Spacer()
                    Button("Ouvrir mes notes") { NSWorkspace.shared.open(URL(fileURLWithPath: store.notesDir)) }
                }
            }
        }
        .navigationTitle("Mémoire")
    }
}

struct AccountsView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        List {
            Section("Boîtes mail") {
                ForEach(store.mail) { a in
                    HStack {
                        Image(systemName: a.connected ? "checkmark.circle.fill" : "xmark.circle").foregroundStyle(a.connected ? .green : .secondary)
                        VStack(alignment: .leading) {
                            Text("\(a.id) · \(a.email)")
                            Text(a.test ?? (a.connected ? "\(a.type) connecté" : (a.missing ?? ""))).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Button("Tester les connexions") { store.testMail() }
            }
            Section("Outils de Jarvis (\(store.tools.count))") {
                ForEach(store.tools) { t in
                    VStack(alignment: .leading) {
                        Text(t.name).font(.body.monospaced())
                        Text(t.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
        .navigationTitle("Comptes")
    }
}

struct SettingsView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        Form {
            Section("Daemon") {
                LabeledContent("Politique", value: store.status.map { "\($0.policy.sealed ? "scellée" : "dev") · \($0.policy.sha256)" } ?? "—")
                LabeledContent("Démarré", value: ISO.parse(store.status?.startedAt).map { Fmt.dayTime.string(from: $0) } ?? "—")
                LabeledContent("Cerveau", value: store.status?.brain == "ready" ? "prêt (abonnement)" : "token d'abonnement manquant")
                Button("Nouvelle conversation (efface le contexte)") { store.newSession() }
                Button("Ouvrir les logs") { NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs/Jarvis")) }
            }
            Section("Voix") {
                LabeledContent("Raccourci", value: VoiceConfig.load().hotkeyLabel)
                LabeledContent("Voix", value: "\(VoiceConfig.load().frVoice) (FR) · \(VoiceConfig.load().enVoice) (EN)")
                Text("Réglables dans ~/Library/Application Support/Jarvis/voice.json").font(.caption).foregroundStyle(.secondary)
            }
            Section("Sécurité") {
                Text("Les règles (N0–N4) se changent uniquement dans policy.yaml, scellée par toi. Le tableau de bord ne peut rien débloquer : il passe par les mêmes contrôles que la CLI.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Réglages")
    }
}
