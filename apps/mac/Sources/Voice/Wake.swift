import AVFoundation
@preconcurrency import FluidAudio
import Foundation

/// Hands-free: the microphone stays open, Silero VAD cuts speech into utterances, Parakeet reads
/// each one, and only those starting with "Jarvis" (or following it) reach the brain. Everything
/// runs on the Mac; nothing is recorded to disk.
final class WakeWatcher: @unchecked Sendable {
    private let asr: AsrManager
    private let vad: VadManager
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "cm.brightkyefoo.jarvis.wake")
    private var state: VadStreamState
    private var pending: [Float] = []
    private var segment: [Float] = []
    private var preroll: [Float] = []
    private var inSpeech = false
    private var armedUntil = Date.distantPast
    private(set) var running = false
    /// Set by the voice loop while Jarvis listens (push-to-talk), thinks or speaks: it must not hear itself.
    var suspended = false {
        didSet { if suspended { queue.async { self.reset() } } }
    }
    /// A command (wake word removed) and the language it was said in.
    var onCommand: (String, String) -> Void = { _, _ in }
    /// "Jarvis" alone: the next utterance is the command.
    var onArmed: () -> Void = {}
    var prefer = "fr"
    /// Diagnostics only (`--wake-test`): every utterance heard, wake word or not.
    var onHeard: ((String, Int) -> Void)?

    static let chunk = 4096 // 256 ms at 16 kHz, Silero's native hop
    static let sampleRate = 16_000.0

    private init(asr: AsrManager, vad: VadManager) {
        self.asr = asr
        self.vad = vad
        state = VadStreamState.initial()
    }

    static func make(asr: AsrManager) async throws -> WakeWatcher {
        let vad = try await VadManager(config: VadConfig(defaultThreshold: 0.6))
        return WakeWatcher(asr: asr, vad: vad)
    }

    /// The next utterance counts as a command without the wake word (e.g. a spoken "oui/non").
    func arm(for seconds: TimeInterval) {
        queue.async { self.armedUntil = Date().addingTimeInterval(seconds) }
    }

    func start() throws {
        guard !running else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: format, to: target) else {
            throw NSError(domain: "jarvis.wake", code: 1, userInfo: [NSLocalizedDescriptionKey: "format micro non pris en charge"])
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Self.sampleRate / format.sampleRate + 64)
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
            guard let ch = out.floatChannelData?[0], out.frameLength > 0 else { return }
            let samples = Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
            self.queue.async { self.ingest(samples) }
        }
        engine.prepare()
        try engine.start()
        running = true
    }

    /// Tests and `--wake-test`: push 16 kHz samples as if they came from the microphone.
    func feed(_ samples: [Float]) {
        queue.async { self.ingest(samples) }
    }

    /// Waits until everything fed so far has been processed.
    func drain() {
        queue.sync {}
    }

    func stop() {
        guard running else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        running = false
        queue.async { self.reset() }
    }

    private func reset() {
        pending.removeAll()
        segment.removeAll()
        preroll.removeAll()
        inSpeech = false
        state = VadStreamState.initial()
    }

    /// Runs on `queue`: VAD per 256 ms hop, utterance boundaries, then transcription.
    private func ingest(_ samples: [Float]) {
        if suspended { return }
        pending += samples
        while pending.count >= Self.chunk {
            let hop = Array(pending.prefix(Self.chunk))
            pending.removeFirst(Self.chunk)
            let sem = DispatchSemaphore(value: 0)
            var result: VadStreamResult?
            let vad = self.vad, st = state
            let config = VadSegmentationConfig(minSpeechDuration: 0.2, minSilenceDuration: 0.6, maxSpeechDuration: 12, speechPadding: 0.1)
            Task.detached {
                result = try? await vad.processStreamingChunk(hop, state: st, config: config)
                sem.signal()
            }
            sem.wait()
            guard let r = result else { continue }
            state = r.state
            if inSpeech || r.event?.isStart == true {
                if !inSpeech {
                    inSpeech = true
                    segment = preroll // keep the start of the first word
                }
                segment += hop
            } else {
                preroll = Array((preroll + hop).suffix(Int(Self.sampleRate * 0.5)))
            }
            if inSpeech, r.event?.isEnd == true || segment.count > Int(Self.sampleRate * 14) {
                let utterance = segment
                inSpeech = false
                segment.removeAll()
                preroll.removeAll()
                transcribe(utterance)
            }
        }
    }

    private func transcribe(_ audio: [Float]) {
        onHeard?("(segment \(audio.count * 1000 / Int(Self.sampleRate)) ms)", audio.count)
        guard audio.count > Int(Self.sampleRate * 0.4) else { return }
        let asr = self.asr, prefer = self.prefer
        let armed = Date() < armedUntil
        let sem = DispatchSemaphore(value: 0)
        var heard: Candidate?
        Task.detached {
            heard = try? await NeuralListener.transcribe(asr, audio, prefer: prefer)
            sem.signal()
        }
        sem.wait()
        onHeard?(heard?.text ?? "∅", audio.count)
        guard let heard, !heard.text.isEmpty, !suspended else { return }
        switch WakeWord.match(heard.text) {
        case .command(let rest):
            armedUntil = .distantPast
            let lang = LanguagePick.replyLanguage(rest, hint: heard.lang)
            DispatchQueue.main.async { self.onCommand(rest, lang) }
        case .alone:
            armedUntil = Date().addingTimeInterval(8)
            DispatchQueue.main.async { self.onArmed() }
        case .none where armed:
            armedUntil = .distantPast
            DispatchQueue.main.async { self.onCommand(heard.text, heard.lang) }
        case .none:
            break // conversation in the room, TV…: ignored, nothing kept
        }
    }
}
