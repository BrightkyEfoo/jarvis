import AppKit

/// Jarvis.app's hands. Connects to jarvisd, registers as the actuator, and runs the actions the
/// daemon has already cleared with its policy (and, for N2, with Brightky). One action at a time.
final class Actuator {
    static let version = "0.7.0"
    static let capabilities = ["browser", "notes", "reminders", "screen"]

    private let path: String
    private let work = DispatchQueue(label: "cm.brightkyefoo.jarvis.actuator")
    private let io = DispatchQueue(label: "cm.brightkyefoo.jarvis.actuator.io")
    private let lock = NSLock()
    private var handle: FileHandle?
    private var buffer = Data()
    private var tokens: [String: CancelToken] = [:]
    private let screen = ScreenActor()
    private var timer: Timer?
    /// Main thread: app name while acting, nil when idle (menu bar indicator).
    var onActing: (String?) -> Void = { _ in }
    var onConnection: (Bool) -> Void = { _ in }

    init(socketPath: String) {
        path = socketPath
    }

    func start() {
        connect()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.connect() }
    }

    func cancelAll() {
        lock.lock()
        let all = tokens.values
        lock.unlock()
        all.forEach { $0.cancel() }
    }

    private var connected: Bool {
        lock.lock(); defer { lock.unlock() }
        return handle != nil
    }

    private func connect() {
        guard !connected else { return }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            return
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard rc == 0 else {
            close(fd)
            return
        }
        let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        lock.lock()
        handle = h
        lock.unlock()
        h.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            self?.io.async { data.isEmpty ? self?.drop() : self?.ingest(data) }
        }
        send(["id": "actuator", "cmd": "actuator_register", "version": Self.version, "capabilities": Self.capabilities])
    }

    private func drop() {
        lock.lock()
        handle?.readabilityHandler = nil
        handle = nil
        lock.unlock()
        buffer.removeAll()
        cancelAll()
        DispatchQueue.main.async { self.onConnection(false) }
    }

    private func ingest(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let msg = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            switch msg["type"] as? String {
            case "event":
                DispatchQueue.main.async { self.onConnection(true) }
            case "actuate_cancel":
                if let id = msg["reqId"] as? String {
                    lock.lock()
                    let t = tokens[id]
                    lock.unlock()
                    t?.cancel()
                }
            case "actuate":
                guard let id = msg["reqId"] as? String, let action = msg["action"] as? [String: Any] else { continue }
                let token = CancelToken()
                lock.lock()
                tokens[id] = token
                lock.unlock()
                work.async { self.run(id, action, token) }
            default:
                continue
            }
        }
    }

    private func run(_ id: String, _ action: [String: Any], _ token: CancelToken) {
        let kind = action["kind"] as? String ?? ""
        let shown = (action["app"] as? String) ?? (action["browser"] as? String)
            ?? (kind.hasPrefix("notes") ? "Notes" : kind.hasPrefix("reminders") ? "Rappels" : nil)
        DispatchQueue.main.async { self.onActing(shown) }
        var reply: [String: Any] = ["id": "actuator", "cmd": "actuator_result", "reqId": id]
        do {
            try token.check()
            reply["result"] = try perform(kind, action, token)
            reply["ok"] = true
        } catch {
            reply["ok"] = false
            reply["error"] = String(error.localizedDescription.prefix(3000))
        }
        lock.lock()
        tokens[id] = nil
        lock.unlock()
        DispatchQueue.main.async { self.onActing(nil) }
        send(reply)
    }

    private func perform(_ kind: String, _ a: [String: Any], _ token: CancelToken) throws -> Any {
        switch kind {
        case _ where kind.hasPrefix("browser."):
            return try Browser.perform(kind: kind, a, cancel: token)
        case _ where kind.hasPrefix("notes.") || kind.hasPrefix("reminders."):
            var args = a
            args["kind"] = nil
            return try AppScripts.perform(kind: kind, args, cancel: token)
        case "screen.look":
            return try screen.look(app: a["app"] as? String, cancel: token)
        case "screen.probe":
            guard let app = a["app"] as? String else { throw ActGuard.Refused(message: "app manquante") }
            return try screen.probe(app: app, element: a["element"] as? Int, x: a["x"] as? Int, y: a["y"] as? Int)
        case "screen.act":
            try screen.act(a, cancel: token)
            return [String: Any]()
        default:
            throw ActGuard.Refused(message: "action inconnue \(kind)")
        }
    }

    private func send(_ msg: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        data.append(0x0A)
        lock.lock()
        let h = handle
        lock.unlock()
        do {
            try h?.write(contentsOf: data)
        } catch {
            io.async { self.drop() }
        }
    }
}
