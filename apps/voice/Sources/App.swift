import AppKit
import Speech

@main
enum JarvisVoice {
    static var controller: Controller?

    static func main() {
        signal(SIGPIPE, SIG_IGN) // a restarting daemon must not kill the voice app
        setvbuf(stdout, nil, _IOLBF, 0)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // no Dock icon, no menu bar
        let config = VoiceConfig.load()
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--selftest") {
            SelfTest.run(config: config, files: Array(args[(i + 1)...]))
        } else {
            controller = Controller(config: config)
            controller?.start()
        }
        app.run()
    }
}

/// `jarvis voice selftest`: recognition on audio files (no microphone needed) and a spoken line
/// per language, with timings. Proves the whole local stack works without any download.
enum SelfTest {
    static var speaker: Speaker?

    static func run(config: VoiceConfig, files: [String]) {
        Permissions.request(microphone: false) { problem in
            if let problem {
                print("✖ \(problem)")
                exit(1)
            }
            recognize(files, index: 0) { speak(config) }
        }
    }

    static func recognize(_ files: [String], index: Int, then: @escaping () -> Void) {
        guard index < files.count else { return then() }
        let url = URL(fileURLWithPath: files[index])
        var candidates: [Candidate] = []
        let t0 = Date()
        let group = DispatchGroup()
        for (lang, locale) in Listener.languages {
            guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)), r.supportsOnDeviceRecognition else { continue }
            let request = SFSpeechURLRecognitionRequest(url: url)
            request.requiresOnDeviceRecognition = true
            request.addsPunctuation = true
            request.shouldReportPartialResults = false
            group.enter()
            var finished = false
            r.recognitionTask(with: request) { result, error in
                DispatchQueue.main.async {
                    guard !finished else { return }
                    if let result, result.isFinal {
                        let segs = result.bestTranscription.segments
                        let conf = segs.isEmpty ? 0 : segs.map(\.confidence).reduce(0, +) / Float(segs.count)
                        candidates.append(Candidate(lang: lang, text: result.bestTranscription.formattedString, confidence: conf))
                        finished = true
                        group.leave()
                    } else if let error {
                        let e = error as NSError
                        print("  \(lang) erreur \(e.domain) \(e.code) : \(e.localizedDescription)")
                        finished = true
                        group.leave()
                    }
                }
            }
        }
        group.notify(queue: .main) {
            let elapsed = ms(since: t0)
            for c in candidates {
                print("  \(c.lang) conf=\(String(format: "%.2f", c.confidence)) « \(c.text) »")
            }
            let pick = LanguagePick.choose(candidates, prefer: "fr")
            print("✔ \(url.lastPathComponent): [\(pick?.lang ?? "-")] « \(pick?.text ?? "") » en \(elapsed) ms (2 reconnaissances en parallèle)")
            recognize(files, index: index + 1, then: then)
        }
    }

    static func speak(_ config: VoiceConfig) {
        let s = Speaker(config: config)
        speaker = s
        let t0 = Date()
        var first = true
        s.onFirstAudio = {
            if first {
                print("✔ voix : premier son à \(ms(since: t0)) ms (\(s.voiceNames))")
                first = false
            }
        }
        s.onIdle = { exit(0) }
        s.speak("Bonjour Brightky, Jarvis est prêt.", lang: "fr")
        s.speak("Hello Brightky, Jarvis is ready.", lang: "en")
    }
}
