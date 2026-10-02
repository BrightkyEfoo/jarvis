import Foundation

/// Arbitrary JSON (audit `data` fields), decoded loosely for display.
enum JSONValue: Decodable, Hashable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    subscript(key: String) -> JSONValue? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    var string: String? {
        if case let .string(s) = self { return s }
        return nil
    }
}

struct DaemonStatus: Decodable, Hashable {
    struct PolicyInfo: Decodable, Hashable { let sha256: String; let sealed: Bool }
    struct SessionInfo: Decodable, Hashable { let id: String; let tainted: Bool }
    let stop: String?
    let devMode: Bool
    let policy: PolicyInfo
    let brain: String
    let session: SessionInfo?
    let startedAt: String
    let quotaWarning: String?
}

struct Approval: Decodable, Identifiable, Hashable {
    let id: String
    let tool: String
    let level: Int
    let rule: String
    let summary: String
    let reason: String
    let needsPin: Bool
    let tainted: Bool
    let externalDestinations: [String]
    let expiresAt: Double
}

struct AuditRow: Decodable, Identifiable, Hashable {
    let seq: Int
    let ts: String
    let event: String
    let tool: String?
    let level: Int?
    let rule: String?
    let verdict: String?
    let trigger: String?
    let origin: String?
    let tainted: Bool?
    let approval: String?
    let outcome: String?
    let durationMs: Double?
    let data: JSONValue?
    var id: Int { seq }

    var date: Date { ISO.parse(ts) ?? .distantPast }

    /// One readable line: what was attempted, or what happened.
    var headline: String {
        if let summary = data?["summary"]?.string { return Wording.fr(summary) }
        if let reason = data?["reason"]?.string { return reason }
        switch event {
        case "llm": return "Tour du modèle · \(outcome ?? "")"
        case "system": return "Système · \(outcome ?? "")"
        default: return [tool, outcome ?? verdict].compactMap { $0 }.joined(separator: " · ")
        }
    }
}

struct ModelUsageLine: Decodable, Hashable {
    let turns: Int
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let costUsd: Double
}

struct UsageSummary: Decodable, Hashable {
    let since: String
    let turns: Int
    let costUsd: Double
    let avgTtftMs: Double?
    let byModel: [String: ModelUsageLine]
}

struct Costs: Decodable, Hashable { let today: UsageSummary; let week: UsageSummary; let month: UsageSummary }

struct DayUsage: Decodable, Identifiable, Hashable {
    let day: String
    let turns: Int
    let costUsd: Double
    var id: String { day }
}

struct QuotaForecastInfo: Decodable, Hashable {
    let utilization: Double
    let resetsAt: String?
    let fullAt: String?
    let perHour: Double
}

struct QuotaWindow: Decodable, Identifiable, Hashable {
    let window: String
    let utilization: Double?
    let status: String
    let resetsAt: String?
    let forecast: QuotaForecastInfo?
    var id: String { window }

    var label: String {
        switch window {
        case "five_hour": return "Fenêtre 5 h"
        case "seven_day": return "Semaine"
        case "seven_day_opus": return "Semaine · Opus"
        case "seven_day_sonnet": return "Semaine · Sonnet"
        default: return window
        }
    }
}

struct Forecast: Decodable, Hashable { let monthCostUsd: Double; let turnsPerDay: Double }

struct MailAccount: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let email: String
    let connected: Bool
    let missing: String?
    let test: String?
}

struct Fact: Decodable, Identifiable, Hashable {
    let id: Int
    let kind: String
    let text: String
    let source: String
    let createdAt: String
}

struct MemoryInfo: Decodable, Hashable { let facts: [Fact]; let notesDir: String }
struct ToolInfo: Decodable, Identifiable, Hashable { let name: String; let description: String; var id: String { name } }

struct Snapshot: Decodable {
    let status: DaemonStatus
    let pendingApprovals: [Approval]
    let audit: [AuditRow]
    let costs: Costs
    let daily: [DayUsage]
    let quota: [QuotaWindow]
    let forecast: Forecast
    let mail: [MailAccount]
    /// GitHub / GitLab / Trello (absent from older daemons).
    var forges: [ForgeAccount]? = nil
    let memory: MemoryInfo
    let tools: [ToolInfo]
    let signature: String
}

struct ForgeAccount: Decodable, Identifiable, Hashable {
    let id: String
    let connected: Bool
    let connect: String
}

struct CalendarItem: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool
    let location: String?
    let attendees: Int
    let hasVideoLink: Bool
}

enum ISO {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }
}

enum Fmt {
    static let time: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR")
        f.dateFormat = "HH:mm:ss"
        return f
    }()
    static let dayTime: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR")
        f.dateFormat = "EEE d MMM HH:mm"
        return f
    }()
    /// Today: 14:05. Another day: jeu. 1 oct. 14:05.
    static func when(_ d: Date) -> String {
        Calendar.current.isDateInToday(d) ? String(dayTime.string(from: d).suffix(5)) : dayTime.string(from: d)
    }
    static let dayOfMonth: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    static func usd(_ v: Double) -> String { String(format: v < 1 ? "$%.3f" : "$%.2f", v) }
    static func tokens(_ n: Int) -> String { n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)" }
}
