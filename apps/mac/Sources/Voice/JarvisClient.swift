import Foundation

/// NDJSON over jarvisd's Unix socket: the same protocol as the `jarvis` CLI, same permissions.
final class JarvisClient {
    private let path: String
    private var handle: FileHandle?
    private var buffer = Data()
    var onMessage: ([String: Any]) -> Void = { _ in }

    init(path: String) {
        self.path = path
    }

    private func connect() -> Bool {
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
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else {
            close(fd)
            return false
        }
        let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        h.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            DispatchQueue.main.async {
                if data.isEmpty { self?.drop() } else { self?.ingest(data) }
            }
        }
        handle = h
        return true
    }

    private func drop() {
        handle?.readabilityHandler = nil
        handle = nil
        buffer.removeAll()
    }

    private func ingest(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { onMessage(obj) }
        }
    }

    /// Reconnects lazily: jarvisd may have been restarted since the last request.
    @discardableResult
    func send(_ message: [String: Any]) -> Bool {
        if handle == nil, !connect() { return false }
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return false }
        data.append(0x0A)
        do {
            try handle?.write(contentsOf: data)
            return true
        } catch {
            drop()
            return false
        }
    }
}
