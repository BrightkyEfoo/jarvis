import Foundation

/// What the voice loop needs from a recogniser. Apple's on-device recogniser (`Listener`) is the
/// fallback; the neural one (`NeuralListener`, Parakeet) takes over once its models are loaded.
protocol SpeechInput: AnyObject {
    var onPartial: ((String) -> Void)? { get set }
    var engineName: String { get }
    func start(prefer: String) throws
    func finish(timeout: TimeInterval, completion: @escaping ([Candidate]) -> Void)
    func cancel()
}

/// What the voice loop needs from a synthesiser. `Speaker` (system voices) is the fallback;
/// `NeuralSpeaker` (PocketTTS) takes over once its models are loaded.
protocol SpeechOutput: AnyObject {
    var onFirstAudio: () -> Void { get set }
    var onIdle: () -> Void { get set }
    var busy: Bool { get }
    var voiceNames: String { get }
    func speak(_ text: String, lang: String)
    func stop()
}

extension SpeechInput {
    func finish(completion: @escaping ([Candidate]) -> Void) { finish(timeout: 1.5, completion: completion) }
}
