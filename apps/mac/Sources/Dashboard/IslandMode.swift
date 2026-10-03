import Foundation

/// What the island under the notch shows, from the most urgent to the quietest. Pure, so it is
/// tested without a screen: STOP and a pending approval always win over the voice states.
enum IslandMode: Equatable {
    case hidden
    case stopped
    case approval(id: String)
    case acting(app: String)
    case listening
    case thinking
    case speaking
    case workers(count: Int)

    static func from(
        stopped: Bool,
        approvalIds: [String],
        acting: String?,
        voice: String,
        thinking: Bool,
        activeWorkers: Int
    ) -> IslandMode {
        if stopped { return .stopped }
        if let id = approvalIds.first { return .approval(id: id) }
        if let acting { return .acting(app: acting) }
        switch voice {
        case "listening", "transcribing": return .listening
        case "thinking": return .thinking
        case "speaking": return .speaking
        default: break
        }
        if thinking { return .thinking }
        if activeWorkers > 0 { return .workers(count: activeWorkers) }
        return .hidden
    }

    static func isActive(workerStatus: String) -> Bool {
        workerStatus == "queued" || workerStatus == "running"
    }
}
