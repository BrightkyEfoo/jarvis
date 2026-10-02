import AppKit
import AVFoundation
import Speech

/// Push-to-talk loop: hold the hotkey → listen → release → transcribe → ask jarvisd → speak each
/// sentence as it streams. Pressing again while Jarvis talks or thinks interrupts it (barge-in).
final class Controller {
    enum State: String { case idle, listening, transcribing, thinking, speaking, confirming }

    /// Reported to the menu bar icon and the dashboard.
    var onState: (String) -> Void = { _ in }

    private let config: VoiceConfig
    private var listener: SpeechInput = Listener()
    private var speaker: SpeechOutput
    /// Neural stack waiting for an idle moment to replace the system voices.
    private var pendingNeural: NeuralStack?
    var onEngine: (String) -> Void = { _ in }
    private let client: JarvisClient
    private var hotKey: HotKey?
    private var state = State.idle {
        didSet {
            guard state != oldValue else { return }
            onState(state.rawValue)
            updateWake()
            if state == .idle { DispatchQueue.main.async { self.adoptNeuralIfIdle() } }
        }
    }
    /// Hands-free "Jarvis, …" (neural engine only).
    private var wake: WakeWatcher?
    private var chunker = SpeechChunker()
    private var currentAsk: String?
    private var lang = "fr"
    /// N2 approval waiting for a spoken yes/no (N3 never: PIN in the terminal).
    private var pendingApproval: String?
    private var confirmTries = 0
    private var listeningForAnswer = false

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
            self.wire()
            Listener.warmUp { ms in print("reconnaissance locale préchauffée en \(ms) ms") }
            print("Jarvis Voice prêt — maintiens \(self.config.hotkeyLabel) pour parler (voix \(self.speaker.voiceNames)).")
            print("Reconnaissance 100 % locale : aucun son ne quitte le Mac.")
            if self.config.engine == "neural" { self.loadNeural() }
        }
    }

    private func wire() {
        speaker.onFirstAudio = { [weak self] in
            if self?.tFirstAudio == nil { self?.tFirstAudio = Date() }
        }
        speaker.onIdle = { [weak self] in
            guard let self else { return }
            if self.state == .speaking {
                if self.pendingApproval != nil { self.state = .confirming } else if self.currentAsk == nil { self.state = .idle }
            }
            self.adoptNeuralIfIdle()
        }
        listener.onPartial = { partial in
            print("\r\u{1B}[2K🎙 \(partial)", terminator: "")
            fflush(stdout)
        }
        onEngine("\(listener.engineName) · \(speaker.voiceNames)")
    }

    /// Parakeet + PocketTTS load in the background (CoreML compiles them once per machine, which
    /// can take minutes); the system voices keep working meanwhile.
    private func loadNeural() {
        let fr = config.frNeural, en = config.enNeural
        Task.detached {
            do {
                let stack = try await NeuralStack.load(fr: fr, en: en) { line in print("🧠 \(line)") }
                await MainActor.run {
                    self.pendingNeural = stack
                    self.adoptNeuralIfIdle()
                }
            } catch {
                print("⚠ voix neuronales indisponibles (\(error.localizedDescription)) : voix système conservées")
            }
        }
    }

    private func adoptNeuralIfIdle() {
        guard let stack = pendingNeural, state == .idle, !speaker.busy else { return }
        pendingNeural = nil
        let system = speaker
        speaker = NeuralSpeaker(stack: stack, fallback: system, rate: config.rate)
        listener.cancel()
        listener = NeuralListener(asr: stack.asr)
        wire()
        print("🧠 voix neuronales actives : \(speaker.voiceNames)")
        if config.wake { startWake(stack) }
    }

    private func startWake(_ stack: NeuralStack) {
        Task.detached {
            do {
                let w = try await WakeWatcher.make(asr: stack.asr)
                await MainActor.run {
                    w.onCommand = { [weak self] text, lang in
                        print("👂 [\(lang)] \(text)")
                        self?.heardHandsFree(text, lang: lang)
                    }
                    w.onArmed = { [weak self] in
                        guard let self, self.state == .idle else { return }
                        NSSound(named: "Tink")?.play()
                        self.onState("listening")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { if self.state == .idle { self.onState("idle") } }
                    }
                    do {
                        try w.start()
                        self.wake = w
                        self.updateWake()
                        print("👂 mains libres : dis « Jarvis, … » (⌥Espace marche toujours)")
                        self.onEngine("\(self.listener.engineName) · mains libres « Jarvis » · \(self.speaker.voiceNames)")
                    } catch {
                        print("⚠ mains libres indisponibles : \(error.localizedDescription)")
                    }
                }
            } catch {
                print("⚠ mains libres indisponibles : \(error.localizedDescription)")
            }
        }
    }

    /// The hands-free ear is shut while Jarvis listens by key, thinks or speaks (it must not hear
    /// itself); during a spoken confirmation it accepts "oui / non" without the name.
    private func updateWake() {
        guard let wake else { return }
        wake.prefer = lang
        switch state {
        case .idle:
            wake.suspended = speaker.busy
        case .confirming:
            wake.suspended = false
            wake.arm(for: 12)
        default:
            wake.suspended = true
        }
    }

    private func press() {
        // While Jarvis asks "tu confirmes ?", the key answers instead of interrupting.
        let answering = pendingApproval != nil && (state == .confirming || state == .speaking)
        if answering {
            speaker.stop()
        } else {
            if state == .speaking || state == .thinking { bargeIn() }
            guard state == .idle else { return }
        }
        do {
            try listener.start(prefer: lang)
            listeningForAnswer = answering
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
        pendingApproval = nil
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
        let answering = listeningForAnswer
        listeningForAnswer = false
        guard let pick = LanguagePick.choose(candidates, prefer: lang) else {
            print("(rien entendu)")
            state = answering ? .confirming : .idle
            return
        }
        if answering {
            answer(pick.text)
            return
        }
        send(pick)
    }

    /// Something said hands-free ("Jarvis, …"): an answer to a pending confirmation, or a request.
    private func heardHandsFree(_ text: String, lang heardLang: String) {
        guard state == .idle || state == .confirming else { return }
        tRelease = Date()
        sttMs = 0
        if pendingApproval != nil, state == .confirming {
            answer(text)
            return
        }
        guard state == .idle else { return }
        NSSound(named: "Pop")?.play()
        send(Candidate(lang: heardLang, text: text, confidence: 1))
    }

    private func send(_ pick: Candidate) {
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
            askConfirmation(msg["request"] as? [String: Any] ?? [:])
        case "approval_resolved":
            // Answered elsewhere (terminal, timeout, STOP): stop waiting for a spoken answer.
            if let approvalId = msg["approvalId"] as? String, approvalId == pendingApproval {
                pendingApproval = nil
                if state == .confirming { state = .thinking }
            }
        case "done":
            for sentence in chunker.flush() { say(sentence) }
            let data = msg["data"] as? [String: Any] ?? [:]
            if data["ok"] as? Bool == false, tFirstText == nil {
                say(spokenError(data["error"] as? String ?? "error"))
            }
            currentAsk = nil
            logLatency(data)
            if !speaker.busy {
                state = .idle
                adoptNeuralIfIdle()
            }
        case "error":
            currentAsk = nil
            say(spokenError(msg["error"] as? String ?? "error"))
        default:
            break
        }
    }

    private func askConfirmation(_ request: [String: Any]) {
        let summary = request["summary"] as? String ?? ""
        print("\n⚠ validation requise : \(summary)")
        if request["needsPin"] as? Bool == true {
            say(lang == "fr"
                ? "Action sensible : elle se valide avec ton PIN, dans le terminal, jarvis approvals."
                : "Sensitive action: approve it with your PIN in the terminal, jarvis approvals.")
            return
        }
        guard let approvalId = request["id"] as? String else { return }
        pendingApproval = approvalId
        confirmTries = 0
        let external = (request["externalDestinations"] as? [String] ?? []).isEmpty == false
        for s in SpeechChunker.collect(Confirmation.spoken(summary, lang: lang)) { say(s) }
        if external {
            say(lang == "fr" ? "Attention : ce destinataire vient d'un contenu externe." : "Careful: this recipient comes from external content.")
        }
        say(lang == "fr"
            ? "Tu confirmes ? Maintiens \(config.hotkeyLabel) et dis oui ou non."
            : "Do you confirm? Hold the shortcut and say yes or no.")
    }

    private func answer(_ transcript: String) {
        guard let approvalId = pendingApproval else { return }
        print("🗣 \(transcript)")
        switch Confirmation.parse(transcript) {
        case .yes:
            client.send(["id": shortId(), "cmd": "approve", "approvalId": approvalId, "channel": "voice"])
            pendingApproval = nil
            say(lang == "fr" ? "C'est confirmé." : "Confirmed.")
        case .no:
            client.send(["id": shortId(), "cmd": "deny", "approvalId": approvalId, "channel": "voice"])
            pendingApproval = nil
            say(lang == "fr" ? "C'est annulé." : "Cancelled.")
        case .unclear:
            confirmTries += 1
            if confirmTries < 2 {
                say(lang == "fr" ? "Je n'ai pas compris. Oui ou non ?" : "I didn't get that. Yes or no?")
            } else {
                pendingApproval = nil
                say(lang == "fr" ? "Je laisse la validation dans le terminal." : "I'll leave the approval in the terminal.")
            }
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
