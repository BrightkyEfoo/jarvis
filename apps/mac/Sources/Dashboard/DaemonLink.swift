import Foundation

/// Request/response + streaming over jarvisd's Unix socket, routed by request id.
/// Same protocol and same permissions as the CLI: the dashboard bypasses nothing.
final class DaemonLink {
    typealias Message = [String: Any]

    private let path: String
    private var handle: FileHandle?
    private var buffer = Data()
    private var handlers: [String: (event: (Message) -> Void, done: (Result<Any?, LinkError>) -> Void)] = [:]
    var onDisconnect: () -> Void = {}

    struct LinkError: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    init(path: String) {
        self.path = path
    }

    var isConnected: Bool { handle != nil }

    func connect() -> Bool {
        if handle != nil { return true }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            return false
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
            return false
        }
        let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        h.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            DispatchQueue.main.async { data.isEmpty ? self?.drop() : self?.ingest(data) }
        }
        handle = h
        return true
    }

    private func drop() {
        handle?.readabilityHandler = nil
        handle = nil
        buffer.removeAll()
        let pending = handlers
        handlers.removeAll()
        for (_, h) in pending { h.done(.failure(LinkError(message: "jarvisd s'est déconnecté"))) }
        onDisconnect()
    }

    private func ingest(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let msg = try? JSONSerialization.jsonObject(with: line) as? Message, let id = msg["id"] as? String,
                  let h = handlers[id] else { continue }
            switch msg["type"] as? String {
            case "done":
                handlers[id] = nil
                h.done(.success(msg["data"]))
            case "error":
                handlers[id] = nil
                h.done(.failure(LinkError(message: msg["error"] as? String ?? "erreur")))
            default:
                h.event(msg)
            }
        }
    }

    @discardableResult
    func request(_ body: Message, onEvent: @escaping (Message) -> Void = { _ in }, done: @escaping (Result<Any?, LinkError>) -> Void = { _ in }) -> String? {
        guard connect() else {
            done(.failure(LinkError(message: "jarvisd ne tourne pas")))
            return nil
        }
        let id = String(UUID().uuidString.prefix(8)).lowercased()
        var msg = body
        msg["id"] = id
        guard var data = try? JSONSerialization.data(withJSONObject: msg) else { return nil }
        data.append(0x0A)
        handlers[id] = (onEvent, done)
        do {
            try handle?.write(contentsOf: data)
        } catch {
            handlers[id] = nil
            drop()
            done(.failure(LinkError(message: "écriture impossible")))
            return nil
        }
        return id
    }

    /// Decodes a `done` payload into a typed value.
    static func decode<T: Decodable>(_ type: T.Type, _ value: Any?) -> T? {
        guard let value, JSONSerialization.isValidJSONObject(value) || value is [Any] || value is [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
