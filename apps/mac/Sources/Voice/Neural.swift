import AVFoundation
@preconcurrency import FluidAudio
import Foundation

/// A voice Jarvis can speak with: a PocketTTS built-in, or a clone of a freely licensed recording
/// shipped in the app (Resources/voices, see voices/CREDITS.md).
struct NeuralVoiceSpec: Equatable {
    let id: String
    let lang: String // "fr" | "en"
    let label: String
    let male: Bool
    /// PocketTTS built-in voice name, or nil for a clone.
    let builtin: String?
    /// Reference clip in Resources/voices for clones.
    let reference: String?

    static let catalog: [NeuralVoiceSpec] = VoiceCatalog.all

    static func find(_ id: String, lang: String) -> NeuralVoiceSpec? {
        catalog.first { $0.id == id && $0.lang == lang } ?? catalog.first { $0.lang == lang && $0.id == VoiceCatalog.defaults[lang] }
    }
}

/// The loaded neural models, shared by the listener and the speaker. Loading compiles the CoreML
/// models on first use (minutes, once per machine); until then the system voices are used.
final class NeuralStack: @unchecked Sendable {
    let asr: AsrManager
    let tts: [String: PocketTtsManager]
    let voices: [String: (spec: NeuralVoiceSpec, data: PocketTtsVoiceData?)]

    private init(asr: AsrManager, tts: [String: PocketTtsManager], voices: [String: (spec: NeuralVoiceSpec, data: PocketTtsVoiceData?)]) {
        self.asr = asr
        self.tts = tts
        self.voices = voices
    }

    /// Where cloned voices are kept (one small .bin per voice, ~0.5 MB).
    static var voicesDir: URL {
        let env = ProcessInfo.processInfo.environment
        let root = env["JARVIS_HOME"] ?? (NSHomeDirectory() + "/Library/Application Support/Jarvis")
        return URL(fileURLWithPath: root + "/voices", isDirectory: true)
    }

    static func referenceURL(_ name: String) -> URL? {
        if let url = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "voices") { return url }
        // `swift run` / tests: next to the sources.
        let dev = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Resources/voices/\(name)")
        return FileManager.default.fileExists(atPath: dev.path) ? dev : nil
    }

    /// Measured on the M1 Pro: the French pack (24 layers) pays ~0.6 s of prefill per text block,
    /// so blocks are long (one call per reply when possible) and it runs on the GPU (1.2× real time);
    /// English (6 layers) keeps the default routing (2.8× real time, ~100 ms to first sound).
    static let maxTokensPerChunk = 100

    static func makeManager(_ lang: String) -> PocketTtsManager {
        lang == "fr"
            ? PocketTtsManager(language: .french24L, precision: .int8,
                               computeUnits: PocketTtsComputeUnits(conditioner: .cpuAndGPU, flowLM: .cpuAndGPU))
            : PocketTtsManager(language: .english, precision: .fp16)
    }

    static func load(fr: String, en: String, log: @escaping (String) -> Void) async throws -> NeuralStack {
        let t0 = Date()
        let models = try await AsrModels.downloadAndLoad(version: .v3)
        let asr = AsrManager(config: .default)
        try await asr.loadModels(models)
        log("reconnaissance Parakeet v3 prête (\(ms(since: t0)) ms)")

        var tts: [String: PocketTtsManager] = [:]
        var voices: [String: (spec: NeuralVoiceSpec, data: PocketTtsVoiceData?)] = [:]
        for (lang, wanted) in [("fr", fr), ("en", en)] {
            guard let spec = NeuralVoiceSpec.find(wanted, lang: lang) else { continue }
            let t1 = Date()
            let manager = makeManager(lang)
            try await manager.initialize()
            var data: PocketTtsVoiceData?
            if let ref = spec.reference {
                data = try await clonedVoice(spec, reference: ref, manager: manager)
            }
            // One silent synthesis: the first real reply then skips the GPU/ANE warm-up.
            let warm = lang == "fr" ? "D'accord." : "All right."
            let warmStream = if let data {
                try await manager.synthesizeStreaming(text: warm, voiceData: data)
            } else {
                try await manager.synthesizeStreaming(text: warm, voice: spec.builtin)
            }
            for try await _ in warmStream {}
            tts[lang] = manager
            voices[lang] = (spec, data)
            log("voix \(lang) « \(spec.label) » prête (\(ms(since: t1)) ms)")
        }
        return NeuralStack(asr: asr, tts: tts, voices: voices)
    }

    /// Clones once from the shipped reference, then reuses the saved conditioning.
    static func clonedVoice(_ spec: NeuralVoiceSpec, reference: String, manager: PocketTtsManager) async throws -> PocketTtsVoiceData {
        let saved = voicesDir.appendingPathComponent("\(spec.lang).\(spec.id).bin")
        if FileManager.default.fileExists(atPath: saved.path) {
            return try manager.loadClonedVoice(from: saved)
        }
        guard let ref = referenceURL(reference) else {
            throw NSError(domain: "jarvis.voice", code: 2, userInfo: [NSLocalizedDescriptionKey: "extrait de voix manquant : \(reference)"])
        }
        try FileManager.default.createDirectory(at: voicesDir, withIntermediateDirectories: true)
        let data = try await manager.cloneVoice(from: ref)
        try manager.saveClonedVoice(data, to: saved)
        return data
    }
}

/// Parakeet TDT v3 on CoreML: one pass recognises French or English (25 languages), entirely on
/// the Mac. Audio is kept in memory while the key is held, then transcribed on release.
final class NeuralListener: SpeechInput {
    let engineName = "Parakeet v3 (local)"
    private let engine = AVAudioEngine()
    private let asr: AsrManager
    private let lock = NSLock()
    private var samples: [Float] = []
    private var partialTimer: Timer?
    private var partialBusy = false
    private var prefer = "fr"
    var onPartial: ((String) -> Void)?

    static let sampleRate = 16_000.0

    init(asr: AsrManager) {
        self.asr = asr
    }

    func start(prefer: String) throws {
        cancel()
        self.prefer = prefer
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inFormat, to: target)
        else {
            throw NSError(domain: "jarvis.voice", code: 3, userInfo: [NSLocalizedDescriptionKey: "format micro non pris en charge"])
        }
        lock.withLock { samples.removeAll(keepingCapacity: true) }
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            guard let self else { return }
            AudioMeter.shared.mic(buffer)
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Self.sampleRate / inFormat.sampleRate + 64)
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var fed = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if fed {
                    status.pointee = .noDataNow
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            guard let channel = out.floatChannelData?[0], out.frameLength > 0 else { return }
            let chunk = Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
            self.lock.withLock { self.samples.append(contentsOf: chunk) }
        }
        engine.prepare()
        try engine.start()
        partialTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.partial() }
    }

    private func partial() {
        guard !partialBusy, let onPartial else { return }
        let audio = lock.withLock { samples }
        guard audio.count > Int(Self.sampleRate) else { return }
        partialBusy = true
        let asr = self.asr, prefer = self.prefer
        Task.detached {
            let c = try? await Self.transcribe(asr, audio, prefer: prefer)
            await MainActor.run {
                self.partialBusy = false
                if let c, self.partialTimer != nil { onPartial(c.text) }
            }
        }
    }

    func finish(timeout: TimeInterval, completion: @escaping ([Candidate]) -> Void) {
        stopAudio()
        let audio = lock.withLock { samples }
        guard audio.count > Int(Self.sampleRate * 0.25) else { return completion([]) }
        let asr = self.asr, prefer = self.prefer
        Task.detached {
            let c = try? await Self.transcribe(asr, audio, prefer: prefer)
            await MainActor.run { completion(c.map { [$0] } ?? []) }
        }
    }

    static func transcribe(_ asr: AsrManager, _ audio: [Float], prefer: String) async throws -> Candidate {
        var padded = audio
        // Very short answers ("oui") decode better with a little silence around them.
        let minimum = Int(sampleRate * 1.2)
        if padded.count < minimum { padded += [Float](repeating: 0, count: minimum - padded.count) }
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let r = try await asr.transcribe(padded, decoderState: &state)
        let text = r.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return Candidate(lang: LanguagePick.replyLanguage(text, hint: prefer), text: text, confidence: r.confidence)
    }

    func cancel() {
        stopAudio()
        lock.withLock { samples.removeAll() }
    }

    private func stopAudio() {
        partialTimer?.invalidate()
        partialTimer = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }
}

/// PocketTTS on CoreML, streamed: each sentence is synthesised in 80 ms frames that are played as
/// soon as they exist, while the next sentence is already being generated. Main thread only.
final class NeuralSpeaker: SpeechOutput, @unchecked Sendable {
    private let stack: NeuralStack
    private let fallback: SpeechOutput
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// Speeds speech up without changing the voice's pitch.
    private let timePitch = AVAudioUnitTimePitch()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    private var queue: [(text: String, lang: String)] = []
    private var worker: Task<Void, Never>?
    private var generation = 0
    private var pendingBuffers = 0
    private var started = false
    /// Frames held back before playback starts, so a slow generator never makes a gap: French
    /// (24 layers, 1.2× real time) needs a cushion, English (2.8×) hardly any.
    private var preroll: [AVAudioPCMBuffer] = []
    private var prerollFrames = 3
    static let prerollByLang = ["fr": 3, "en": 1]
    var onFirstAudio: () -> Void = {}
    var onIdle: () -> Void = {}
    private let rate: Float

    init(stack: NeuralStack, fallback: SpeechOutput, rate: Float, speed: Float = 1) {
        self.stack = stack
        self.fallback = fallback
        self.rate = rate
        engine.attach(player)
        engine.attach(timePitch)
        timePitch.rate = speed
        engine.connect(player, to: timePitch, format: format)
        engine.connect(timePitch, to: engine.mainMixerNode, format: format)
        // Tests run silently on Brightky's Mac.
        if ProcessInfo.processInfo.environment["JARVIS_MUTE"] == "1" { engine.mainMixerNode.outputVolume = 0 }
        // The island's bars follow Jarvis's real voice.
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in AudioMeter.shared.out(buffer) }
        // Started once: starting the output on the first sentence cost ~200 ms of latency.
        engine.prepare()
        try? engine.start()
    }

    var busy: Bool { worker != nil || !queue.isEmpty || pendingBuffers > 0 || !preroll.isEmpty || fallback.busy }

    var voiceNames: String {
        stack.voices.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value.spec.label)" }.joined(separator: ", ")
    }

    func speak(_ text: String, lang: String) {
        guard !text.isEmpty else { return }
        queue.append((text, lang))
        pump()
    }

    func stop() {
        generation += 1
        queue.removeAll()
        worker?.cancel()
        worker = nil
        preroll.removeAll()
        player.stop()
        pendingBuffers = 0
        started = false
        fallback.stop()
    }

    private func pump() {
        guard worker == nil, !queue.isEmpty else { return checkIdle() }
        var item = queue.removeFirst()
        // Sentences that arrived while the previous block was generated share one call: each call
        // pays a fixed prefill, so one block per reply keeps French ahead of real time.
        while let next = queue.first, next.lang == item.lang, item.text.count + next.text.count < 360 {
            item.text += " " + next.text
            queue.removeFirst()
        }
        guard let manager = stack.tts[item.lang], let voice = stack.voices[item.lang] else {
            // No neural voice for this language: the system voice says it.
            fallback.onIdle = { [weak self] in self?.pump() }
            fallback.speak(item.text, lang: item.lang)
            return
        }
        let gen = generation
        prerollFrames = Self.prerollByLang[item.lang] ?? 3
        let text = SpokenText.prepare(item.text, lang: item.lang)
        let speaker = WeakBox(self)
        worker = Task.detached {
            do {
                let chunk = NeuralStack.maxTokensPerChunk
                let stream = if let data = voice.data {
                    try await manager.synthesizeStreaming(text: text, voiceData: data, maxTokensPerChunk: chunk)
                } else {
                    try await manager.synthesizeStreaming(text: text, voice: voice.spec.builtin, maxTokensPerChunk: chunk)
                }
                for try await frame in stream {
                    if Task.isCancelled { break }
                    let samples = frame.samples
                    await MainActor.run { speaker.value?.enqueue(samples, gen: gen) }
                }
            } catch {
                print("⚠ synthèse : \(error.localizedDescription)")
            }
            await MainActor.run {
                guard let speaker = speaker.value, gen == speaker.generation else { return }
                speaker.flushPreroll()
                speaker.worker = nil
                speaker.pump()
            }
        }
    }

    private func enqueue(_ samples: [Float], gen: Int) {
        guard gen == generation, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            buffer.floatChannelData?[0].update(from: src.baseAddress!, count: samples.count)
        }
        if !started && preroll.count < prerollFrames {
            preroll.append(buffer)
            if preroll.count == prerollFrames { flushPreroll() }
            return
        }
        schedule(buffer, gen: gen)
    }

    private func flushPreroll() {
        let held = preroll
        preroll.removeAll()
        for b in held { schedule(b, gen: generation) }
    }

    private func schedule(_ buffer: AVAudioPCMBuffer, gen: Int) {
        if !engine.isRunning {
            engine.prepare()
            try? engine.start()
        }
        pendingBuffers += 1
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                self.pendingBuffers -= 1
                self.checkIdle()
            }
        }
        if !started {
            started = true
            player.rate = 1
            player.play()
            onFirstAudio()
        }
    }

    private func checkIdle() {
        guard worker == nil, queue.isEmpty, pendingBuffers == 0, preroll.isEmpty else { return }
        if started {
            started = false
            player.stop()
            onIdle()
        }
    }
}

/// Lets a detached task refer to the speaker without keeping it alive.
final class WeakBox<T: AnyObject>: @unchecked Sendable {
    weak var value: T?
    init(_ value: T) { self.value = value }
}
