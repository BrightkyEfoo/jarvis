import Foundation

/// Lets STOP / timeouts kill what is running for one request.
final class CancelToken {
    private let lock = NSLock()
    private var process: Process?
    private(set) var cancelled = false

    func attach(_ p: Process) {
        lock.lock(); defer { lock.unlock() }
        process = p
        if cancelled { p.terminate() }
    }

    func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        if process?.isRunning == true { process?.terminate() }
    }

    func check() throws {
        if cancelled { throw ActGuard.Refused(message: "annulé") }
    }
}

/// Runs a fixed JXA script through /usr/bin/osascript. Untrusted values only ever travel as argv
/// (`run(argv)`), never inside the script source, so nothing a page or a note says can become code.
/// Child processes of Jarvis.app are attributed to it by TCC: the Automation permission is Jarvis's.
enum Osa {
    static func run(_ script: String, args: [String], timeout: TimeInterval, cancel: CancelToken) throws -> String {
        try cancel.check()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-l", "JavaScript", "-e", script] + args
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        try p.run()
        cancel.attach(p)
        let timer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
        // Read before waiting: a big page would otherwise fill the pipe and deadlock.
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        timer.cancel()
        try cancel.check()
        guard p.terminationReason == .exit, p.terminationStatus == 0 else {
            if p.terminationReason == .uncaughtSignal { throw ActGuard.Refused(message: "délai dépassé (\(Int(timeout)) s)") }
            throw ActGuard.Refused(message: explain(String(decoding: errData, as: UTF8.self)))
        }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// osascript errors → what Brightky has to do.
    static func explain(_ stderr: String) -> String {
        let s = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.contains("-1743") {
            return "macOS n'autorise pas encore Jarvis à piloter cette app : Réglages Système › Confidentialité et sécurité › Automatisation › Jarvis"
        }
        if s.localizedCaseInsensitiveContains("JavaScript") && s.localizedCaseInsensitiveContains("Apple Events") {
            return "Active « Autoriser JavaScript depuis les événements Apple » (menu Affichage › Options pour les développeurs) dans le navigateur"
        }
        if s.contains("-600") || s.contains("-609") { return "l'app n'est pas ouverte" }
        // "execution error: Error: <message> (-2700)" → "<message>"
        if let r = s.range(of: #"Error: (.*?)( \(-?\d+\))?$"#, options: .regularExpression) {
            return String(s[r]).replacingOccurrences(of: "Error: ", with: "")
                .replacingOccurrences(of: #" \(-?\d+\)$"#, with: "", options: .regularExpression)
        }
        return s.isEmpty ? "échec AppleScript" : String(s.prefix(400))
    }
}
