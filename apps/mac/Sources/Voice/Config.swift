import Carbon.HIToolbox
import Foundation

/// Settings, overridable in <Jarvis root>/voice.json:
/// { "frVoice": "Thomas", "enVoice": "Daniel", "rate": 0.52, "hotkey": "option+space" }
struct VoiceConfig {
    var socketPath: String
    var frVoice = "Thomas"
    /// British, male: the Jarvis people expect.
    var enVoice = "Daniel"
    var rate: Float = 0.52
    /// "neural" (Parakeet + PocketTTS, once the models are on disk) or "system" (Apple).
    var engine = "neural"
    /// Hands-free: say "Jarvis, …" (microphone open, everything local).
    var wake = true
    /// The island under the notch (states, approvals, workers, quota).
    var island = true
    /// Playback speed of the neural voices (pitch kept): 1 = as generated.
    var speed: Float = 1.15
    var frNeural = VoiceCatalog.defaults["fr"] ?? "henri"
    var enNeural = VoiceCatalog.defaults["en"] ?? "charles"
    var keyCode = UInt32(kVK_Space)
    var modifiers = UInt32(optionKey)
    var hotkeyLabel = "⌥Espace"

    static var root: String {
        ProcessInfo.processInfo.environment["JARVIS_HOME"] ?? (NSHomeDirectory() + "/Library/Application Support/Jarvis")
    }

    /// Merges the voice choices into voice.json, keeping any other key Brightky set by hand.
    func save() {
        let path = Self.root + "/voice.json"
        var json = (FileManager.default.contents(atPath: path).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
        json["engine"] = engine
        json["wake"] = wake
        json["island"] = island
        json["speed"] = Double((speed * 100).rounded() / 100)
        json["frNeural"] = frNeural
        json["enNeural"] = enNeural
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? FileManager.default.createDirectory(atPath: Self.root, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600])
    }

    static func load() -> VoiceConfig {
        let env = ProcessInfo.processInfo.environment
        let root = env["JARVIS_HOME"] ?? (NSHomeDirectory() + "/Library/Application Support/Jarvis")
        var c = VoiceConfig(socketPath: root + "/run/jarvisd.sock")
        guard let data = FileManager.default.contents(atPath: root + "/voice.json"),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return c }
        if let v = json["frVoice"] as? String { c.frVoice = v }
        if let v = json["enVoice"] as? String { c.enVoice = v }
        if let v = json["rate"] as? Double { c.rate = Float(min(max(v, 0.3), 0.7)) }
        if let v = json["engine"] as? String, ["neural", "system"].contains(v) { c.engine = v }
        if let v = json["wake"] as? Bool { c.wake = v }
        if let v = json["island"] as? Bool { c.island = v }
        if let v = json["speed"] as? Double { c.speed = Float(min(max(v, 0.8), 1.6)) }
        if let v = json["frNeural"] as? String { c.frNeural = v }
        if let v = json["enNeural"] as? String { c.enNeural = v }
        if let v = json["hotkey"] as? String, let (mods, label) = parseModifiers(v) {
            c.modifiers = mods
            c.hotkeyLabel = label
        }
        return c
    }

    /// "control+option+space" → Carbon modifiers. The key itself is always Space.
    static func parseModifiers(_ spec: String) -> (UInt32, String)? {
        var mods: UInt32 = 0
        var label = ""
        for part in spec.lowercased().split(separator: "+") {
            switch part {
            case "control", "ctrl": mods |= UInt32(controlKey); label += "⌃"
            case "option", "alt": mods |= UInt32(optionKey); label += "⌥"
            case "command", "cmd": mods |= UInt32(cmdKey); label += "⌘"
            case "shift": mods |= UInt32(shiftKey); label += "⇧"
            case "space": break
            default: return nil
            }
        }
        return mods == 0 ? nil : (mods, label + "Espace")
    }
}
