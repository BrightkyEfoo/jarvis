import AVFoundation
import Speech

/// Microphone → two on-device recognizers (fr-FR and en-US) fed with the same audio.
/// `requiresOnDeviceRecognition`: no audio leaves the Mac, no mobile data is used.
final class Listener {
    final class Session {
        let lang: String
        let recognizer: SFSpeechRecognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        var task: SFSpeechRecognitionTask?
        var latest: SFSpeechRecognitionResult?
        var done = false

        init?(lang: String, locale: String) {
            guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)), r.supportsOnDeviceRecognition else {
                return nil
            }
            self.lang = lang
            recognizer = r
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            request.taskHint = .dictation
        }

        var candidate: Candidate {
            let t = latest?.bestTranscription
            let segments = t?.segments ?? []
            let confidence = segments.isEmpty ? 0 : segments.map(\.confidence).reduce(0, +) / Float(segments.count)
            return Candidate(lang: lang, text: t?.formattedString ?? "", confidence: confidence)
        }
    }

    static let languages = [("fr", "fr-FR"), ("en", "en-US")]

    private let engine = AVAudioEngine()
    private var sessions: [Session] = []
    /// Live transcript of the preferred language, for on-screen feedback.
    var onPartial: ((String) -> Void)?

    func start(prefer: String) throws {
        cancel()
        sessions = Self.languages.compactMap { Session(lang: $0.0, locale: $0.1) }
        guard !sessions.isEmpty else { throw NSError(domain: "jarvis.voice", code: 1, userInfo: [NSLocalizedDescriptionKey: "no on-device recognizer available"]) }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let targets = sessions
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            for s in targets { s.request.append(buffer) }
        }
        for s in sessions {
            s.task = s.recognizer.recognitionTask(with: s.request) { [weak self] result, error in
                DispatchQueue.main.async {
                    if let result {
                        s.latest = result
                        if result.isFinal { s.done = true }
                        if s.lang == prefer { self?.onPartial?(result.bestTranscription.formattedString) }
                    }
                    if let error {
                        // Cancelled tasks after a barge-in are expected; anything else is worth seeing.
                        let e = error as NSError
                        if !s.done, e.code != 216, e.code != 301 { print("\n⚠ reconnaissance \(s.lang) : \(e.domain) \(e.code) \(e.localizedDescription)") }
                        s.done = true
                    }
                }
            }
        }
        engine.prepare()
        try engine.start()
    }

    /// Stops the microphone and waits (bounded) for both final readings.
    func finish(timeout: TimeInterval = 1.5, completion: @escaping ([Candidate]) -> Void) {
        stopAudio()
        for s in sessions { s.request.endAudio() }
        let deadline = Date().addingTimeInterval(timeout)
        let pending = sessions
        func poll() {
            if pending.allSatisfy(\.done) || Date() > deadline {
                completion(pending.map(\.candidate))
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01, execute: poll)
            }
        }
        poll()
    }

    /// Loads both on-device models before the first real request: the very first French
    /// recognition after launch was seen to fail cold. Uses a clip made by `say` (no microphone).
    static func warmUp(done: @escaping (Int) -> Void) {
        let url = URL(fileURLWithPath: NSTemporaryDirectory() + "jarvis-warmup.aiff")
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-v", "Thomas", "-o", url.path, "Bonjour Jarvis"]
        let t0 = Date()
        say.terminationHandler = { _ in
            DispatchQueue.main.async {
                let group = DispatchGroup()
                for (_, locale) in languages {
                    guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)), r.supportsOnDeviceRecognition else { continue }
                    let request = SFSpeechURLRecognitionRequest(url: url)
                    request.requiresOnDeviceRecognition = true
                    group.enter()
                    var left = false
                    r.recognitionTask(with: request) { result, error in
                        DispatchQueue.main.async {
                            if !left, error != nil || result?.isFinal == true {
                                left = true
                                group.leave()
                            }
                        }
                    }
                }
                group.notify(queue: .main) { done(ms(since: t0)) }
            }
        }
        do { try say.run() } catch { done(-1) }
    }

    func cancel() {
        stopAudio()
        for s in sessions { s.task?.cancel() }
        sessions = []
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }
}
