import Accelerate
import AVFoundation

/// Live levels (0…1) of the microphone and of Jarvis's own voice, for the island's bars. Written
/// from audio threads, read at display rate. Only a number is kept: never the audio.
final class AudioMeter: @unchecked Sendable {
    static let shared = AudioMeter()

    private let lock = NSLock()
    private var micLevel: Float = 0
    private var micAt: TimeInterval = 0
    private var outLevel: Float = 0
    private var outAt: TimeInterval = 0

    func mic(_ buffer: AVAudioPCMBuffer) {
        let l = Self.level(buffer)
        lock.withLock {
            micLevel = l
            micAt = ProcessInfo.processInfo.systemUptime
        }
    }

    func out(_ buffer: AVAudioPCMBuffer) {
        let l = Self.level(buffer)
        lock.withLock {
            outLevel = l
            outAt = ProcessInfo.processInfo.systemUptime
        }
    }

    /// Falls to 0 when no audio arrived for 0.3 s (microphone closed, voice finished).
    var mic: Float { lock.withLock { ProcessInfo.processInfo.systemUptime - micAt < 0.3 ? micLevel : 0 } }
    var out: Float { lock.withLock { ProcessInfo.processInfo.systemUptime - outAt < 0.3 ? outLevel : 0 } }

    /// RMS of the first channel, −55 dB → 0, −10 dB → 1.
    static func level(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var rms: Float = 0
        vDSP_rmsqv(ch, 1, &rms, vDSP_Length(buffer.frameLength))
        return level(rms: rms)
    }

    static func level(rms: Float) -> Float {
        let db = 20 * log10(max(rms, 1e-6))
        return min(max((db + 55) / 45, 0), 1)
    }
}
