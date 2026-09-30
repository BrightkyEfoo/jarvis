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
    var keyCode = UInt32(kVK_Space)
    var modifiers = UInt32(optionKey)
    var hotkeyLabel = "⌥Espace"

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
