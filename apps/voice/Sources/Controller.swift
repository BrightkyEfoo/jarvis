import AppKit
import AVFoundation
import Speech

/// Push-to-talk loop: hold the hotkey → listen → release → transcribe → ask jarvisd → speak each
/// sentence as it streams. Pressing again while Jarvis talks or thinks interrupts it (barge-in).
final class Controller {
    enum State { case idle, listening, transcribing, thinking, speaking }

    private let config: VoiceConfig
    private let listener = Listener()
    private let speaker: Speaker
    private let client: JarvisClient
    private var hotKey: HotKey?
    private var state = State.idle
    private var chunker = SpeechChunker()
    private var currentAsk: String?
    private var lang = "fr"

    // Latency, measured from the key release (the moment Brightky stops talking).
    private var tRelease = Date()
    private var tAsk = Date()
    private var sttMs = 0
    private var tFirstText: Date?
    private var tFirstAudio: Date?

    init(config: VoiceConfig) {
        self.config = config
        speaker = Speaker(config: config)
        client = JarvisClient(path: config.socketPath)
    }

    func start() {
        Permissions.request(microphone: true) { problem in
            if let problem {
                print("✖ \(problem)")
                exit(1)
            }
            guard let hotKey = HotKey(keyCode: self.config.keyCode, modifiers: self.config.modifiers) else {
                print("✖ raccourci \(self.config.hotkeyLabel) déjà pris par une autre app (voice.json → \"hotkey\")")
                exit(1)
            }
            hotKey.onPress = { [weak self] in self?.press() }
            hotKey.onRelease = { [weak self] in self?.release() }
            self.hotKey = hotKey
            self.client.onMessage = { [weak self] in self?.handle($0) }
            self.speaker.onFirstAudio = { [weak self] in
                if self?.tFirstAudio == nil { self?.tFirstAudio = Date() }
            }
            self.speaker.onIdle = { [weak self] in
                if self?.currentAsk == nil, self?.state == .speaking { self?.state = .idle }
            }
            self.listener.onPartial = { partial in
                print("\r\u{1B}[2K🎙 \(partial)", terminator: "")
                fflush(stdout)
            }
            Listener.warmUp { ms in print("reconnaissance locale préchauffée en \(ms) ms") }
            print("Jarvis Voice prêt — maintiens \(self.config.hotkeyLabel) pour parler (voix \(self.speaker.voiceNames)).")
            print("Reconnaissance 100 % locale (fr-FR, en-US) : aucun son ne quitte le Mac.")
        }
    }

    private func press() {
        if state == .speaking || state == .thinking { bargeIn() }
        guard state == .idle else { return }
        do {
            try listener.start(prefer: lang)
            state = .listening
            NSSound(named: "Tink")?.play()
        } catch {
            print("✖ micro : \(error.localizedDescription)")
        }
    }

    private func bargeIn() {
        speaker.stop()
        if currentAsk != nil {
            client.send(["id": shortId(), "cmd": "interrupt"])
            currentAsk = nil
        }
        chunker = SpeechChunker()
        state = .idle
        print("\n⏹ interrompu")
    }

    private func release() {
        guard state == .listening else { return }
        state = .transcribing
        tRelease = Date()
        NSSound(named: "Pop")?.play()
        listener.finish { [weak self] candidates in self?.transcribed(candidates) }
    }

    private func transcribed(_ candidates: [Candidate]) {
        sttMs = ms(since: tRelease)
        print("\r\u{1B}[2K", terminator: "")
        guard let pick = LanguagePick.choose(candidates, prefer: lang) else {
            print("(rien entendu)")
            state = .idle
            return
        }
        lang = pick.lang
        print("🗣 [\(pick.lang)] \(pick.text)")
        let id = shortId()
        currentAsk = id
        chunker = SpeechChunker()
        tAsk = Date()
        tFirstText = nil
        tFirstAudio = nil
        guard client.send(["id": id, "cmd": "ask", "text": pick.text, "trigger": "voice"]) else {
            currentAsk = nil
            say(lang == "fr" ? "Je n'arrive pas à joindre le daemon Jarvis." : "I can't reach the Jarvis daemon.")
            return
        }
        state = .thinking
    }

    private func handle(_ msg: [String: Any]) {
        // After a barge-in, whatever is still streaming for the old turn is dropped.
        guard let id = msg["id"] as? String, id == currentAsk else { return }
        switch msg["type"] as? String {
        case "text":
            let text = msg["text"] as? String ?? ""
            if tFirstText == nil { tFirstText = Date() }
            print(text, terminator: "")
            fflush(stdout)
            for sentence in chunker.push(text) { say(sentence) }
        case "tool":
            let name = (msg["name"] as? String ?? "").replacingOccurrences(of: "mcp__jarvis__", with: "")
            print("\n⚙ \(name)")
        case "approval":
            let request = msg["request"] as? [String: Any] ?? [:]
            let summary = request["summary"] as? String ?? ""
            print("\n⚠ validation requise : \(summary) → jarvis approvals")
            say(lang == "fr"
                ? "Validation requise. Confirme dans le terminal avec jarvis approvals."
                : "Approval needed. Confirm in the terminal with jarvis approvals.")
        case "done":
            for sentence in chunker.flush() { say(sentence) }
            let data = msg["data"] as? [String: Any] ?? [:]
            if data["ok"] as? Bool == false, tFirstText == nil {
                say(spokenError(data["error"] as? String ?? "error"))
            }
            currentAsk = nil
            logLatency(data)
            if !speaker.busy { state = .idle }
        case "error":
            currentAsk = nil
            say(spokenError(msg["error"] as? String ?? "error"))
        default:
            break
        }
    }

    private func say(_ sentence: String) {
        state = .speaking
        speaker.speak(sentence, lang: LanguagePick.replyLanguage(sentence, hint: lang))
    }

    private func spokenError(_ error: String) -> String {
        if error.contains("no Claude subscription token") {
            return lang == "fr" ? "Le token d'abonnement n'est pas configuré." : "The subscription token is not set up."
        }
        if error.contains("STOP") { return lang == "fr" ? "Jarvis est à l'arrêt." : "Jarvis is stopped." }
        if error == "interrupted" { return "" }
        return lang == "fr" ? "Je n'ai pas pu répondre." : "I couldn't answer."
    }

    private func logLatency(_ data: [String: Any]) {
        let first = tFirstText.map { "1er texte \(ms(from: tAsk, to: $0)) ms" } ?? "pas de texte"
        let voice = tFirstAudio.map { " · voix à +\(ms(from: tRelease, to: $0)) ms" } ?? ""
        let model = (data["model"] as? String).map { " · \($0.replacingOccurrences(of: "claude-", with: ""))" } ?? ""
        print("\n⏱ reconnaissance \(sttMs) ms · \(first)\(voice)\(model)")
    }

    private func shortId() -> String { String(UUID().uuidString.prefix(8)).lowercased() }
}

func ms(since d: Date) -> Int { Int(Date().timeIntervalSince(d) * 1000) }
func ms(from a: Date, to b: Date) -> Int { Int(b.timeIntervalSince(a) * 1000) }

enum Permissions {
    /// Speech recognition, then (optionally) the microphone. Calls back on the main queue with
    /// nil when granted, or a French explanation of what to change.
    static func request(microphone: Bool, done: @escaping (String?) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    return done("reconnaissance vocale refusée : Réglages Système › Confidentialité et sécurité › Reconnaissance vocale › Jarvis Voice")
                }
                guard microphone else { return done(nil) }
                AVCaptureDevice.requestAccess(for: .audio) { ok in
                    DispatchQueue.main.async {
                        done(ok ? nil : "micro refusé : Réglages Système › Confidentialité et sécurité › Micro › Jarvis Voice")
                    }
                }
            }
        }
    }
}
