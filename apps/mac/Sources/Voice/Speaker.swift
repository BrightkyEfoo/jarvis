import AVFoundation

/// Speaks sentence by sentence with the system voices already on the Mac.
/// Main-thread only (AppKit run loop): hence the unchecked Sendable.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, SpeechOutput, @unchecked Sendable {
    private let synth = AVSpeechSynthesizer()
    private let voices: [String: AVSpeechSynthesisVoice]
    private let rate: Float
    private var queued = 0
    var onFirstAudio: () -> Void = {}
    var onIdle: () -> Void = {}

    init(config: VoiceConfig) {
        voices = [
            "fr": Self.bestVoice(named: config.frVoice, language: "fr"),
            "en": Self.bestVoice(named: config.enVoice, language: "en"),
        ].compactMapValues { $0 }
        rate = config.rate
        super.init()
        synth.delegate = self
    }

    /// Prefers the Premium/Enhanced variant of the chosen voice when installed (e.g. downloaded
    /// later on Wi-Fi), then the compact one, then any voice of the language.
    static func bestVoice(named name: String, language: String) -> AVSpeechSynthesisVoice? {
        let all = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(language) }
        let named = all.filter { $0.name == name || $0.name.hasPrefix(name + " ") }
        return named.max { $0.quality.rawValue < $1.quality.rawValue }
            ?? all.max { $0.quality.rawValue < $1.quality.rawValue }
    }

    var voiceNames: String {
        voices.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value.name)" }.joined(separator: ", ")
    }

    var busy: Bool { queued > 0 }

    func speak(_ text: String, lang: String) {
        let u = AVSpeechUtterance(string: text)
        u.voice = voices[lang] ?? voices["fr"]
        u.rate = rate
        u.preUtteranceDelay = 0
        queued += 1
        synth.speak(u)
    }

    func stop() {
        synth.stopSpeaking(at: .immediate)
        queued = 0
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        onFirstAudio()
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        queued = max(0, queued - 1)
        if queued == 0 { onIdle() }
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        queued = max(0, queued - 1)
        if queued == 0 { onIdle() }
    }
}
