import AVFoundation
import CoreML
@preconcurrency import FluidAudio
import Foundation

/// `jarvis-app --voice-lab <dir> [reference.wav …]`: renders every catalog voice (or clones of the
/// given French references) to WAV, with time to first audio, speed and intelligibility measured
/// by Parakeet. Used to pick voices and to listen to them (`jarvis voice samples`).
enum VoiceLab {
    static let sentences = [
        "fr": "Bonjour. Tu as trois mails urgents, dont un de Paul sur le devis, et une réunion à quinze heures avec l'équipe produit. Je te les lis ?",
        "en": "Good morning. You have three urgent emails, including one from Paul about the quote, and a meeting at three in the afternoon with the product team. Shall I read them?",
    ]

    static func run(directory: String, references: [String]) {
        Task.detached {
            do {
                try await lab(directory: directory, references: references)
                exit(0)
            } catch {
                print("✖ \(error.localizedDescription)")
                exit(1)
            }
        }
    }

    /// `--voice-session <ref.wav>`: French latency with a warm session (voice prefilled once).
    static func session(_ reference: String) {
        Task.detached {
            do {
                let env = ProcessInfo.processInfo.environment
                func unit(_ k: String) -> MLComputeUnits? {
                    switch env[k] { case "cpu": .cpuOnly; case "gpu": .cpuAndGPU; case "ane": .cpuAndNeuralEngine; case "all": .all; default: nil }
                }
                let units = PocketTtsComputeUnits(conditioner: unit("COND"), flowLM: unit("FLOWLM"), flowDecoder: unit("FLOWDEC"))
                let precision: PocketTtsPrecision = env["PREC"] == "fp16" ? .fp16 : .int8
                let tl = Date()
                let placement: PocketTtsModelPlacement = env["PLACEMENT"] == "ane" ? .ane : .gpu
                let m = PocketTtsManager(language: .french24L, precision: precision, placement: placement, computeUnits: units)
                try await m.initialize()
                print("chargé en \(ms(since: tl)) ms (COND=\(env["COND"] ?? "-") FLOWLM=\(env["FLOWLM"] ?? "-") FLOWDEC=\(env["FLOWDEC"] ?? "-"))")
                let data = try await m.cloneVoice(from: URL(fileURLWithPath: reference))
                let full = "Bonjour Brightky. Tu as trois mails urgents, dont un de Paul sur le devis, et une réunion à quinze heures avec l'équipe produit. Je te les lis ?"
                for maxTokens in [50, 100, 160] {
                    let t = Date()
                    var first: Int?
                    var n = 0
                    for try await _ in try await m.synthesizeStreaming(text: full, voiceData: data, maxTokensPerChunk: maxTokens) {
                        if first == nil { first = ms(since: t) }
                        n += 1
                    }
                    let audio = Double(n) * 0.08, el = Date().timeIntervalSince(t)
                    print(String(format: "  bloc %3d jetons : 1er son %d ms · %.1f s d'audio en %.1f s (%.2f×)", maxTokens, first ?? -1, audio, el, audio / el))
                }
                if env["ONLYBLOCKS"] != nil { exit(0) }
                for round in 1...2 {
                    var t = Date()
                    let session = try await m.makeSession(voiceData: data)
                    print("session \(round) prête en \(ms(since: t)) ms")
                    let parts = ["Bonjour Brightky.", "Tu as trois mails urgents, dont un de Paul sur le devis.", "Je te les lis ?"]
                    t = Date()
                    for p in parts { session.enqueue(p) }
                    session.finish()
                    var first: Int?
                    var n = 0
                    var lastUtterance = -1
                    for try await frame in session.frames {
                        if first == nil { first = ms(since: t) }
                        if let u = frame.utteranceIndex, u != lastUtterance {
                            print("  phrase \(u) : 1re trame à \(ms(since: t)) ms (audio déjà produit \(n * 80) ms)")
                            lastUtterance = u
                        }
                        n += 1
                    }
                    let audio = Double(n) * 0.08
                    print(String(format: "  1er son %d ms · %.1f s d'audio en %.1f s (%.2f×)", first ?? -1, audio, Date().timeIntervalSince(t), audio / Date().timeIntervalSince(t)))
                }
                exit(0)
            } catch {
                print("✖ \(error.localizedDescription)")
                exit(1)
            }
        }
    }

    /// `--voice-screen <wav…>`: language and transcript of each clip (to find French speakers).
    static func screen(_ files: [String]) {
        Task.detached {
            do {
                let asr = AsrManager(config: .default)
                try await asr.loadModels(try await AsrModels.downloadAndLoad(version: .v3))
                for f in files {
                    var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
                    let text = (try? await asr.transcribe(URL(fileURLWithPath: f), decoderState: &state).text) ?? ""
                    let fr = LanguagePick.probability(of: "fr", in: text)
                    print(String(format: "%.2f\t%@\t%@", fr, (f as NSString).lastPathComponent, text))
                }
                exit(0)
            } catch {
                print("✖ \(error.localizedDescription)")
                exit(1)
            }
        }
    }

    private static func lab(directory: String, references: [String]) async throws {
        let out = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let t0 = Date()
        let models = try await AsrModels.downloadAndLoad(version: .v3)
        let asr = AsrManager(config: .default)
        try await asr.loadModels(models)
        print("Parakeet prêt en \(ms(since: t0)) ms")

        var managers: [String: PocketTtsManager] = [:]
        func manager(_ lang: String) async throws -> PocketTtsManager {
            if let m = managers[lang] { return m }
            let t = Date()
            let m = NeuralStack.makeManager(lang)
            try await m.initialize()
            print("PocketTTS \(lang) chargé en \(ms(since: t)) ms")
            managers[lang] = m
            return m
        }

        var jobs: [(name: String, lang: String, voice: String?, data: PocketTtsVoiceData?)] = []
        let only = references.count == 1 && ["fr", "en"].contains(references[0]) ? references[0] : nil
        if references.isEmpty || only != nil {
            for spec in NeuralVoiceSpec.catalog where only == nil || spec.lang == only {
                let m = try await manager(spec.lang)
                var data: PocketTtsVoiceData?
                if let ref = spec.reference { data = try await NeuralStack.clonedVoice(spec, reference: ref, manager: m) }
                jobs.append(("\(spec.lang)-\(spec.id)", spec.lang, spec.builtin, data))
            }
        } else {
            let m = try await manager("fr")
            for path in references {
                let t = Date()
                let data = try await m.cloneVoice(from: URL(fileURLWithPath: path))
                print("clone \(URL(fileURLWithPath: path).lastPathComponent) en \(ms(since: t)) ms")
                jobs.append(("fr-" + URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent, "fr", nil, data))
            }
        }

        print("voix                         1er son   vitesse   erreurs (Parakeet)")
        for job in jobs {
            let m = try await manager(job.lang)
            let text = sentences[job.lang] ?? ""
            let t = Date()
            var first: Int?
            var samples: [Float] = []
            let chunk = NeuralStack.maxTokensPerChunk
            let stream = if let data = job.data {
                try await m.synthesizeStreaming(text: text, voiceData: data, maxTokensPerChunk: chunk)
            } else {
                try await m.synthesizeStreaming(text: text, voice: job.voice, maxTokensPerChunk: chunk)
            }
            for try await frame in stream {
                if first == nil { first = ms(since: t) }
                samples += frame.samples
            }
            let elapsed = Date().timeIntervalSince(t)
            let seconds = Double(samples.count) / 24_000
            try writeWav(samples, to: out.appendingPathComponent("\(job.name).wav"))
            let heard = try await transcribe(asr, samples)
            let wer = WordErrorRate.of(reference: text, hypothesis: heard)
            print(String(format: "%-28@ %5d ms   %4.2f×    %4.1f %%   « %@ »", job.name as NSString, first ?? -1, seconds / elapsed, wer * 100, String(heard.prefix(70)) as NSString))
        }
    }

    private static func transcribe(_ asr: AsrManager, _ samples24k: [Float]) async throws -> String {
        // 24 kHz → 16 kHz for Parakeet.
        let n = Int(Double(samples24k.count) * 2 / 3)
        var resampled = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let x = Double(i) * 1.5
            let j = Int(x), f = Float(x - Double(j))
            let a = samples24k[min(j, samples24k.count - 1)], b = samples24k[min(j + 1, samples24k.count - 1)]
            resampled[i] = a + (b - a) * f
        }
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        return try await asr.transcribe(resampled, decoderState: &state).text
    }

    static func writeWav(_ samples: [Float], to url: URL) throws {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData?[0].update(from: $0.baseAddress!, count: samples.count) }
        let file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 24_000,
                                                               AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                                                               AVLinearPCMIsFloatKey: false])
        try file.write(from: buffer)
    }
}
