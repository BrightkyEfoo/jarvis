import AppKit
import Combine
import Carbon.HIToolbox
@preconcurrency import FluidAudio
import Speech
import SwiftUI

/// Jarvis.app: menu bar icon + dashboard window + push-to-talk voice, one process, one identity
/// for the Microphone / Speech permissions.
@main
struct JarvisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuView().environmentObject(delegate.store)
        } label: {
            StatusIcon(store: delegate.store) { delegate.openWindow = $0 }
        }
        .menuBarExtraStyle(.window)

        Window("Jarvis", id: "dashboard") {
            DashboardView().environmentObject(delegate.store)
        }
        .defaultSize(width: 1180, height: 760)
        .defaultLaunchBehavior(.suppressed)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let config = VoiceConfig.load()
    lazy var store = Store(socketPath: config.socketPath)
    var controller: Controller?
    var actuator: Actuator?
    var stopKey: HotKey?
    var island: IslandController?
    private var bag: Set<AnyCancellable> = []
    /// Windows already announced as nearly full (said once, again after they come back under 70 %).
    private var quotaSaid: Set<String> = []
    var openWindow: OpenWindowAction?
    private var pendingDashboard = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN) // a restarting daemon must not kill the app
        setvbuf(stdout, nil, _IOLBF, 0)
        NSApp.setActivationPolicy(.accessory)
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--neural-selftest") {
            SelfTest.neural(config: config, files: Array(args[(i + 1)...]))
            return
        }
        if let i = args.firstIndex(of: "--selftest") {
            SelfTest.run(config: config, files: Array(args[(i + 1)...]))
            return
        }
        if let i = args.firstIndex(of: "--voice-session"), i + 1 < args.count {
            VoiceLab.session(args[i + 1])
            return
        }
        if let i = args.firstIndex(of: "--wake-test") {
            VoiceLab.wakeTest(Array(args[(i + 1)...]))
            return
        }
        if let i = args.firstIndex(of: "--voice-screen") {
            VoiceLab.screen(Array(args[(i + 1)...]))
            return
        }
        if let i = args.firstIndex(of: "--voice-lab"), i + 1 < args.count {
            VoiceLab.run(directory: args[i + 1], references: Array(args[(i + 2)...]))
            return
        }
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            Snapshotter.run(directory: args[i + 1])
            return
        }
        store.start()
        startHands(enabled: !args.contains("--no-actuator"))
        if config.island {
            island = IslandController(store: store) { [weak self] in
                self?.actuator?.cancelAll()
                self?.store.stop(from: "île Jarvis")
            }
        }
        if !args.contains("--no-voice") {
            let c = Controller(config: config)
            c.onState = { [weak self] s in self?.store.voice = Store.VoiceState(rawValue: s) ?? .idle }
            c.onEngine = { [weak self] e in self?.store.voiceEngine = e }
            c.onHeard = { [weak self] t in self?.store.heard = t }
            c.onSaid = { [weak self] t in self?.store.said = t }
            c.start()
            controller = c
        }
        store.$quota
            .receive(on: RunLoop.main)
            .sink { [weak self] q in self?.announceQuota(q) }
            .store(in: &bag)
        if args.contains("--dashboard") { openDashboard() }
    }

    /// Computer control (browser, Notes, Reminders, any app) and its emergency brake: ⌃⎋ cancels
    /// what the hands are doing and engages STOP in the daemon, from anywhere.
    private func startHands(enabled: Bool) {
        if enabled {
            let a = Actuator(socketPath: config.socketPath)
            a.onActing = { [weak self] app in self?.store.acting = app }
            a.onConnection = { [weak self] ok in self?.store.actuatorConnected = ok }
            a.start()
            actuator = a
        }
        stopKey = HotKey(keyCode: UInt32(kVK_Escape), modifiers: UInt32(controlKey), id: 2)
        stopKey?.onPress = { [weak self] in
            self?.actuator?.cancelAll()
            self?.store.stop(from: "⌃⎋")
        }
    }

    /// The subscription is the scarce resource: say it once when a window passes 85 %.
    private func announceQuota(_ windows: [QuotaWindow]) {
        for w in windows where w.window == "five_hour" || w.window == "seven_day" {
            guard let u = w.utilization else { continue }
            if u >= 0.85, !quotaSaid.contains(w.window) {
                quotaSaid.insert(w.window)
                let pct = Int(u * 100)
                controller?.announce(w.window == "five_hour"
                    ? "Attention : quota de cinq heures à \(pct) pour cent. Les workers attendent, je garde le reste pour toi."
                    : "Attention : quota de la semaine à \(pct) pour cent.")
            } else if u < 0.7 {
                quotaSaid.remove(w.window)
            }
        }
    }

    /// `open jarvis://dashboard` (used by `jarvis dashboard`).
    func application(_ application: NSApplication, open urls: [URL]) {
        if urls.contains(where: { $0.host == "dashboard" }) { openDashboard() }
    }

    func openDashboard() {
        guard let openWindow else {
            // The menu bar label has not appeared yet: retry shortly.
            if !pendingDashboard {
                pendingDashboard = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    self?.pendingDashboard = false
                    self?.openDashboard()
                }
            }
            return
        }
        openWindow(id: "dashboard")
        DashboardWindow.bringFront()
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

    /// `jarvis voice selftest` with the neural stack: Parakeet on the given clips, then one French
    /// and one English reply through the streaming speaker, with timings.
    static var neuralSpeaker: NeuralSpeaker?

    static func neural(config: VoiceConfig, files: [String]) {
        Task.detached {
            do {
                let t0 = Date()
                let stack = try await NeuralStack.load(fr: config.frNeural, en: config.enNeural) { print("  \($0)") }
                print("✔ modèles neuronaux chargés en \(ms(since: t0)) ms")
                for f in files {
                    let t = Date()
                    var state = TdtDecoderState.make(decoderLayers: await stack.asr.decoderLayerCount)
                    let r = try await stack.asr.transcribe(URL(fileURLWithPath: f), decoderState: &state)
                    let lang = LanguagePick.replyLanguage(r.text, hint: "fr")
                    print("✔ \((f as NSString).lastPathComponent) : [\(lang)] « \(r.text) » en \(ms(since: t)) ms")
                }
                await MainActor.run { speakNeural(stack, config: config) }
            } catch {
                print("✖ \(error.localizedDescription)")
                exit(1)
            }
        }
    }

    @MainActor static func speakNeural(_ stack: NeuralStack, config: VoiceConfig) {
        let s = NeuralSpeaker(stack: stack, fallback: Speaker(config: config), rate: config.rate, speed: config.speed)
        neuralSpeaker = s
        var t0 = Date()
        var lines = [("Bonjour Brightky. Tu as deux réunions cet après-midi, et Paul attend ta réponse sur le devis.", "fr"),
                     ("Hello Brightky. Your build passed, and the pull request is ready for review.", "en"),
                     ("Two meetings left today.", "en"),
                     ("C'est noté, je m'en occupe.", "fr")]
        func next() {
            guard !lines.isEmpty else { exit(0) }
            let (text, lang) = lines.removeFirst()
            t0 = Date()
            var first = true
            s.onFirstAudio = {
                if first { print("✔ voix \(lang) (\(stack.voices[lang]?.spec.label ?? "?")) : premier son à \(ms(since: t0)) ms"); first = false }
            }
            s.onIdle = { print("  fin à \(ms(since: t0)) ms"); next() }
            s.speak(text, lang: lang)
        }
        next()
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
