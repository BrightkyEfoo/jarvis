import SwiftUI

/// N0…N4 badge, coloured by risk.
struct LevelBadge: View {
    let level: Int?

    var body: some View {
        if let level {
            Text("N\(level)")
                .font(.caption2.weight(.bold).monospacedDigit())
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .foregroundStyle(.white)
                .background(color(level), in: Capsule())
        }
    }

    private func color(_ l: Int) -> Color {
        switch l {
        case 0: return .gray
        case 1: return .blue
        case 2: return .orange
        case 3: return .red
        default: return .black
        }
    }
}

struct Card<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: systemImage)
                .font(.headline)
                .foregroundStyle(.secondary)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct Signature: View {
    var text: String

    var body: some View {
        Link(destination: URL(string: "https://brightkyefoo.cm")!) {
            Text(text.components(separatedBy: " — ").first ?? text)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .help("https://brightkyefoo.cm")
    }
}

struct VerdictText: View {
    let row: AuditRow

    var body: some View {
        let (text, color) = describe()
        Text(text).foregroundStyle(color)
    }

    private func describe() -> (String, Color) {
        switch (row.event, row.verdict, row.outcome) {
        case (_, "deny"?, _), (_, _, "refused"?): return ("refusé", .red)
        case ("intent", "confirm"?, _), ("intent", "confirm_pin"?, _): return ("en attente", .orange)
        case ("intent", "allow"?, _): return ("autorisé", .secondary)
        case ("approval", _, "approved"?): return ("approuvé · \(row.approval ?? "")", .green)
        case ("result", _, "ok"?): return ("fait", .green)
        case ("result", _, "error"?): return ("erreur", .red)
        default: return (row.outcome ?? row.verdict ?? "", .secondary)
        }
    }
}

extension AuditRow {
    var eventLabel: String {
        switch event {
        case "intent": return "Intention"
        case "result": return "Résultat"
        case "approval": return "Validation"
        case "llm": return "Modèle"
        case "system": return "Système"
        default: return event
        }
    }
}

/// Utilisation of one subscription window, with the forecast underneath.
struct QuotaRow: View {
    let q: QuotaWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(q.label).font(.subheadline)
                Spacer()
                Text(q.utilization.map { "\(Int($0 * 100)) %" } ?? q.status).monospacedDigit().foregroundStyle(.secondary)
            }
            ProgressView(value: min(q.utilization ?? 0, 1))
                .tint((q.utilization ?? 0) > 0.85 ? .red : (q.utilization ?? 0) > 0.6 ? .orange : .accentColor)
            Text(forecastText).font(.caption).foregroundStyle(q.forecast?.fullAt != nil ? .orange : .secondary)
        }
    }

    private var forecastText: String {
        let reset = ISO.parse(q.resetsAt).map { "réinitialisation \(Fmt.when($0))" } ?? ""
        if let full = ISO.parse(q.forecast?.fullAt) {
            return "À ce rythme : saturé vers \(Fmt.when(full)) · \(reset)"
        }
        return reset.isEmpty ? "pas encore de mesure" : "OK jusqu'à la \(reset)"
    }
}
